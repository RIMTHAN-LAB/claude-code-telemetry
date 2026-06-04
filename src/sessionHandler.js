// Session Handler class extracted for better testability
// const { Langfuse } = require('langfuse') // Imported but not used directly in this file
const pino = require('pino')
const {
  parseAnthropicRequestBody,
  parseAnthropicResponseBody,
  publicRequestSummary,
  publicResponseSummary,
  rawBodyPayload,
  rawBodyMetadata,
} = require('./anthropicBodyParser')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          colorize: true,
        },
      }
    : undefined,
})

class SessionHandler {
  constructor(sessionId, resourceAttributes = {}, langfuseInstance) {
    if (!sessionId) {
      throw new Error('SessionHandler requires a sessionId')
    }

    this.sessionId = sessionId
    this.createdAt = new Date()
    this.langfuse = langfuseInstance
    this.traces = new Map()
    this.spans = new Map()
    this.rootSpans = new Map()
    this.metrics = []
    this.lastActivity = Date.now()

    // Current conversation state
    this.currentTrace = null
    this.currentSpan = null
    this.currentPrompt = null
    this.currentTurn = null
    this.sessionEventsTrace = null
    this.pendingApiCalls = []
    this.sessionSetupEventCounts = {}
    this.toolSequence = []
    this.conversationStartTime = null

    // Metrics
    this.totalCost = 0
    this.totalTokens = 0
    this.apiCallCount = 0
    this.toolCallCount = 0
    this.conversationCount = 0
    this.linesAdded = 0
    this.linesRemoved = 0

    // Performance tracking
    this.latencies = {
      api: [],
      tool: [],
      conversation: [],
    }

    // Extract metadata
    const serviceInfo = this.extractResourceInfo(resourceAttributes)
    this.metadata = {
      sessionId,
      userId: process.env.USER_EMAIL || process.env.USER || 'unknown',
      environment: process.env.NODE_ENV || 'production',
      platform: process.platform,
      node_version: process.version,
      start_time: new Date().toISOString(),
      release: serviceInfo.version || process.env.CLAUDE_CODE_VERSION || 'unknown',
      service: serviceInfo,
    }

    logger.info(
      { sessionId, service: serviceInfo.name, version: serviceInfo.version },
      'Session created',
    )
  }

  extractResourceInfo(resourceAttributes) {
    const attrs = resourceAttributes || {}
    return {
      name: attrs['service.name'] || 'claude-code',
      version: attrs['service.version'] || attrs['claude.version'] || attrs['app.version'] || 'unknown',
      instance: attrs['service.instance.id'] || attrs['host.name'],
      telemetrySDK: attrs['telemetry.sdk.name'],
      terminalType: attrs['terminal.type'],
    }
  }

  getPromptId(attrs = {}) {
    return attrs['prompt.id'] || attrs.prompt_id || attrs.promptId
  }

  getUserId(attrs = {}) {
    return attrs['user.email'] || attrs['user.id'] || this.userEmail || this.metadata.userId
  }

  turnMetadata(attrs = {}, timestamp, startedFrom = 'user_prompt') {
    const promptId = this.getPromptId(attrs)
    return {
      traceKind: 'turn',
      promptId,
      conversationIndex: this.conversationCount,
      sessionId: attrs['session.id'] || this.sessionId,
      userEmail: attrs['user.email'] || this.userEmail,
      organizationId: attrs['organization.id'] || this.organizationId,
      userAccountUuid: attrs['user.account_uuid'] || this.userAccountUuid,
      userAccountId: attrs['user.account_id'] || this.userAccountId,
      terminalType: attrs['terminal.type'] || this.terminalType,
      appVersion: attrs['app.version'] || this.metadata.service.version,
      startedFrom,
      promptTimestamp: attrs['event.timestamp'] || timestamp,
      claude: {
        sessionId: attrs['session.id'] || this.sessionId,
        version: attrs['app.version'] || this.metadata.service.version,
      },
    }
  }

  createTurnTrace({ prompt, promptLength = 0, attrs = {}, timestamp, startedFrom = 'user_prompt', requestSummary }) {
    this.conversationCount++
    this.conversationStartTime = Date.now()
    this.currentPrompt = prompt || this.currentPrompt || '[No user prompt captured yet]'
    this.currentSpan = null
    this.toolSequence = []

    const input = {
      prompt: this.currentPrompt,
      request: requestSummary ? publicRequestSummary(requestSummary) : undefined,
      length: promptLength || undefined,
    }

    this.currentTrace = this.langfuse.trace({
      name: 'Claude Code turn',
      sessionId: attrs['session.id'] || this.sessionId,
      userId: this.getUserId(attrs),
      input,
      metadata: this.turnMetadata(attrs, timestamp, startedFrom),
      version: this.metadata.release,
    })

    this.currentTurn = {
      trace: this.currentTrace,
      prompt: this.currentPrompt,
      promptId: this.getPromptId(attrs),
      startedFrom,
      input,
      output: undefined,
      apiCalls: [],
    }

    return this.currentTrace
  }

