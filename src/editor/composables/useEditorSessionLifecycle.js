import { computed } from 'vue'
import { loadSession, saveSession } from '../../services/session.js'
import { createSessionPersist, createSessionSnapshot } from '../sessionPersist.js'
import { loadSessionEntries, normalizeSessionEntries } from '../sessionRestore.js'

export function useEditorSessionLifecycle({
  fileManager,
  openFiles,
  activeFileIndex,
  readFile,
  getZoomLevel,
  setZoomLevel,
  flushEditorContent,
  onError,
}) {
  const recentFiles = computed(() => fileManager.recentFiles)
  const zoomLevel = computed(() => getZoomLevel())
  let persist = null
  let disposed = false
  let hydrationPromise = Promise.resolve(false)

  function beginMount() {
    disposed = false
  }

  async function hydrate() {
    hydrationPromise = fileManager.hydrateSession(async () => {
      const session = await loadSession()
      if (session?.recentFiles?.length) fileManager.setRecentFiles(session.recentFiles)
      if (session?.openFiles?.length) await restoreSession(session)
      if (!fileManager.hasOpenFiles) fileManager.newFile()
    })
    try {
      return await hydrationPromise
    } catch (error) {
      onError(error)
      if (!fileManager.hasOpenFiles) fileManager.newFile()
      hydrationPromise = Promise.resolve(false)
      return false
    }
  }

  async function restoreSession(session) {
    const restored = normalizeSessionEntries(
      session.openFiles,
      session.activeFileIndex,
    )
    const loadedEntries = await loadSessionEntries(restored.entries, readFile)
    for (const { entry, content, error } of loadedEntries) {
      if (entry.path) {
        if (!error) {
          fileManager.restorePath({
            path: entry.path,
            content: entry.dirty ? entry.content : content,
            dirty: entry.dirty,
            workspacePath: entry.workspacePath,
          })
        } else if (entry.dirty) {
          fileManager.restoreDraft({ content: entry.content })
        }
      } else {
        fileManager.restoreDraft(entry)
      }
    }
    fileManager.activateSessionEntry(restored.activeEntry)
    if (session.zoomLevel) setZoomLevel(session.zoomLevel)
    if (restored.changed) {
      try {
        await saveSession(snapshot())
      } catch (error) {
        console.error('[session] could not persist migrated session', error)
      }
    }
  }

  function startPersistence() {
    if (disposed || persist) return
    persist = createSessionPersist({
      openFiles,
      recentFiles,
      activeFileIndex,
      zoomLevel,
    }, saveSession)
  }

  function snapshot(discardedFiles = []) {
    return createSessionSnapshot({
      openFiles,
      recentFiles,
      activeFileIndex,
      zoomLevel,
    }, { discardedFiles })
  }

  async function flush(discardedFiles = []) {
    const value = snapshot(discardedFiles)
    if (persist) {
      await persist.flush(value)
      return
    }
    await saveSession(value)
  }

  function beforeUnload() {
    flushEditorContent({ bridge: 'flush' })
    if (persist) void persist.flush(snapshot()).catch(onError)
  }

  function awaitReady() {
    return hydrationPromise
  }

  function dispose() {
    disposed = true
    if (!persist) return
    const stop = persist
    persist = null
    void Promise.resolve(stop()).catch(onError)
  }

  return {
    awaitReady,
    beforeUnload,
    beginMount,
    dispose,
    flush,
    hydrate,
    startPersistence,
  }
}
