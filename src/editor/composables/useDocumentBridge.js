export function useDocumentBridge({ delay = 650 } = {}) {
  let timer = null
  let latestContent = ''
  let latestPath = ''

  function writeLocalStorage(content, path) {
    try {
      localStorage.setItem('mimir:doc', content)
      localStorage.setItem('mimir:doc:path', path || '')
    } catch {}
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