  getOrCreateSessionEventsTrace(attrs = {}, timestamp) {
    if (this.sessionEventsTrace) {
      return this.sessionEventsTrace
    }

    this.sessionEventsTrace = this.langfuse.trace({
      name: 'Claude Code session events',
      sessionId: attrs['session.id'] || this.sessionId,
      userId: this.getUserId(attrs),
      input: {
        sessionStart: this.createdAt.toISOString(),
      },
      metadata: {
        traceKind: 'session_events',
        sessionId: attrs['session.id'] || this.sessionId,
        userEmail: attrs['user.email'] || this.userEmail,
        organizationId: attrs['organization.id'] || this.organizationId,
        userAccountUuid: attrs['user.account_uuid'] || this.userAccountUuid,
        terminalType: attrs['terminal.type'] || this.terminalType,
        appVersion: attrs['app.version'] || this.metadata.service.version,
        firstEventAt: timestamp,
      },
      version: this.metadata.release,
    })

    return this.sessionEventsTrace
  }

  isSetupNoiseEvent(shortName) {
    return /^(mcp_server_connection|hook_registered|plugin_loaded|auth|session_start|active_time|active-time|hook_plugin_metrics)$/.test(shortName) ||
      /^hook_/.test(shortName)
  }

  recordSessionSetupEvent(shortName, attrs = {}, timestamp) {
    const trace = this.getOrCreateSessionEventsTrace(attrs, timestamp)
    this.sessionSetupEventCounts[shortName] = (this.sessionSetupEventCounts[shortName] || 0) + 1

    if (trace.update) {
      trace.update({
        output: {
          setupEventCounts: this.sessionSetupEventCounts,
          lastEventName: shortName,
          lastEventAt: timestamp,
        },
      })
    }

    return trace
  }

