const crypto = require('crypto')
const pino = require('pino')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function toUnixNano(value) {
  return `${BigInt(toDate(value).getTime()) * 1000000n}`
}

function safeJson(value) {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function sanitizeSegment(segment) {
  return String(segment || '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 120) || 'value'
}

function otelValue(value) {
  if (value == null) return undefined
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { intValue: String(value) }
    return { doubleValue: value }
  }
  if (Array.isArray(value)) {
    const values = value.map(otelValue).filter(Boolean)
    return { arrayValue: { values } }
  }
  if (typeof value === 'object') return { stringValue: safeJson(value) }
  return { stringValue: String(value) }
}

function addAttr(attributes, key, value) {
  const otel = otelValue(value)
  if (!otel) return
  attributes.push({ key, value: otel })
}

function addJsonAttr(attributes, key, value) {
  if (value == null) return
  addAttr(attributes, key, safeJson(value))
}

function addMetadata(attributes, prefix, metadata = {}) {
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value == null) continue
    const mappedValue = typeof value === 'object' ? safeJson(value) : value
    addAttr(attributes, `${prefix}.${sanitizeSegment(key)}`, mappedValue)
  }
}

function normalizeEndpoint(baseUrl) {
  const base = String(baseUrl || 'http://localhost:3000').replace(/\/+$/, '')
  if (/\/api\/public\/otel(?:\/v1\/traces)?$/.test(base)) {
    return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`
  }
  return `${base}/api/public/otel/v1/traces`
}

class OtelLangfuseObservation {
  constructor(client, type, params = {}) {
    this.client = client
    this.type = type
    this.id = type === 'trace' ? (params.traceId || randomHex(16)) : (params.id || randomHex(8))
    this.spanId = type === 'trace' ? (params.spanId || randomHex(8)) : this.id
    this.traceId = type === 'trace' ? this.id : params.traceId
    this.parentObservationId = params.parentObservationId
    this.params = { ...params }
    this.createdAt = params.startTime || new Date()
    this.updatedAt = new Date()
    this.dirty = true
    this.exported = false
  }

  update(params = {}) {
    this.params = {
      ...this.params,
      ...params,
      metadata: {
        ...(this.params.metadata || {}),
        ...(params.metadata || {}),
      },
    }
    this.updatedAt = new Date()
    this.dirty = true
  }

  end(params = {}) {
    this.update({
      ...params,
      endTime: params.endTime || new Date(),
    })
  }

  isReady() {
    if (this.type === 'trace') return true
    if (this.type === 'event') return true
    if (this.type === 'generation') {
      return this.params.output !== undefined || this.params.endTime !== undefined
    }
    return true
  }
}

class OtelLangfuse {
  constructor(options = {}) {
    this.publicKey = options.publicKey || ''
    this.secretKey = options.secretKey || ''
    this.baseUrl = options.baseUrl || 'http://localhost:3000'
    this.endpoint = options.endpoint || normalizeEndpoint(this.baseUrl)
    this.fetchImpl = options.fetch || global.fetch
    this.flushAt = options.flushAt || 20
    this.resourceAttributes = options.resourceAttributes || {}
    this.traces = new Map()
    this.observations = new Map()
    this.listeners = {}
  }

  on(event, handler) {
    this.listeners[event] = handler
  }

  emitError(error) {
    if (this.listeners.error) this.listeners.error(error)
  }

  trace(params = {}) {
    const observation = new OtelLangfuseObservation(this, 'trace', params)
    this.traces.set(observation.id, observation)
    this.observations.set(observation.spanId, observation)
    return observation
  }

  generation(params = {}) {
    const observation = new OtelLangfuseObservation(this, 'generation', params)
    this.observations.set(observation.id, observation)
    return observation
  }

  event(params = {}) {
    const observation = new OtelLangfuseObservation(this, 'event', params)
    this.observations.set(observation.id, observation)
    return observation
  }

  async score(params = {}) {
    if (!params.name) return
    const url = `${String(this.baseUrl).replace(/\/+$/, '')}/api/public/scores`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        traceId: params.traceId,
        sessionId: params.sessionId,
        observationId: params.observationId,
        name: params.name,
        value: params.value,
        comment: params.comment,
        dataType: params.dataType || 'NUMERIC',
      }),
    })

    if (!response.ok) {
      throw new Error(`Langfuse score export failed: HTTP ${response.status}`)
    }
  }

  basicAuthHeader() {
    return `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64')}`
  }

  rootFor(traceId) {
    return this.traces.get(traceId)
  }

  parentSpanId(observation) {
    if (observation.type === 'trace') return undefined
    if (observation.parentObservationId) return observation.parentObservationId
    return this.rootFor(observation.traceId)?.spanId
  }

  commonTraceAttrs(trace, params = {}) {
    const metadata = params.metadata || {}
    return {
      traceName: trace?.params?.name || params.name,
      sessionId: params.sessionId || trace?.params?.sessionId || metadata.sessionId,
      userId: params.userId || trace?.params?.userId || metadata.userEmail || metadata.userId,
      version: params.version || trace?.params?.version,
      environment: metadata.environment || process.env.LANGFUSE_ENVIRONMENT || 'default',
    }
  }

  spanAttributes(observation) {
    const params = observation.params
    const trace = observation.type === 'trace' ? observation : this.rootFor(observation.traceId)
    const common = this.commonTraceAttrs(trace, params)
    const attributes = []
    const metadata = params.metadata || {}

    addAttr(attributes, 'langfuse.trace.name', common.traceName)
    addAttr(attributes, 'langfuse.session.id', common.sessionId)
    addAttr(attributes, 'session.id', common.sessionId)
    addAttr(attributes, 'langfuse.user.id', common.userId)
    addAttr(attributes, 'user.id', common.userId)
    addAttr(attributes, 'langfuse.version', common.version)
    addAttr(attributes, 'langfuse.release', common.version)
    addAttr(attributes, 'langfuse.environment', common.environment)
    addAttr(attributes, 'deployment.environment', common.environment)

    if (observation.type === 'trace') {
      addJsonAttr(attributes, 'langfuse.trace.input', params.input)
      addJsonAttr(attributes, 'langfuse.trace.output', params.output)
      addJsonAttr(attributes, 'langfuse.observation.input', params.input)
      addJsonAttr(attributes, 'langfuse.observation.output', params.output)
      addAttr(attributes, 'langfuse.observation.type', 'span')
      addMetadata(attributes, 'langfuse.trace.metadata', metadata)
      addMetadata(attributes, 'langfuse.observation.metadata', metadata)
    } else {
      addJsonAttr(attributes, 'langfuse.observation.input', params.input)
      addJsonAttr(attributes, 'langfuse.observation.output', params.output)
      addAttr(attributes, 'langfuse.observation.type', observation.type)
      addAttr(attributes, 'langfuse.observation.level', params.level || 'DEFAULT')
      addAttr(attributes, 'langfuse.observation.status_message', params.statusMessage)
      addMetadata(attributes, 'langfuse.observation.metadata', metadata)
    }

    if (observation.type === 'generation') {
      addAttr(attributes, 'langfuse.observation.model.name', params.model)
      addJsonAttr(attributes, 'langfuse.observation.model.parameters', params.modelParameters)
      addJsonAttr(attributes, 'langfuse.observation.usage_details', params.usage)
      const totalCost = metadata.cost ?? params.cost
      if (totalCost != null) addJsonAttr(attributes, 'langfuse.observation.cost_details', { total: totalCost })
    }

    return attributes
  }

  otlpSpan(observation) {
    const startTime = observation.params.startTime || observation.createdAt
    const endTime = observation.params.endTime || observation.updatedAt || startTime
    const span = {
      traceId: observation.traceId || observation.id,
      spanId: observation.spanId,
      name: observation.params.name || (observation.type === 'trace' ? 'trace' : observation.type),
      kind: 1,
      startTimeUnixNano: toUnixNano(startTime),
      endTimeUnixNano: toUnixNano(endTime),
      attributes: this.spanAttributes(observation),
      status: { code: observation.params.level === 'ERROR' ? 2 : 1 },
    }

    const parentSpanId = this.parentSpanId(observation)
    if (parentSpanId) span.parentSpanId = parentSpanId

    return span
  }

  buildPayload() {
    const spans = []
    const tracesToInclude = new Set()

    for (const observation of this.observations.values()) {
      if (!observation.dirty || !observation.isReady()) continue
      tracesToInclude.add(observation.traceId || observation.id)
      spans.push(this.otlpSpan(observation))
    }

    for (const traceId of tracesToInclude) {
      const root = this.rootFor(traceId)
      if (root && !spans.some((span) => span.spanId === root.spanId)) {
        spans.unshift(this.otlpSpan(root))
      }
    }

    if (spans.length === 0) return undefined

    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'claude-code-telemetry-bridge' } },
              ...Object.entries(this.resourceAttributes).map(([key, value]) => ({ key, value: otelValue(value) })).filter((attr) => attr.value),
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: 'rimthan-claude-code-telemetry-bridge',
                version: '1.0.0',
              },
              spans,
            },
          ],
        },
      ],
    }
  }

  markExported() {
    for (const observation of this.observations.values()) {
      if (observation.isReady()) {
        observation.dirty = false
        observation.exported = true
      }
    }
  }

  async flushAsync() {
    const payload = this.buildPayload()
    if (!payload) return
    if (!this.fetchImpl) throw new Error('No fetch implementation available for OTLP export')

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/json',
        'x-langfuse-ingestion-version': '4',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const error = new Error(`Langfuse OTLP export failed: HTTP ${response.status}${body ? ` ${body.slice(0, 500)}` : ''}`)
      this.emitError(error)
      throw error
    }

    this.markExported()
  }

  async shutdownAsync() {
    try {
      await this.flushAsync()
    } catch (error) {
      logger.error({ error: error.message || error }, 'Error during OTLP Langfuse shutdown flush')
    }
  }
}

module.exports = {
  OtelLangfuse,
  OtelLangfuseObservation,
  normalizeEndpoint,
  safeJson,
}
