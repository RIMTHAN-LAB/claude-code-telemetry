const {
  parseAnthropicRequestBody,
  parseAnthropicResponseBody,
  publicRequestSummary,
  publicResponseSummary,
} = require('../../src/anthropicBodyParser')

describe('anthropicBodyParser', () => {
  describe('parseAnthropicRequestBody', () => {
    test('summarizes text prompts and tool schemas', () => {
      const parsed = parseAnthropicRequestBody(JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        system: 'You are concise.',
        messages: [
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
        ],
        tools: [
          { name: 'Bash', input_schema: {} },
          { name: 'Read', input_schema: {} },
        ],
      }), { body_length: 200, body_truncated: false })

      expect(parsed.summary).toMatchObject({
        parseStatus: 'ok',
        model: 'claude-sonnet-4-20250514',
        messageCount: 2,
        toolCount: 2,
        toolNames: ['Bash', 'Read'],
        systemPresent: true,
        lastUserMessage: 'Run tests',
        lastUserContentBlockTypes: ['text'],
        rawBodyTruncated: false,
        bodyLength: 200,
      })
      expect(publicRequestSummary(parsed.summary)).not.toHaveProperty('body')
    })

    test('handles missing messages, invalid json, truncated body, and body refs', () => {
      expect(parseAnthropicRequestBody('{"model":"claude"}').summary).toMatchObject({
        parseStatus: 'ok',
        messageCount: 0,
        toolCount: 0,
      })

      expect(parseAnthropicRequestBody('{bad json', {
        body_ref: 's3://bucket/body.json',
        body_length: 1000,
        body_truncated: true,
      }).summary).toMatchObject({
        parseStatus: 'invalid_json',
        rawBodyTruncated: true,
        bodyLength: 1000,
        bodyRef: 's3://bucket/body.json',
      })
    })
  })

  describe('parseAnthropicResponseBody', () => {
    test('summarizes text responses, usage fields, and stop reason', () => {
      const parsed = parseAnthropicResponseBody(JSON.stringify({
        id: 'msg_123',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      }))

      expect(parsed.summary).toMatchObject({
        parseStatus: 'ok',
        model: 'claude-sonnet-4-20250514',
        messageId: 'msg_123',
        stopReason: 'end_turn',
        contentBlockTypes: ['text'],
        assistantText: 'Done.',
        usage: {
          input: 10,
          output: 3,
          cacheRead: 4,
          cacheCreation: 2,
        },
      })
      expect(publicResponseSummary(parsed.summary)).not.toHaveProperty('body')
    })

    test('handles tool-use blocks, empty content, invalid json, and body refs', () => {
      expect(parseAnthropicResponseBody(JSON.stringify({
        content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        stop_reason: 'tool_use',
      })).summary).toMatchObject({
        contentBlockTypes: ['tool_use'],
        toolUseNames: ['Bash'],
        assistantText: undefined,
        stopReason: 'tool_use',
      })

      expect(parseAnthropicResponseBody(JSON.stringify({ content: [] })).summary).toMatchObject({
        contentBlockTypes: [],
        assistantText: undefined,
      })

      expect(parseAnthropicResponseBody('{bad json', {
        body_ref: 's3://bucket/response.json',
      }).summary).toMatchObject({
        parseStatus: 'invalid_json',
        bodyRef: 's3://bucket/response.json',
      })
    })
  })
})