  eventTimeMs(timestamp) {
    const parsed = timestamp ? new Date(timestamp).getTime() : NaN
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  findOrCreatePendingApiCall({ attrs = {}, model, timestamp, create = true }) {
    const traceId = this.currentTrace?.id
    const requestId = attrs.request_id || attrs['request.id'] || attrs.client_request_id
    const callModel = model || attrs.model
    const nowMs = this.eventTimeMs(timestamp)

    let call
    let matchStrategy = 'created'

    if (requestId) {
      call = [...this.pendingApiCalls].reverse().find((candidate) =>
        candidate.traceId === traceId && candidate.requestId === requestId)
      if (call) matchStrategy = 'request_id'
    }

    if (!call && callModel) {
      call = [...this.pendingApiCalls].reverse().find((candidate) =>
        candidate.traceId === traceId &&
        candidate.model === callModel &&
        Math.abs(nowMs - candidate.updatedAtMs) <= 10000)
      if (call) matchStrategy = 'model_time_window'
    }

    if (!call && create) {
      call = {
        id: `${traceId || this.sessionId}-${this.pendingApiCalls.length + 1}`,
        traceId,
        requestId,
        model: callModel,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        requestSummary: undefined,
        responseSummary: undefined,
        generation: undefined,
      }
      this.pendingApiCalls.push(call)
      if (this.currentTurn) {
        this.currentTurn.apiCalls.push(call)
      }
    } else if (call) {
      call.updatedAtMs = nowMs
      if (requestId && !call.requestId) call.requestId = requestId
      if (callModel && !call.model) call.model = callModel
    }

    return { call, matchStrategy }
  }

  updateTurnInputFromApiCall(call) {
    if (!this.currentTurn || !this.currentTrace || !call?.requestSummary) return

    this.currentTurn.input = {
      prompt: this.currentTurn.prompt,
      request: publicRequestSummary(call.requestSummary),
    }

    if (this.currentTrace.update) {
      this.currentTrace.update({ input: this.currentTurn.input })
    }
  }

  updateTurnOutputFromApiCall(call) {
    if (!this.currentTurn || !this.currentTrace || !call?.responseSummary) return

    const response = publicResponseSummary(call.responseSummary)
    this.currentTurn.output = {
      assistantText: response.assistantText,
      stopReason: response.stopReason,
      model: response.model,
      messageId: response.messageId,
      contentBlockTypes: response.contentBlockTypes,
    }

    if (this.currentTrace.update) {
      const update = { output: this.currentTurn.output }
      if (this.currentTurn.input?.request) update.input = this.currentTurn.input
      this.currentTrace.update(update)
    }
  }

  generationInput(call, model) {
    return {
      prompt: this.currentTurn?.prompt || this.currentPrompt,
      request: call?.requestSummary ? publicRequestSummary(call.requestSummary) : { model },
    }
  }

  generationOutput(call) {
    if (!call?.responseSummary) return undefined
    return publicResponseSummary(call.responseSummary)
  }

  updateGenerationFromApiCall(call) {
    if (!call?.generation?.update) return

    const update = {}
    if (call.requestSummary) update.input = this.generationInput(call, call.model)
    if (call.responseSummary) update.output = this.generationOutput(call)
    if (call.usage) update.usage = call.usage

    if (Object.keys(update).length > 0) {
      call.generation.update(update)
    }
  }

  processLogRecord(logRecord, resource) {
    const eventName = logRecord.body?.stringValue
    const timestamp = logRecord.timeUnixNano ? new Date(Number(logRecord.timeUnixNano) / 1000000).toISOString() : new Date().toISOString()
    const attrs = extractAttributesArray(logRecord.attributes)

    logger.debug({ eventName, attrs, sessionId: this.sessionId }, 'Processing event')

    switch (eventName) {
      case 'claude_code.user_prompt':
        this.handleUserPrompt(attrs, timestamp)
        break
      case 'claude_code.api_request':
        this.handleApiRequest(attrs, timestamp)
        break
      case 'claude_code.tool_result':
        this.handleToolResult(attrs, timestamp)
        break
      case 'claude_code.api_error':
        this.handleApiError(attrs, timestamp)
        break
      default:
        logger.debug({ eventName, sessionId: this.sessionId }, 'Unknown event type')
    }
  }

  handleUserPrompt(attrs, timestamp) {
    const prompt = attrs.prompt || '[Prompt hidden]'
    const promptId = this.getPromptId(attrs)

    if (this.currentTurn && this.currentTrace && this.currentTurn.startedFrom !== 'user_prompt') {
      const samePrompt = this.currentTurn.prompt === prompt
      const samePromptId = promptId && this.currentTurn.promptId === promptId

      if (samePrompt || samePromptId) {
        const previousStart = this.currentTurn.startedFrom
        this.currentPrompt = prompt
        this.currentTurn.prompt = prompt
        this.currentTurn.promptId = promptId || this.currentTurn.promptId
        this.currentTurn.startedFrom = 'user_prompt'
        this.currentTurn.input = {
          ...this.currentTurn.input,
          prompt,
          length: attrs.prompt_length || undefined,
        }

        if (this.currentTrace.update) {
          this.currentTrace.update({
            input: this.currentTurn.input,
            metadata: {
              ...this.turnMetadata(attrs, timestamp, 'user_prompt'),
              recoveredFrom: previousStart,
            },
          })
        }

        logger.info(
          { sessionId: this.sessionId, promptLength: attrs.prompt_length || 0, recoveredFrom: previousStart },
          'User prompt merged into recovered turn',
        )
        return
      }
    }

    logger.info(
      { sessionId: this.sessionId, promptLength: attrs.prompt_length || 0 },
      'User prompt received',
    )

    this.createTurnTrace({
      prompt,
      promptLength: attrs.prompt_length || 0,
      attrs,
      timestamp,
      startedFrom: 'user_prompt',
    })
  }

  ensureTrace(attrs = {}, timestamp, reason = 'event') {
    if (this.currentTrace) {
      return this.currentTrace
    }

    const prompt = attrs.prompt || attrs.user_prompt || this.currentPrompt
    if (!prompt && !this.getPromptId(attrs)) {
      return this.getOrCreateSessionEventsTrace(attrs, timestamp)
    }

    return this.createTurnTrace({
      prompt: prompt || '[No user prompt captured yet]',
      attrs,
      timestamp,
      startedFrom: reason,
    })
  }

  handleApiRequest(attrs, timestamp) {
    const model = attrs.model || 'unknown'
    const inputTokens = parseInt(attrs.input_tokens || 0)
    const outputTokens = parseInt(attrs.output_tokens || 0)
    const cacheReadTokens = parseInt(attrs.cache_read_tokens || 0)
    const cacheCreationTokens = parseInt(attrs.cache_creation_tokens || 0)
    const totalTokens = inputTokens + outputTokens
    const cost = parseFloat(attrs.cost || 0)
    const requestId = attrs.request_id

    const startTime = new Date(timestamp)
    const endTime = attrs['api.response_time'] ? new Date(new Date(timestamp).getTime() + (attrs['api.response_time'] || 0)) : new Date()
    const durationMs = attrs['api.response_time'] || attrs.duration || endTime - startTime

    // Update metrics
    this.totalCost += cost
    this.totalTokens += totalTokens
    this.apiCallCount++

    if (!this.currentTrace) {
      const prompt = attrs.prompt || attrs.user_prompt || this.currentPrompt
      if (prompt || this.getPromptId(attrs)) {
        this.createTurnTrace({
          prompt: prompt || '[No user prompt captured yet]',
          attrs,
          timestamp,
          startedFrom: 'api_request',
        })
      } else {
        const trace = this.getOrCreateSessionEventsTrace(attrs, timestamp)
        this.langfuse.event({
          name: 'API request before prompt',
          traceId: trace.id,
          startTime,
          input: { model },
          output: {
            inputTokens,
            outputTokens,
            totalTokens,
            cost,
            durationMs,
          },
          metadata: {
            traceKind: 'session_events',
            requestId,
            cacheReadTokens,
            cacheCreationTokens,
          },
          level: 'DEBUG',
          version: this.metadata.release,
        })
        return
      }
    }

    // Create generation span
    const modelType = model.includes('haiku') ? 'routing' : 'generation'
    const { call } = this.findOrCreatePendingApiCall({ attrs, model, timestamp })
    call.model = model
    call.requestId = requestId || call.requestId
    call.usage = {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      unit: 'TOKENS',
    }
    call.cost = cost

    logger.debug({
      sessionId: this.sessionId,
      traceId: this.currentTrace?.id,
      model,
      modelType,
      hasTrace: !!this.currentTrace,
      langfuseAvailable: !!this.langfuse,
    }, 'Creating generation observation')

    const span = this.langfuse.generation({
      name: modelType === 'routing' ? `Routing: ${model}` : `LLM: ${model}`,
      traceId: this.currentTrace?.id, // Use traceId, not parentObservationId
      startTime,
      endTime,
      model,
      input: this.generationInput(call, model),
      output: this.generationOutput(call),
      usage: call.usage,
      metadata: {
        observationKind: modelType,
        cost,
        requestId,
        cache: {
          read: cacheReadTokens,
          creation: cacheCreationTokens,
          hitRate: totalTokens > 0 ? cacheReadTokens / totalTokens : 0,
        },
        performance: {
          durationMs,
          tokensPerSecond: durationMs > 0 ? (outputTokens / durationMs) * 1000 : 0,
        },
        model: {
          name: model,
          type: modelType,
          provider: 'anthropic',
        },
        claude: {
          sessionId: attrs['session.id'] || this.sessionId,
          apiCallIndex: this.apiCallCount,
        },
      },
      level: modelType === 'generation' ? 'DEFAULT' : 'DEBUG',
      statusMessage: attrs.status_message || `${modelType} completed`,
      version: this.metadata.release,
    })

    call.generation = span
    this.updateGenerationFromApiCall(call)
    this.updateTurnInputFromApiCall(call)
    this.updateTurnOutputFromApiCall(call)

    logger.debug({
      sessionId: this.sessionId,
      generationId: span?.id,
      modelType,
    }, 'Generation observation created')

    if (modelType === 'generation') {
      this.currentSpan = span
    }

    // Collect latency
    if (durationMs > 0) {
      this.latencies.api.push(durationMs)
    }

    logger.info(
      {
        sessionId: this.sessionId,
        model,
        tokens: totalTokens,
        cost,
        duration: durationMs,
        cache: { read: cacheReadTokens, creation: cacheCreationTokens },
        requestId,
      },
      `API call #${this.apiCallCount}`,
    )
  }

  handleToolResult(attrs, timestamp) {
    const toolName = attrs.tool_name || attrs.tool || attrs.name || 'unknown'
    const success = attrs.success == null ? true : !(attrs.success === false || attrs.success === 'false')
    const durationMs = parseInt(attrs.duration_ms || attrs.duration || '0', 10)
    const decision = attrs.decision || 'execute'
    const source = attrs.source || 'automated'

    this.toolCallCount++
    const startTime = durationMs > 0 ? new Date(new Date(timestamp).getTime() - durationMs) : new Date(timestamp)

    // Track tool sequence
    this.toolSequence.push({
      name: toolName,
      success,
      duration: durationMs,
      timestamp,
    })

    // Create event
    if (this.currentTrace) {
      this.langfuse.event({
        name: `Tool: ${toolName}`,
        traceId: this.currentTrace.id,
        parentObservationId: this.currentSpan?.id, // Link to current generation if exists
        startTime,
        input: {
          toolName,
          decision,
          source,
          toolInput: attrs.tool_input,
          toolParameters: attrs.tool_parameters,
          fullCommand: attrs.full_command,
        },
        output: {
          success,
          durationMs,
          toolOutput: attrs.tool_output || attrs.output || attrs.result,
        },
        metadata: {
          traceKind: 'turn',
          eventTimestamp: attrs['event.timestamp'] || timestamp,
          toolIndex: this.toolCallCount,
          decision: {
            type: decision,
            source,
          },
          performance: {
            durationMs,
          },
          claude: {
            sessionId: attrs['session.id'] || this.sessionId,
          },
        },
        level: success ? 'DEFAULT' : 'WARNING',
      })
    }

    // Collect tool latency
    if (durationMs > 0) {
      this.latencies.tool.push(durationMs)
    }

    logger.info(
      { sessionId: this.sessionId, tool: toolName, success, duration: durationMs },
      `Tool #${this.toolCallCount}`,
    )
  }

  handleApiError(attrs, timestamp) {
    const model = attrs.model || 'unknown'
    const errorMessage = attrs.error_message || attrs.error || 'Unknown error'
    const statusCode = attrs.status_code || attrs.status || 0

    logger.error({
      sessionId: this.sessionId,
      model,
      error: errorMessage,
      statusCode,
      timestamp,
    }, 'API error occurred')

    if (this.currentTrace) {
      this.langfuse.event({
        name: 'api-error',
        traceId: this.currentTrace.id,
        metadata: {
          model,
          error: errorMessage,
          statusCode,
          timestamp,
        },
        level: 'ERROR',
      })
    }
  }

  handleGenericEvent(eventName, attrs, standardAttrs = {}, timestamp) {
    const shortName = String(eventName || 'unknown_event').replace(/^claude_code\./, '')
    const startTime = timestamp ? new Date(timestamp) : new Date()
    const success = attrs.success
    const isError = /error|failed|failure|retries_exhausted/.test(shortName) || success === false || success === 'false'
    const isSetupNoise = this.isSetupNoiseEvent(shortName)
    const level = isError ? 'ERROR' : (isSetupNoise ? 'DEBUG' : 'DEFAULT')
    const isApiRequestBody = /api_request_body/.test(shortName)
    const isApiResponseBody = /api_response_body/.test(shortName)
    const parsedRequest = isApiRequestBody ? parseAnthropicRequestBody(attrs.body, attrs) : undefined
    const parsedResponse = isApiResponseBody ? parseAnthropicResponseBody(attrs.body, attrs) : undefined

    let trace = this.currentTrace

    if (!trace) {
      const recoveredPrompt = parsedRequest?.summary?.lastUserMessage || attrs.prompt || attrs.user_prompt

      if (recoveredPrompt || this.getPromptId(attrs)) {
        trace = this.createTurnTrace({
          prompt: recoveredPrompt || '[No user prompt captured yet]',
          attrs,
          timestamp,
          startedFrom: isApiRequestBody ? 'api_request_body' : eventName,
          requestSummary: parsedRequest?.summary,
        })
      } else if (isSetupNoise) {
        this.recordSessionSetupEvent(shortName, attrs, timestamp)
        return
      } else {
        trace = this.getOrCreateSessionEventsTrace(attrs, timestamp)
      }
    }

    const isTurnTrace = trace === this.currentTrace

    const input = {}
    const output = {}
    const metadata = {
      traceKind: isTurnTrace ? 'turn' : 'session_events',
      eventName,
      eventTimestamp: attrs['event.timestamp'] || timestamp,
      severityNumber: standardAttrs.severityNumber,
      severityText: standardAttrs.severityText,
      attributes: attrs,
      organizationId: attrs['organization.id'] || standardAttrs.organizationId || this.organizationId,
      userAccountUuid: attrs['user.account_uuid'] || standardAttrs.userAccountUuid || this.userAccountUuid,
      userAccountId: attrs['user.account_id'] || this.userAccountId,
      userEmail: attrs['user.email'] || standardAttrs.userEmail || this.userEmail,
      terminalType: attrs['terminal.type'] || standardAttrs.terminalType || this.terminalType,
    }

    if (isApiRequestBody) {
      const { call, matchStrategy } = isTurnTrace
        ? this.findOrCreatePendingApiCall({
          attrs,
          model: parsedRequest.summary?.model,
          timestamp,
        })
        : { call: undefined, matchStrategy: 'session_events' }

      if (call) {
        call.requestSummary = parsedRequest.summary
        if (parsedRequest.summary?.model && !call.model) call.model = parsedRequest.summary.model
        this.updateTurnInputFromApiCall(call)
        this.updateGenerationFromApiCall(call)
      }

      this.langfuse.event({
        name: 'Raw API request',
        traceId: trace.id,
        startTime,
        input: rawBodyPayload(attrs),
        output: undefined,
        metadata: {
          ...metadata,
          ...rawBodyMetadata(attrs),
          request: publicRequestSummary(parsedRequest.summary),
          requestMatchStrategy: matchStrategy,
          parseStatus: parsedRequest.parseStatus,
          parseError: parsedRequest.parseError,
        },
        level,
        version: this.metadata.release,
      })
      return
    }

    if (isApiResponseBody) {
      const { call, matchStrategy } = isTurnTrace
        ? this.findOrCreatePendingApiCall({
          attrs,
          model: parsedResponse.summary?.model,
          timestamp,
        })
        : { call: undefined, matchStrategy: 'session_events' }

      if (call) {
        call.responseSummary = parsedResponse.summary
        if (parsedResponse.summary?.model && !call.model) call.model = parsedResponse.summary.model
        if (parsedResponse.summary?.usage) {
          const inputTokens = parsedResponse.summary.usage.input || 0
          const outputTokens = parsedResponse.summary.usage.output || 0
          call.usage = {
            input: inputTokens,
            output: outputTokens,
            total: inputTokens + outputTokens,
            unit: 'TOKENS',
          }
        }
        this.updateTurnOutputFromApiCall(call)
        this.updateGenerationFromApiCall(call)
      }

      this.langfuse.event({
        name: 'Raw API response',
        traceId: trace.id,
        startTime,
        input: undefined,
        output: rawBodyPayload(attrs),
        metadata: {
          ...metadata,
          ...rawBodyMetadata(attrs),
          response: publicResponseSummary(parsedResponse.summary),
          requestMatchStrategy: matchStrategy,
          parseStatus: parsedResponse.parseStatus,
          parseError: parsedResponse.parseError,
        },
        level,
        version: this.metadata.release,
      })
      return
    }

    if (attrs.prompt || attrs.user_prompt) {
      input.prompt = attrs.prompt || attrs.user_prompt
    }
    if (attrs.body || attrs.body_ref || attrs.body_length) {
      const bodyPayload = {
        body: attrs.body,
        bodyRef: attrs.body_ref,
        bodyLength: attrs.body_length,
        bodyTruncated: attrs.body_truncated,
      }

      input.body = bodyPayload.body
      input.bodyRef = bodyPayload.bodyRef
      input.bodyLength = bodyPayload.bodyLength
      input.bodyTruncated = bodyPayload.bodyTruncated
    }
    if (attrs.tool_input || attrs.tool_parameters || attrs.full_command) {
      input.toolInput = attrs.tool_input
      input.toolParameters = attrs.tool_parameters
      input.fullCommand = attrs.full_command
    }
    if (attrs.tool_output || attrs.output || attrs.result) {
      output.toolOutput = attrs.tool_output || attrs.output || attrs.result
    }
    if (attrs.error || attrs.error_message || attrs.error_category || attrs.error_code) {
      output.error = attrs.error || attrs.error_message
      output.errorCategory = attrs.error_category
      output.errorCode = attrs.error_code
    }
    if (attrs.status || attrs.action || attrs.decision) {
      output.status = attrs.status
      output.action = attrs.action
      output.decision = attrs.decision
    }

    this.langfuse.event({
      name: isSetupNoise ? `Session: ${shortName}` : `Claude: ${shortName}`,
      traceId: trace.id,
      startTime,
      input: Object.keys(input).length > 0 ? input : undefined,
      output: Object.keys(output).length > 0 ? output : undefined,
      metadata,
      level,
      version: this.metadata.release,
    })
  }

  processMetric(metric, dataPoint, attrs) {
    this.lastActivity = Date.now()

    // Handle different metric types
    switch (metric.name) {
      case 'claude_code.session.count': {
        // Session count metric
        const sessionCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info({
          sessionId: this.sessionId,
          count: sessionCount,
        }, 'Session count metric')

        // Create a session started event
        if (this.currentTrace) {
          this.langfuse.event({
            name: 'session-started',
            traceId: this.currentTrace.id,
            metadata: {
              count: sessionCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.cost.usage': {
        // Update cost tracking from metrics
        const cost = dataPoint.asDouble || 0
        const costModel = attrs.model || 'unknown'
        this.totalCost += cost
        logger.info({ sessionId: this.sessionId, cost, model: costModel, totalCost: this.totalCost }, 'Cost metric received')
        break
      }

      case 'claude_code.token.usage': {
        // Track token usage including cache tokens
        const tokens = parseInt(dataPoint.asDouble || dataPoint.asInt || 0)
        const tokenType = attrs.type || 'unknown'
        const tokenModel = attrs.model || 'unknown'

        // Track cache tokens separately
        if (!this.cacheTokens) {
          this.cacheTokens = { read: 0, creation: 0 }
        }

        switch (tokenType) {
          case 'input':
          case 'output':
            this.totalTokens += tokens
            break
          case 'cacheRead':
            this.cacheTokens.read += tokens
            break
          case 'cacheCreation':
            this.cacheTokens.creation += tokens
            break
        }

        logger.info({
          sessionId: this.sessionId,
          tokens,
          tokenType,
          model: tokenModel,
          totalTokens: this.totalTokens,
          cacheTokens: this.cacheTokens,
        }, 'Token metric received')
        break
      }

      case 'claude_code.lines_of_code.count': {
        // Track lines of code modifications
        const lines = dataPoint.asDouble || 0
        const modificationType = attrs.type // 'added' or 'removed'

        // Update counters
        if (modificationType === 'added') {
          this.linesAdded += lines
        } else if (modificationType === 'removed') {
          this.linesRemoved += lines
        }

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'code-modification',
            metadata: {
              lines,
              type: modificationType,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }

        logger.info({
          sessionId: this.sessionId,
          lines,
          type: modificationType,
        }, 'Code modification metric')
        break
      }

      case 'claude_code.pull_request.count': {
        // PR creation metric
        const prCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info({
          sessionId: this.sessionId,
          count: prCount,
        }, 'Pull request created')

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'pull-request-created',
            metadata: {
              count: prCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.commit.count': {
        // Git commit metric
        const commitCount = dataPoint.asDouble || dataPoint.asInt || 1
        logger.info({
          sessionId: this.sessionId,
          count: commitCount,
        }, 'Git commit created')

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'git-commit-created',
            metadata: {
              count: commitCount,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.code_edit_tool.decision': {
        // Tool permission decision metric
        const decision = attrs.decision
        const tool = attrs.tool
        const language = attrs.language

        logger.info({
          sessionId: this.sessionId,
          tool,
          decision,
          language,
        }, 'Tool permission decision')

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'tool-permission-decision',
            metadata: {
              tool,
              decision,
              language,
              timestamp: new Date().toISOString(),
            },
            level: 'DEFAULT',
          })
        }
        break
      }

      case 'claude_code.active_time.total': {
        // Active time metric
        const activeTime = dataPoint.asDouble || 0
        logger.info({
          sessionId: this.sessionId,
          activeTimeSeconds: activeTime,
        }, 'Active time metric')

        if (this.currentTrace) {
          this.langfuse.event({
            traceId: this.currentTrace.id,
            name: 'active-time-update',
            metadata: {
              seconds: activeTime,
              timestamp: new Date().toISOString(),
            },
            level: 'DEBUG',
          })
        }
        break
      }

      default:
        logger.debug({
          sessionId: this.sessionId,
          metricName: metric.name,
          value: dataPoint.asDouble || dataPoint.asInt || 0,
          attributes: attrs,
        }, 'Unknown metric received')
    }
  }

  async finalize() {
    try {
      // Close current span if exists
      if (this.currentSpan) {
        this.currentSpan.end({
          output: {
            toolCount: this.toolSequence.length,
            tools: this.toolSequence.map((t) => `${t.name}:${t.success}`).join(', '),
            totalDuration: this.toolSequence.reduce((sum, t) => sum + t.duration, 0),
          },
        })
        this.currentSpan = null
      }

      // Close current trace if exists
      if (this.currentTrace) {
        const duration = this.conversationStartTime ? Date.now() - this.conversationStartTime : 0
        const existingOutput = this.currentTurn?.output && typeof this.currentTurn.output === 'object'
          ? this.currentTurn.output
          : {}
        const finalOutput = {
          ...existingOutput,
          status: 'session_ended',
          duration,
        }
        const update = { output: finalOutput }
        if (this.currentTurn?.input?.request) update.input = this.currentTurn.input
        this.currentTrace.update(update)
        if (this.currentTurn) this.currentTurn.output = finalOutput
        if (this.conversationStartTime) {
          this.latencies.conversation.push(duration)
        }
      }

      // Calculate percentiles
      const calculatePercentiles = (data) => {
        if (!data || data.length === 0) return null
        const sorted = [...data].sort((a, b) => a - b)
        return {
          count: data.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          avg: Math.round(data.reduce((a, b) => a + b, 0) / data.length),
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
        }
      }

      const apiPercentiles = calculatePercentiles(this.latencies.api)
      const toolPercentiles = calculatePercentiles(this.latencies.tool)
      const conversationPercentiles = calculatePercentiles(this.latencies.conversation)

      // Create session summary
      const sessionDuration = Date.now() - this.createdAt.getTime()
      const sessionSummary = this.langfuse.trace({
        name: 'session-summary',
        sessionId: this.sessionId,
        userId: this.metadata.userId || 'claude-code-user',
        version: this.metadata.release,
        input: {
          sessionStart: this.createdAt.toISOString(),
          metadata: this.metadata,
        },
        output: {
          sessionEnd: new Date().toISOString(),
          sessionDuration,
          conversationCount: this.conversationCount,
          apiCallCount: this.apiCallCount,
          toolCallCount: this.toolCallCount,
          totalCost: this.totalCost,
          totalTokens: this.totalTokens,
          cacheTokens: this.cacheTokens || { read: 0, creation: 0 },
          codeChanges: {
            linesAdded: this.linesAdded,
            linesRemoved: this.linesRemoved,
            netChange: this.linesAdded - this.linesRemoved,
          },
          performance: {
            api: apiPercentiles,
            tool: toolPercentiles,
            conversation: conversationPercentiles,
          },
          additionalMetrics: {
            activeTime: this.activeTime || 0,
            commitCount: this.commitCount || 0,
            pullRequestCount: this.prCount || 0,
            toolDecisions: this.toolDecisions || [],
          },
        },
        metadata: {
          service: this.metadata.service,
          environment: this.metadata.environment,
          platform: this.metadata.platform,
          nodeVersion: this.metadata.node_version,
          toolSequence: this.toolSequence,
          finalStatus: 'completed',
          organizationId: this.organizationId,
          userAccountUuid: this.userAccountUuid,
          userEmail: this.userEmail,
          terminalType: this.terminalType,
        },
      })

      // Calculate quality score
      const cacheHitRate = this.totalTokens > 0 ? this.latencies.api.reduce((sum, l) => sum + l, 0) / this.totalTokens : 0
      const avgResponseTime = apiPercentiles ? apiPercentiles.avg : 0
      const toolSuccessRate = this.toolSequence.length > 0 ? this.toolSequence.filter((t) => t.success).length / this.toolSequence.length : 1
      const qualityScore = Math.min(100, Math.round((cacheHitRate * 20) + (toolSuccessRate * 40) + (avgResponseTime < 1000 ? 40 : 20)))

      this.langfuse.score({
        traceId: sessionSummary.id,
        name: 'quality',
        value: qualityScore,
        comment: `Cache rate: ${cacheHitRate.toFixed(2)}, Tool success: ${toolSuccessRate.toFixed(2)}, Avg response: ${avgResponseTime}ms`,
      })

      // Score token efficiency
      if (this.totalCost > 0) {
        const tokenEfficiency = this.totalTokens / this.totalCost
        this.langfuse.score({
          traceId: sessionSummary.id,
          name: 'efficiency',
          value: Math.min(100, Math.round(tokenEfficiency / 10)),
          comment: `${this.conversationCount} conversations, $${this.totalCost.toFixed(4)}/conversation, $${tokenEfficiency.toFixed(4)}/1k tokens`,
        })
      }

      logger.info({ sessionId: this.sessionId, totalCost: this.totalCost }, 'Session finalized')
      const baseUrl = (process.env.LANGFUSE_HOST || 'http://localhost:3000').replace(/\/api\/public.*$/, '')
      logger.info(`View at: ${baseUrl}/sessions/${this.sessionId}`)

      await retry(() => this.langfuse.flushAsync())
    } catch (error) {
      logger.error({ error, sessionId: this.sessionId }, 'Error finalizing session')
    }
  }
}

// Helper to extract attributes
function extractAttributesArray(attributes) {
  const result = {}
  if (!attributes) return result

  for (const attr of attributes) {
    const key = attr.key
    let value = null

    if (attr.value.stringValue !== undefined) value = attr.value.stringValue
    else if (attr.value.intValue !== undefined) value = parseInt(attr.value.intValue)
    else if (attr.value.doubleValue !== undefined) value = parseFloat(attr.value.doubleValue)
    else if (attr.value.boolValue !== undefined) value = attr.value.boolValue
    else if (attr.value.arrayValue !== undefined) {
      value = attr.value.arrayValue.values.map((v) => extractAttributeValue(v))
    } else if (attr.value.kvlistValue !== undefined) {
      value = {}
      for (const kv of attr.value.kvlistValue.values) {
        value[kv.key] = extractAttributeValue(kv.value)
      }
    }

    result[key] = value
  }

  return result
}

function extractAttributeValue(value) {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return parseInt(value.intValue)
  if (value.doubleValue !== undefined) return parseFloat(value.doubleValue)
  if (value.boolValue !== undefined) return value.boolValue
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values.map((v) => extractAttributeValue(v))
  }
  if (value.kvlistValue !== undefined) {
    const obj = {}
    for (const kv of value.kvlistValue.values) {
      obj[kv.key] = extractAttributeValue(kv.value)
    }
    return obj
  }
  return null
}

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} attempts - Number of retry attempts
 * @returns {Promise<any>}
 */
async function retry(fn, attempts = 3) {
  try {
    return await fn()
  } catch (error) {
    if (attempts <= 1) throw error
    const delay = Math.min(1000 * Math.pow(2, 3 - attempts), 10000)
    logger.debug({ delay, attemptsLeft: attempts - 1 }, 'Retrying after delay')
    await new Promise((resolve) => setTimeout(resolve, delay))
    return retry(fn, attempts - 1)
  }
}

module.exports = {
  SessionHandler,
  extractAttributesArray,
  extractAttributeValue,
  retry,
}
