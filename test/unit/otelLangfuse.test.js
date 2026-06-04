const { OtelLangfuse, normalizeEndpoint } = require('../../src/otelLangfuse')

function attrMap(span) {
  return Object.fromEntries(span.attributes.map((attr) => [attr.key, attr.value]))
}

describe('OtelLangfuse', () => {
  test('normalizes Langfuse OTEL trace endpoints', () => {
    expect(normalizeEndpoint('http://langfuse-web:3000')).toBe('http://langfuse-web:3000/api/public/otel/v1/traces')
    expect(normalizeEndpoint('http://langfuse-web:3000/api/public/otel')).toBe('http://langfuse-web:3000/api/public/otel/v1/traces')
    expect(normalizeEndpoint('http://langfuse-web:3000/api/public/otel/v1/traces')).toBe('http://langfuse-web:3000/api/public/otel/v1/traces')
  })

  test('exports trace and generation as OTLP v4 spans', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })
    const client = new OtelLangfuse({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'http://langfuse.local',
      fetch,
    })

    const trace = client.trace({
      name: 'Claude Code turn',
      sessionId: 'session-1',
      userId: 'user@example.com',
      input: { prompt: 'hello' },
      output: { assistantText: 'world' },
      metadata: {
        traceKind: 'turn',
        sessionDurationSeconds: 121,
      },
      version: '2.1.162',
    })

    client.generation({
      name: 'LLM: claude-opus-4-8',
      traceId: trace.id,
      model: 'claude-opus-4-8',
      input: { prompt: 'hello' },
      output: { assistantText: 'world' },
      usage: {
        input: 10,
        output: 2,
        total: 12,
        unit: 'TOKENS',
      },
      metadata: {
        observationKind: 'generation',
        cost: 0.01,
      },
      level: 'DEFAULT',
    })

    await client.flushAsync()

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('http://langfuse.local/api/public/otel/v1/traces')
    expect(request.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Basic /),
      'Content-Type': 'application/json',
      'x-langfuse-ingestion-version': '4',
    })

    const body = JSON.parse(request.body)
    const spans = body.resourceSpans[0].scopeSpans[0].spans
    expect(spans).toHaveLength(2)

    const rootSpan = spans.find((span) => span.name === 'Claude Code turn')
    const generationSpan = spans.find((span) => span.name === 'LLM: claude-opus-4-8')
    expect(rootSpan).toBeDefined()
    expect(generationSpan).toBeDefined()
    expect(generationSpan.parentSpanId).toBe(rootSpan.spanId)
    expect(generationSpan.traceId).toBe(rootSpan.traceId)

    const rootAttrs = attrMap(rootSpan)
    expect(rootAttrs['langfuse.trace.name'].stringValue).toBe('Claude Code turn')
    expect(rootAttrs['langfuse.session.id'].stringValue).toBe('session-1')
    expect(rootAttrs['langfuse.user.id'].stringValue).toBe('user@example.com')
    expect(rootAttrs['langfuse.environment'].stringValue).toBe('default')
    expect(rootAttrs['langfuse.trace.input'].stringValue).toBe(JSON.stringify({ prompt: 'hello' }))
    expect(rootAttrs['langfuse.trace.metadata.traceKind'].stringValue).toBe('turn')
    expect(rootAttrs['langfuse.trace.metadata.sessionDurationSeconds'].intValue).toBe('121')

    const generationAttrs = attrMap(generationSpan)
    expect(generationAttrs['langfuse.trace.name'].stringValue).toBe('Claude Code turn')
    expect(generationAttrs['langfuse.session.id'].stringValue).toBe('session-1')
    expect(generationAttrs['langfuse.observation.type'].stringValue).toBe('generation')
    expect(generationAttrs['langfuse.observation.model.name'].stringValue).toBe('claude-opus-4-8')
    expect(generationAttrs['langfuse.observation.input'].stringValue).toBe(JSON.stringify({ prompt: 'hello' }))
    expect(generationAttrs['langfuse.observation.output'].stringValue).toBe(JSON.stringify({ assistantText: 'world' }))
    expect(JSON.parse(generationAttrs['langfuse.observation.usage_details'].stringValue)).toMatchObject({
      input: 10,
      output: 2,
      total: 12,
    })
    expect(JSON.parse(generationAttrs['langfuse.observation.cost_details'].stringValue)).toEqual({ total: 0.01 })
  })

  test('does not export generation until output or end is available', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    const client = new OtelLangfuse({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'http://langfuse.local',
      fetch,
    })
    const trace = client.trace({ name: 'Claude Code turn', sessionId: 'session-1' })
    const generation = client.generation({
      name: 'LLM: claude-opus-4-8',
      traceId: trace.id,
      model: 'claude-opus-4-8',
      input: { prompt: 'hello' },
    })

    await client.flushAsync()
    expect(fetch).toHaveBeenCalledTimes(1)
    let spans = JSON.parse(fetch.mock.calls[0][1].body).resourceSpans[0].scopeSpans[0].spans
    expect(spans.map((span) => span.name)).toEqual(['Claude Code turn'])

    generation.update({ output: { assistantText: 'world' } })
    await client.flushAsync()
    expect(fetch).toHaveBeenCalledTimes(2)
    spans = JSON.parse(fetch.mock.calls[1][1].body).resourceSpans[0].scopeSpans[0].spans
    expect(spans.map((span) => span.name).sort()).toEqual(['Claude Code turn', 'LLM: claude-opus-4-8'])
  })

  test('does not mark observations created during an in-flight flush as exported', async () => {
    const resolvers = []
    const fetch = jest.fn(() => new Promise((resolve) => resolvers.push(resolve)))
    const client = new OtelLangfuse({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'http://langfuse.local',
      fetch,
    })
    const trace = client.trace({
      name: 'Claude Code turn',
      sessionId: 'session-1',
      input: { prompt: 'hello' },
    })

    const firstFlush = client.flushAsync()
    expect(fetch).toHaveBeenCalledTimes(1)

    trace.update({ output: { assistantText: 'world' } })
    const rawEvent = client.event({
      name: 'Raw API request',
      traceId: trace.id,
      input: { body: '{"model":"claude"}' },
    })
    const generation = client.generation({
      name: 'LLM: claude-opus-4-8',
      traceId: trace.id,
      model: 'claude-opus-4-8',
      input: { prompt: 'hello' },
      output: { assistantText: 'world' },
    })

    resolvers[0]({ ok: true, status: 200 })
    await firstFlush

    expect(trace.dirty).toBe(true)
    expect(rawEvent.dirty).toBe(true)
    expect(generation.dirty).toBe(true)

    const secondFlush = client.flushAsync()
    expect(fetch).toHaveBeenCalledTimes(2)
    resolvers[1]({ ok: true, status: 200 })
    await secondFlush

    const spans = JSON.parse(fetch.mock.calls[1][1].body).resourceSpans[0].scopeSpans[0].spans
    expect(spans.map((span) => span.name).sort()).toEqual(['Claude Code turn', 'LLM: claude-opus-4-8', 'Raw API request'])
    expect(trace.dirty).toBe(false)
    expect(rawEvent.dirty).toBe(false)
    expect(generation.dirty).toBe(false)
  })
})
