import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createCorrelationId } from './client'

function headersToObject(headers) {
  const out = {}
  if (!headers) return out

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value
    })
    return out
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value
    return out
  }

  return { ...headers }
}

function requestBodyToString(body) {
  if (!body) return ''
  if (typeof body === 'string') return body
  return JSON.stringify(body)
}

function isStreamingProviderRequest(url, body) {
  const rawUrl = url.toString()
  if (rawUrl.includes('streamGenerateContent')) return true

  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : null
    return parsed?.stream === true
  } catch {
    return false
  }
}

export function createAiBridgeFetch({
  feature = 'chat',
  provider,
  modelId,
  providerModel,
  correlationPrefix = 'chat',
} = {}) {
  let counter = 0

  return async function aiBridgeFetch(url, options = {}) {
    const body = requestBodyToString(options.body)
    const stream = isStreamingProviderRequest(url, body)
    const correlationId = createCorrelationId(`${correlationPrefix}_${++counter}`)
    const headers = headersToObject(options.headers)

    const encoder = new TextEncoder()
    const unlisteners = []
    let streamController
    let cleaned = false
    let errorStatus = 0

    function cleanup() {
      if (cleaned) return
      cleaned = true
      for (const unlisten of unlisteners) {
        try { unlisten() } catch {}
      }
      unlisteners.length = 0
      invoke('ai_cleanup', { correlationId }).catch(() => {})
    }

    const unChunk = await listen(`ai-stream-chunk-${correlationId}`, (event) => {
      try {
        const data = event.payload?.data || ''
        if (data) streamController?.enqueue(encoder.encode(data))
      } catch {
        cleanup()
      }
    })
    unlisteners.push(unChunk)

    const unDone = await listen(`ai-stream-done-${correlationId}`, () => {
      try {
        streamController?.close()
      } catch {}
      cleanup()
    })
    unlisteners.push(unDone)

    const unError = await listen(`ai-stream-error-${correlationId}`, (event) => {
      const message = event.payload?.error || 'AI stream failed'
      errorStatus = event.payload?.status || 0
      try {
        streamController?.error(new Error(message))
      } catch {}
      cleanup()
    })
    unlisteners.push(unError)

    const readableStream = new ReadableStream({
      start(controller) {
        streamController = controller
      },
      cancel() {
        invoke('ai_abort', { correlationId }).catch(() => {})
        cleanup()
      },
    })

    if (options.signal) {
      if (options.signal.aborted) {
        cleanup()
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      options.signal.addEventListener('abort', () => {
        invoke('ai_abort', { correlationId }).catch(() => {})
        try { streamController?.close() } catch {}
        cleanup()
      }, { once: true })
    }

    try {
      await invoke('ai_proxy_stream', {
        request: {
          correlationId,
          feature,
          provider,
          modelId,
          providerModel,
          url: url.toString(),
          headers,
          body,
        },
      })
    } catch (error) {
      cleanup()
      throw new Error(String(error))
    }

    return new Response(readableStream, {
      status: errorStatus || 200,
      headers: {
        'Content-Type': stream ? 'text/event-stream' : 'application/json',
      },
    })
  }
}
