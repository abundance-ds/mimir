import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createAiBridgeFetch } from './bridgeFetch'

vi.mock('./client', () => ({
  createCorrelationId: vi.fn((prefix) => `${prefix}_mock`),
}))

let eventCallbacks = {}
let unlistenFns = []

beforeEach(() => {
  eventCallbacks = {}
  unlistenFns = []
  vi.clearAllMocks()

  listen.mockImplementation((eventName, callback) => {
    eventCallbacks[eventName] = callback
    const unlisten = vi.fn()
    unlistenFns.push(unlisten)
    return Promise.resolve(unlisten)
  })
  invoke.mockResolvedValue(undefined)
})

const CORR_ID = 'chat_1_mock'

function fireChunk(corrId, data) {
  const key = `ai-stream-chunk-${corrId}`
  eventCallbacks[key]?.({ payload: { data } })
}

function fireDone(corrId) {
  const key = `ai-stream-done-${corrId}`
  eventCallbacks[key]?.({})
}

function fireError(corrId, error, status) {
  const key = `ai-stream-error-${corrId}`
  eventCallbacks[key]?.({ payload: { error, status } })
}

describe('createAiBridgeFetch', () => {
  it('returns a function', () => {
    const fetch = createAiBridgeFetch()
    expect(typeof fetch).toBe('function')
  })

  it('invokes ai_proxy_stream with correct request shape', async () => {
    const fetch = createAiBridgeFetch({
      feature: 'review',
      provider: 'openai',
      modelId: 'gpt-4',
      providerModel: 'gpt-4-turbo',
    })

    await fetch('https://api.openai.com/v1/chat', {
      headers: { Authorization: 'Bearer key' },
      body: '{"prompt":"hi"}',
    })

    expect(invoke).toHaveBeenCalledWith('ai_proxy_stream', {
      request: {
        correlationId: CORR_ID,
        feature: 'review',
        provider: 'openai',
        modelId: 'gpt-4',
        providerModel: 'gpt-4-turbo',
        url: 'https://api.openai.com/v1/chat',
        headers: { Authorization: 'Bearer key' },
        body: '{"prompt":"hi"}',
      },
    })
  })

  it('uses constructor args for feature, provider, and modelId', async () => {
    const fetch = createAiBridgeFetch({
      feature: 'summarize',
      provider: 'anthropic',
      modelId: 'claude-3',
      providerModel: 'claude-3-opus',
      correlationPrefix: 'sum',
    })

    await fetch('https://api.anthropic.com/v1/messages', {
      body: '{}',
    })

    expect(invoke).toHaveBeenCalledWith(
      'ai_proxy_stream',
      expect.objectContaining({
        request: expect.objectContaining({
          feature: 'summarize',
          provider: 'anthropic',
          modelId: 'claude-3',
          providerModel: 'claude-3-opus',
          correlationId: 'sum_1_mock',
        }),
      }),
    )
  })
})

describe('event listeners', () => {
  it('registers 3 event listeners before invoking ai_proxy_stream', async () => {
    const callOrder = []
    listen.mockImplementation((eventName, callback) => {
      callOrder.push(`listen:${eventName.split('-')[2]}`)
      eventCallbacks[eventName] = callback
      const unlisten = vi.fn()
      unlistenFns.push(unlisten)
      return Promise.resolve(unlisten)
    })
    invoke.mockImplementation((cmd) => {
      callOrder.push(`invoke:${cmd}`)
      return Promise.resolve()
    })

    const fetch = createAiBridgeFetch()
    await fetch('https://example.com/api', { body: '{}' })

    const listenCalls = callOrder.filter((c) => c.startsWith('listen:'))
    const proxyIdx = callOrder.indexOf('invoke:ai_proxy_stream')
    expect(listenCalls).toHaveLength(3)
    // All listen calls should come before the invoke
    for (const lc of listenCalls) {
      expect(callOrder.indexOf(lc)).toBeLessThan(proxyIdx)
    }
  })

  it('stream chunk enqueues data into ReadableStream', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://example.com/api', { body: '{}' })
    const reader = response.body.getReader()

    fireChunk(CORR_ID, 'hello world')
    fireDone(CORR_ID)

    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(new TextDecoder().decode(value)).toBe('hello world')
  })

  it('stream done closes the stream', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://example.com/api', { body: '{}' })
    const reader = response.body.getReader()

    fireDone(CORR_ID)

    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it('multiple chunks accumulate', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://example.com/api', { body: '{}' })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    fireChunk(CORR_ID, 'chunk1')
    fireChunk(CORR_ID, 'chunk2')
    fireDone(CORR_ID)

    const parts = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(decoder.decode(value))
    }
    expect(parts).toEqual(['chunk1', 'chunk2'])
  })
})

