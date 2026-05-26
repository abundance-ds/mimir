const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

const windowLabel = (() => {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('window') || ''
})()

export function useDocumentBridge({ delay = 650 } = {}) {
  let timer = null
  let latestContent = ''
  let latestPath = ''

  function writeLocalStorage(content, path) {
    try {
      localStorage.setItem('shoulders:doc', content)
      localStorage.setItem('shoulders:doc:path', path || '')
    } catch {}
  }

  async function emitTauri(content, path) {
    if (!isTauri) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('document_context_send', {
        payload: { content, path: path || '', windowLabel },
      })
    } catch (error) {
      console.warn('[editor] document_context_send failed:', error)
    }
  }

  function clearScheduled() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function flush(content = latestContent, path = latestPath) {
    clearScheduled()
    latestContent = content || ''
    latestPath = path || ''
    writeLocalStorage(latestContent, latestPath)
    emitTauri(latestContent, latestPath)
  }

  function schedule(content, path) {
    latestContent = content || ''
    latestPath = path || ''
    clearScheduled()
    timer = setTimeout(() => flush(), delay)
  }

  function dispose() {
    clearScheduled()
  }

  return {
    schedule,
    flush,
    dispose,
  }
}
