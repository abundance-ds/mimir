import { computed } from 'vue'
import { useProjectHomeStore } from '../../stores/projectHome.js'
import { loadSession, saveSession } from '../../services/session.js'
import { createSessionPersist, createSessionSnapshot } from '../sessionPersist.js'
import { loadSessionEntries, normalizeSessionEntries } from '../sessionRestore.js'
import { graphSource } from '../../services/businessGraph.js'
import { graphDocumentState, isGraphSourceCandidate, restoredGraphState } from '../../stores/graphDocuments.js'

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
  const home = useProjectHomeStore()
  const homeDrafts = computed(() => home.drafts)
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
      home.restore(session?.homeDrafts)
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
    const entriesByPath = new Map(restored.entries.filter(entry => entry.path).map(entry => [entry.path, entry]))
    const graphSources = new Map()
    const loadedEntries = await loadSessionEntries(restored.entries, async path => {
      const entry = entriesByPath.get(path)
      if (entry.graph || isGraphSourceCandidate(path)) {
        const source = await graphSource(path)
        graphSources.set(path, source || null)
        if (source) return source.content
        // A known Graph source can be unmounted during bootstrap. Keep its
        // identity until the Graph mount refreshes it; never use a generic save.
        if (entry.graph) return entry.content || ''
      }
      return readFile(path)
    })
    for (const { entry, content, error } of loadedEntries) {
      if (entry.path) {
        if (!error) {
          const source = graphSources.get(entry.path)
          const graph = entry.dirty && entry.graph
            ? { ...restoredGraphState(entry.graph), unavailable: !source }
            : source ? graphDocumentState(source)
              : entry.graph ? { ...restoredGraphState(entry.graph), unavailable: true } : null
          if (entry.dirty && source && !entry.graph) graph.sourceRevision = ''
          fileManager.restorePath({
            path: entry.path,
            content: entry.dirty ? entry.content : content,
            savedContent: entry.graph && !source ? null : content,
            dirty: entry.dirty,
            workspacePath: entry.workspacePath,
            graph,
            kind: source && !source.node && !entry.dirty ? 'text' : entry.kind || 'text',
          })
        } else if (entry.graph) {
          fileManager.restorePath({
            ...entry, content: entry.content || '',
            graph: { ...entry.graph, unavailable: true },
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
      homeDrafts,
      recentFiles,
      activeFileIndex,
      zoomLevel,
    }, saveSession)
  }

  function snapshot(discardedFiles = []) {
    return createSessionSnapshot({
      openFiles,
      homeDrafts,
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