describe('cleanup', () => {
  it('done event triggers cleanup: calls ai_cleanup and all unlisten fns', async () => {
    const fetch = createAiBridgeFetch()
    await fetch('https://example.com/api', { body: '{}' })

    fireDone(CORR_ID)
    // Let microtasks resolve
    await new Promise((r) => setTimeout(r, 0))

    expect(invoke).toHaveBeenCalledWith('ai_cleanup', { correlationId: CORR_ID })
    for (const fn of unlistenFns) {
      expect(fn).toHaveBeenCalled()
    }
  })

  it('cleanup is idempotent (double-done does not crash)', async () => {
    const fetch = createAiBridgeFetch()
    await fetch('https://example.com/api', { body: '{}' })

    fireDone(CORR_ID)
    fireDone(CORR_ID)
    // No error thrown
    await new Promise((r) => setTimeout(r, 0))

    // ai_cleanup should be called once for the actual cleanup, second is a no-op
    const cleanupCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'ai_cleanup',
    )
    expect(cleanupCalls).toHaveLength(1)
  })
})

describe('error handling', () => {
  it('stream error errors the ReadableStream', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://example.com/api', { body: '{}' })
    const reader = response.body.getReader()

    fireError(CORR_ID, 'rate limit exceeded', 429)

    await expect(reader.read()).rejects.toThrow('rate limit exceeded')
  })

  it('invoke failure throws Error', async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === 'ai_proxy_stream') return Promise.reject('backend crashed')
      return Promise.resolve()
    })

    const fetch = createAiBridgeFetch()
    await expect(
      fetch('https://example.com/api', { body: '{}' }),
    ).rejects.toThrow('backend crashed')
  })
})

describe('AbortSignal', () => {
  it('pre-aborted signal throws DOMException with name AbortError', async () => {
    const controller = new AbortController()
    controller.abort()

    const fetch = createAiBridgeFetch()
    try {
      await fetch('https://example.com/api', { signal: controller.signal, body: '{}' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException)
      expect(err.name).toBe('AbortError')
    }
  })

  it('mid-stream abort calls ai_abort', async () => {
    const controller = new AbortController()
    const fetch = createAiBridgeFetch()
    await fetch('https://example.com/api', { signal: controller.signal, body: '{}' })

    controller.abort()
    await new Promise((r) => setTimeout(r, 0))

    expect(invoke).toHaveBeenCalledWith('ai_abort', { correlationId: CORR_ID })
  })

  it('ReadableStream cancel calls ai_abort', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://example.com/api', { body: '{}' })
    const reader = response.body.getReader()

    await reader.cancel()
    await new Promise((r) => setTimeout(r, 0))

    expect(invoke).toHaveBeenCalledWith('ai_abort', { correlationId: CORR_ID })
  })
})

describe('headers and content-type', () => {
  it('converts Headers instance to plain object', async () => {
    const fetch = createAiBridgeFetch()
    const h = new Headers()
    h.set('x-custom', 'value')
    h.set('authorization', 'Bearer tok')

    await fetch('https://example.com/api', { headers: h, body: '{}' })

    expect(invoke).toHaveBeenCalledWith(
      'ai_proxy_stream',
      expect.objectContaining({
        request: expect.objectContaining({
          headers: { 'x-custom': 'value', authorization: 'Bearer tok' },
        }),
      }),
    )
  })

  it('converts array-of-pairs headers to object', async () => {
    const fetch = createAiBridgeFetch()

    await fetch('https://example.com/api', {
      headers: [
        ['content-type', 'application/json'],
        ['x-api-key', 'secret'],
      ],
      body: '{}',
    })

    expect(invoke).toHaveBeenCalledWith(
      'ai_proxy_stream',
      expect.objectContaining({
        request: expect.objectContaining({
          headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
        }),
      }),
    )
  })

  it('content-type is text/event-stream for streaming URL', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1/models/gemini:streamGenerateContent',
      { body: '{}' },
    )

    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('content-type is application/json for non-streaming URL', async () => {
    const fetch = createAiBridgeFetch()
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      body: '{"prompt":"hello"}',
    })

    expect(response.headers.get('content-type')).toBe('application/json')
  })
})
