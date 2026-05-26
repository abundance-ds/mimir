import { createAppRuntime } from './runtime.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

function appModuleUrl(appId) {
  if (!isTauri) return null
  return navigator.userAgent.includes('Windows')
    ? `https://app.localhost/${appId}/index.js`
    : `app://localhost/${appId}/index.js`
}

export function createAppHandle(app, callbacks = {}, context = {}) {
  const controller = new AbortController()
  let _promise = null

  return {
    start() {
      _promise = runAppWithAbort(app, controller, callbacks, context)
      return _promise
    },
    cancel() {
      controller.abort()
    },
    get promise() {
      return _promise
    },
  }
}

async function runAppWithAbort(app, controller, { onProgress, onComplete, onError } = {}, context = {}) {
  const events = []
  function handleProgress(event) {
    events.push(event)
    onProgress?.(event, events)
  }

  handleProgress({ type: 'step', name: 'Starting', time: Date.now() })

  try {
    const baseUrl = appModuleUrl(app.id) || app.entryPath
    const url = `${baseUrl}?t=${Date.now()}`

    const mod = await import(/* @vite-ignore */ url)
    if (typeof mod.run !== 'function') {
      throw new Error(`App "${app.name}" does not export a run() function`)
    }

    const ctx = createAppRuntime(app, {
      onProgress: handleProgress,
      signal: controller.signal,
      project: context.project || null,
      inputs: context.inputs || {},
      docxPath: context.docxPath || null,
    })

    const result = await mod.run(ctx)

    const summary = {
      appId: app.id,
      appName: app.name,
      status: 'completed',
      result,
      usage: ctx.usage,
      events,
      startedAt: events[0]?.time,
      completedAt: Date.now(),
    }
    onComplete?.(summary)
    return summary
  } catch (err) {
    const status = controller.signal.aborted ? 'aborted' : 'failed'
    const summary = {
      appId: app.id,
      appName: app.name,
      status,
      error: status === 'aborted' ? 'App was cancelled' : (err.message || String(err)),
      events,
      startedAt: events[0]?.time,
      completedAt: Date.now(),
    }
    onError?.(summary)
    return summary
  }
}
