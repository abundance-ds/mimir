export function useExternalFileSync({
  fileManager,
  readFile,
  onReloaded = () => {},
  onError = error => console.error('[external-file-sync]', error),
}) {
  const unlisteners = []
  const refreshVersions = new Map()
  let startPromise = null
  let disposed = false

  function start() {
    if (startPromise) return startPromise
    startPromise = bindNativeEvents()
    return startPromise
  }

  async function bindNativeEvents() {
    if (!hasTauriRuntime() || disposed) return false
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const registrations = await Promise.all([
        listen('mim://file-updated', event => {
          applyEventContent(event.payload)
        }),
        listen('mim://workspace-files-changed', event => {
          void refreshChangedPaths(event.payload).catch(onError)
        }),
      ])
      if (disposed) {
        registrations.forEach(stop => stop())
        return false
      }
      unlisteners.push(...registrations)
      return true
    } catch (error) {
      onError(error)
      return false
    }
  }

  function applyEventContent(payload = {}) {
    const path = String(payload.path || '')
    if (!path || typeof payload.content !== 'string') return false
    const file = findOpenTextFile(path)
    if (!file) return false
    nextRefreshVersion(path)
    return applyCleanContent(file, path, payload.content)
  }

  async function refreshChangedPaths(payload = {}) {
    const changed = new Set(
      (Array.isArray(payload.paths) ? payload.paths : [])
        .map(normalizePath)
        .filter(Boolean),
    )
    if (!changed.size || disposed) return []

    const refreshes = []
    for (const file of fileManager.openFiles) {
      if (!isCleanTextFile(file) || !changed.has(normalizePath(file.path))) continue
      const path = file.path
      const version = nextRefreshVersion(path)
      refreshes.push(
        Promise.resolve(readFile(path))
          .then(content => applyCleanContent(file, path, content, version))
          .catch(error => {
            onError(error)
            return false
          }),
      )
    }
    return Promise.all(refreshes)
  }

  function applyCleanContent(file, path, content, version = null) {
    const key = normalizePath(path)
    if (
      disposed
      || (version !== null && refreshVersions.get(key) !== version)
      || !fileManager.openFiles.includes(file)
      || normalizePath(file.path) !== key
      || !isCleanTextFile(file)
    ) {
      return false
    }
    const changed = fileManager.replaceCleanContent(file, content)
    if (changed) onReloaded(file)
    return changed
  }

  function findOpenTextFile(path) {
    const key = normalizePath(path)
    return fileManager.openFiles.find(file => (
      normalizePath(file.path) === key && isCleanTextFile(file)
    )) || null
  }

  function nextRefreshVersion(path) {
    const key = normalizePath(path)
    const version = (refreshVersions.get(key) || 0) + 1
    refreshVersions.set(key, version)
    return version
  }

  function dispose() {
    disposed = true
    refreshVersions.clear()
    unlisteners.splice(0).forEach(stop => stop())
  }

  return {
    applyEventContent,
    dispose,
    refreshChangedPaths,
    start,
  }
}

function isCleanTextFile(file) {
  return Boolean(file?.path) && file.kind === 'text' && !file.dirty
}

function normalizePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+$/, '')
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}
