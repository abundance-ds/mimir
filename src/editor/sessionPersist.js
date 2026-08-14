import { computed, toRaw, watch } from 'vue'

function fileIdentity(file) {
  const raw = toRaw(file)
  if (raw?.path) return `path:${raw.path}`
  if (raw?.draftId) return `draft:${raw.draftId}`
  return raw
}

export function createSessionSnapshot(state, { discardedFiles = [] } = {}) {
  const files = state.openFiles.value
  const activeSourceIndex = state.activeFileIndex.value
  const persistedFiles = []
  const sourceIndexes = []
  // Pinia/Vue may expose the same file as a reactive proxy while the close
  // confirmation retains its raw object. Stable identities keep "Don't Save"
  // authoritative across that boundary.
  const discarded = new Set(discardedFiles.map(fileIdentity))

  for (const [sourceIndex, file] of files.entries()) {
    if (file.kind && file.kind !== 'text') continue
    if (discarded.has(fileIdentity(file))) {
      // "Don't Save" means disk is authoritative for path-backed files and
      // an untitled draft must not resurrect on the next launch.
      if (file.path) {
        persistedFiles.push(pathSessionEntry(file))
        sourceIndexes.push(sourceIndex)
      }
      continue
    }
    if (!file.path && !file.content) continue
    persistedFiles.push(file.path
      ? file.dirty
        ? pathSessionEntry(file, { content: file.content, dirty: true })
        : pathSessionEntry(file)
      : { path: null, content: file.content, draftId: file.draftId })
    sourceIndexes.push(sourceIndex)
  }

  const exactActiveIndex = sourceIndexes.indexOf(activeSourceIndex)
  const nextActiveIndex = sourceIndexes.findIndex(index => index > activeSourceIndex)
  const persistedActiveIndex = exactActiveIndex >= 0
    ? exactActiveIndex
    : nextActiveIndex >= 0
      ? nextActiveIndex
      : Math.max(persistedFiles.length - 1, 0)

  return {
    openFiles: persistedFiles,
    recentFiles: [...state.recentFiles.value],
    activeFileIndex: persistedActiveIndex,
    zoomLevel: state.zoomLevel.value,
  }
}

function pathSessionEntry(file, extra = {}) {
  return {
    path: file.path,
    ...(file.workspacePath ? { workspacePath: file.workspacePath } : {}),
    ...extra,
  }
}

export function createSessionPersist(state, save, { onError = () => {} } = {}) {
  let timer = null
  let writeChain = Promise.resolve()
  let lastError = null

  const snapshot = computed(() => createSessionSnapshot(state))

  const stop = watch(snapshot, (snap) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist(snap).catch((error) => {
        onError(error)
      })
    }, 1000)
  })

  function persist(value) {
    const operation = writeChain
      .catch(() => {})
      .then(() => save(value))
      .then(
        (result) => {
          lastError = null
          return result
        },
        (error) => {
          lastError = error
          throw error
        },
      )
    writeChain = operation
    return operation
  }

  function flush(snapshotOverride = null) {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return persist(snapshotOverride || snapshot.value)
  }

  function cleanup() {
    stop()
    if (timer) {
      return flush()
    }
    return writeChain
  }
  cleanup.flush = flush
  Object.defineProperty(cleanup, 'lastError', {
    get: () => lastError,
  })
  return cleanup
}
