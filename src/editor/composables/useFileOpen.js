import { onUnmounted } from 'vue'
import { useFileStore } from '../../stores/files.js'
import { readFile } from '../../services/fileSystem.js'
import { inspectWorkspaceEntry } from '../../services/workspaceFileOperations.js'
import { fallbackOpenEntry } from '../../shared/utils/filePreview.js'

const isTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export function useFileOpen({
  autoStart = true,
  awaitReady = () => Promise.resolve(),
  onOpened = () => {},
  onError = error => console.error('[file-open]', error),
} = {}) {
  const fileStore = useFileStore()
  let unlistenOpenFile = null
  let setupPromise = null
  let drainPromise = null
  let drainRequested = false
  let disposed = false

  async function openPaths(paths) {
    for (const path of paths || []) {
      if (disposed) return
      try {
        let meta
        try { meta = await inspectWorkspaceEntry(path) } catch { /* Outside the workspace. */ }
        meta ||= fallbackOpenEntry(path)
        const kind = meta.openBehavior
        const content = kind === 'text' ? await readFile(path) : ''
        if (disposed) return
        await fileStore.openFile(path, content, { kind, meta })
        if (disposed) return
        onOpened(path)
      } catch (error) {
        // One stale or unreadable path must not block the rest of the queue.
        onError(error)
      }
    }
  }

  function drainPending() {
    drainRequested = true
    if (drainPromise) return drainPromise
    drainPromise = (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      await awaitReady()
      while (drainRequested && !disposed) {
        drainRequested = false
        const pending = await invoke('take_pending_files')
        await openPaths(pending)
      }
    })().finally(() => {
      drainPromise = null
    })
    return drainPromise
  }

  function setup() {
    if (setupPromise) return setupPromise
    setupPromise = (async () => {
      if (!isTauri() || disposed) return false
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      if (disposed) return false

      // Register first. Native launch/open events append to the durable queue
      // and only signal that it should be drained, so no path can fall into a
      // take→listen race.
      const stop = await getCurrentWindow().listen('mimir://open-files-pending', () => {
        void drainPending().catch(onError)
      })
      if (disposed) {
        stop?.()
        return false
      }
      unlistenOpenFile = stop
      await drainPending()
      return true
    })().catch((error) => {
      onError(error)
      return false
    })
    return setupPromise
  }

  if (autoStart) void setup()

  onUnmounted(() => {
    disposed = true
    unlistenOpenFile?.()
    unlistenOpenFile = null
  })

  return { setup, drainPending }
}
