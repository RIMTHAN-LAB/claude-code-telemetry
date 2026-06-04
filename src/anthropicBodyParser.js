const TEXT_LIMIT = 12000

function truncateText(value, limit = TEXT_LIMIT) {
  if (value == null) return undefined
  const text = String(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`
}

function toBoolean(value) {
  if (value === true || value === false) return value
  if (value == null) return undefined
  return String(value).toLowerCase() === 'true'
}

function rawBodyPayload(attrs = {}) {
  return {
    body: attrs.body,
    bodyRef: attrs.body_ref || attrs.bodyRef,
    bodyLength: attrs.body_length || attrs.bodyLength,
    bodyTruncated: toBoolean(attrs.body_truncated ?? attrs.bodyTruncated),
  }
}

function rawBodyMetadata(attrs = {}) {
  const raw = rawBodyPayload(attrs)
  return {
    rawBodyPresent: raw.body != null || raw.bodyRef != null,
    rawBodyTruncated: raw.bodyTruncated,
    bodyLength: raw.bodyLength,
    bodyRef: raw.bodyRef,
  }
}

function parseJsonBody(body) {
  if (!body) {
    return { ok: false, status: 'missing' }
  }

  try {
    return { ok: true, value: JSON.parse(body), status: 'ok' }
  } catch (error) {
    return { ok: false, status: 'invalid_json', error: error.message }
  }
}

function contentParts(content) {
  const blockTypes = []
  const toolUseNames = []
  const textParts = []

  if (typeof content === 'string') {
    blockTypes.push('text')
    textParts.push(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const type = block.type || 'unknown'
      blockTypes.push(type)

      if (type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (type === 'tool_use') {
        if (block.name) toolUseNames.push(block.name)
      } else if (typeof block.content === 'string') {
        textParts.push(block.content)
      }
    }
  }

  return {
    text: truncateText(textParts.filter(Boolean).join('\n\n').trim()) || undefined,
    blockTypes,
    toolUseNames,
  }
}

function parseAnthropicRequestBody(body, attrs = {}) {
  const raw = rawBodyPayload({ ...attrs, body })
  const rawMeta = rawBodyMetadata({ ...attrs, body })
  const parsed = parseJsonBody(body)

  if (!parsed.ok) {
    return {
      parseStatus: parsed.status,
      parseError: parsed.error,
      raw,
      summary: {
        parseStatus: parsed.status,
        parseError: parsed.error,
        ...rawMeta,
      },
    }
  }

  const payload = parsed.value || {}
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === 'user')
  const lastUserParts = lastUserMessage ? contentParts(lastUserMessage.content) : { blockTypes: [], toolUseNames: [] }
  const toolNames = tools.map((tool) => tool && tool.name).filter(Boolean)

  const summary = {
    parseStatus: 'ok',
    model: payload.model || attrs.model,
    messageCount: messages.length,
    toolCount: tools.length,
    toolNames,
    systemPresent: payload.system != null,
    lastUserMessage: lastUserParts.text,
    lastUserContentBlockTypes: lastUserParts.blockTypes,
    ...rawMeta,
  }

  return { parseStatus: 'ok', raw, summary }
}

function parseAnthropicResponseBody(body, attrs = {}) {
  const raw = rawBodyPayload({ ...attrs, body })
  const rawMeta = rawBodyMetadata({ ...attrs, body })
  const parsed = parseJsonBody(body)

  if (!parsed.ok) {
    return {
      parseStatus: parsed.status,
      parseError: parsed.error,
      raw,
      summary: {
        parseStatus: parsed.status,
        parseError: parsed.error,
        ...rawMeta,
      },
    }
  }

  const payload = parsed.value || {}
  const parts = contentParts(payload.content)
  const usage = payload.usage
    ? {
        input: payload.usage.input_tokens,
        output: payload.usage.output_tokens,
        cacheRead: payload.usage.cache_read_input_tokens,
        cacheCreation: payload.usage.cache_creation_input_tokens,
      }
    : undefined

  const summary = {
    parseStatus: 'ok',
    model: payload.model || attrs.model,
    messageId: payload.id,
    stopReason: payload.stop_reason,
    contentBlockTypes: parts.blockTypes,
    toolUseNames: parts.toolUseNames,
    assistantText: parts.text,
    usage,
    ...rawMeta,
  }

  return { parseStatus: 'ok', raw, summary }
}

function publicRequestSummary(summary = {}) {
  return {
    model: summary.model,
    messageCount: summary.messageCount,
    toolCount: summary.toolCount,
    toolNames: summary.toolNames,
    systemPresent: summary.systemPresent,
    lastUserMessage: summary.lastUserMessage,
    rawBodyTruncated: summary.rawBodyTruncated,
    bodyLength: summary.bodyLength,
    bodyRef: summary.bodyRef,
    parseStatus: summary.parseStatus,
  }
}

function publicResponseSummary(summary = {}) {
  return {
    assistantText: summary.assistantText,
    stopReason: summary.stopReason,
    model: summary.model,
    messageId: summary.messageId,
    contentBlockTypes: summary.contentBlockTypes,
    toolUseNames: summary.toolUseNames,
    usage: summary.usage,
    rawBodyTruncated: summary.rawBodyTruncated,
    bodyLength: summary.bodyLength,
    bodyRef: summary.bodyRef,
    parseStatus: summary.parseStatus,
  }
}

module.exports = {
  parseAnthropicRequestBody,
  parseAnthropicResponseBody,
  publicRequestSummary,
  publicResponseSummary,
  rawBodyPayload,
  rawBodyMetadata,
  truncateText,
}
