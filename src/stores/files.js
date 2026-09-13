import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useScratchpadStore } from './scratchpad.js'
import { resolveScratchpad } from '../services/scratchpad.js'
import { openFileDialog, saveFileDialog, saveFile } from '../services/fileSystem.js'
import { SAVE_STATE } from '../shared/saveState.js'
import { getGraphNode, graphSource, saveGraphSource } from '../services/businessGraph.js'
import { useBusinessGraphStore } from './businessGraph.js'
import { cloneGraphDocument, graphDocumentState, graphExportContent, isGraphSourceCandidate, restoredGraphState, writeGraphDocument, GRAPH_UNAVAILABLE } from './graphDocuments.js'

const RECENT_LIMIT = 12
let nextFileId = 1
let nextDraftId = 1

export const useFileStore = defineStore('files', () => {
  const scratchpad = useScratchpadStore()
  const openFiles = ref([])
  const recentFiles = ref([])
  const workspaceProjectionEnabled = ref(false)
  const workspaceScope = ref('')
  const knownWorkspacePaths = ref([])
  // Each entry: { id, path, content, dirty, saveState, saveError }
  // path is null for unsaved/new files

  const activeFileIndex = ref(0)
  const sessionHydrated = ref(false)
  let sessionHydrationPromise = null
  const writesByFileId = new Map()
  const graphSaveTimers = new Map()
  const pausedGraphSaves = new Set()
  const graphRefreshVersions = new Map()

  const visibleOpenFiles = computed(() => openFiles.value.filter(isFileVisible))
  const visibleRecentFiles = computed(() => {
    if (!workspaceProjectionEnabled.value) return recentFiles.value
    if (!workspaceScope.value) return []
    return recentFiles.value.filter(path => workspaceForPath(path) === workspaceScope.value)
  })
  const activeVisibleFileIndex = computed(() => {
    const file = openFiles.value[activeFileIndex.value]
    return file && isFileVisible(file) ? visibleOpenFiles.value.indexOf(file) : -1
  })
  const currentFile = computed(() => {
    const file = openFiles.value[activeFileIndex.value]
    return file && isFileVisible(file) ? file : null
  })

  function setWorkspaceScope(path, workspacePaths = []) {
    const nextScope = normalizeWorkspacePath(path)
    const scopeChanged = !workspaceProjectionEnabled.value || workspaceScope.value !== nextScope
    workspaceProjectionEnabled.value = true
    workspaceScope.value = nextScope
    knownWorkspacePaths.value = normalizeWorkspacePaths([
      path,
      ...(Array.isArray(workspacePaths) ? workspacePaths : []),
    ])
    reconcileWorkspaceOwnership()
    // Workspace bootstrap must not create a fallback before saved tabs load.
    if (!sessionHydrated.value && !openFiles.value.length) return
    if (!ensureWorkspaceSelection({ preferScoped: scopeChanged })) {
      newFile()
    }
  }

  function clearWorkspaceScope() {
    workspaceProjectionEnabled.value = false
    workspaceScope.value = ''
    knownWorkspacePaths.value = []
    ensureWorkspaceSelection()
  }

  function workspaceForPath(path) {
    return owningWorkspacePath(path, knownWorkspacePaths.value)
  }

  function workspaceForFile(file) {
    if (file?.path && file.path === scratchpad.path) return null
    if (!file?.path) return ''
    return owningWorkspacePath(file.path, [
      file.workspacePath,
      ...knownWorkspacePaths.value,
    ])
  }

  function reconcileWorkspaceOwnership() {
    for (const file of openFiles.value) {
      if (!file.path) continue
      const owner = workspaceForFile(file)
      if (owner) file.workspacePath = owner
    }
  }

  function isFileVisible(file) {
    if (file?.path && file.path === scratchpad.path) return true
    if (!workspaceProjectionEnabled.value) return true
    const owner = workspaceForFile(file)
    return !owner || owner === workspaceScope.value
  }

  function pathIsVisible(path) {
    if (!workspaceProjectionEnabled.value) return true
    const openFile = openFiles.value.find(file => (
      normalizeWorkspacePath(file.path) === normalizeWorkspacePath(path)
    ))
    const owner = openFile ? workspaceForFile(openFile) : workspaceForPath(path)
    return !owner || owner === workspaceScope.value
  }

  function ensureWorkspaceSelection({ preferScoped = false } = {}) {
    if (!workspaceProjectionEnabled.value) {
      if (!currentFile.value && openFiles.value.length) activeFileIndex.value = 0
      return Boolean(currentFile.value)
    }
    const active = openFiles.value[activeFileIndex.value]
    const scopedIndex = openFiles.value.findIndex(file => (
      workspaceForFile(file) === workspaceScope.value
    ))
    if (!preferScoped && active && isFileVisible(active)) return true
    const visibleIndex = scopedIndex >= 0
      ? scopedIndex
      : openFiles.value.findIndex(isFileVisible)
    if (visibleIndex >= 0) activeFileIndex.value = visibleIndex
    return visibleIndex >= 0
  }

  function makeFile({
    path,
    content = '',
    dirty = false,
    newTab = false,
    draftId = null,
    kind = 'text',
    preview = false,
    meta = null,
    workspacePath,
  }) {
    const owner = path
      ? owningWorkspacePath(path, [workspacePath, ...knownWorkspacePaths.value])
      : ''
    return {
      scratchpadBase: path && path === scratchpad.path ? content : undefined,
      id: nextFileId++,
      path,
      draftId: path ? null : (draftId || createDraftId()),
      content,
      dirty,
      newTab,
      kind,
      preview,
      meta,
      workspacePath: owner,
      saveState: dirty ? SAVE_STATE.dirty : SAVE_STATE.idle,
      saveError: null,
      reviews: null,
    }
  }

  function markFileDirty(file) {
    file.dirty = true
    file.saveState = SAVE_STATE.dirty
    file.saveError = null
  }

  function normalizeSaveError(error) {
    return error instanceof Error ? error.message : String(error || 'Save failed')
  }

  async function writeFile(file, { graphOperation = null } = {}) {
    if (!file?.path) return false
    const targetPath = file.path
    const targetContent = file.content
    const graphSnapshot = file.graph ? {
      graph: cloneGraphDocument(file.graph), content: targetContent, kind: graphOperation || file.kind, path: targetPath,
    } : null
    const previous = writesByFileId.get(file.id) || Promise.resolve()
    file.saveState = SAVE_STATE.saving
    file.saveError = null
    let operation
    const execute = async () => {
        try {
          if (graphSnapshot) {
            // A title/body save queued during close Undo must retain Undo's
            // reopened status unless this draft changed status itself.
            if (graphSnapshot.kind === 'graph' && graphSnapshot.graph.node?.kind === 'issue'
              && graphSnapshot.graph.draft.status === graphSnapshot.graph.node.properties?.status) {
              graphSnapshot.graph.draft.status = file.graph.node?.properties?.status || 'backlog'
            }
            graphSnapshot.graph.node = cloneGraphDocument(file.graph.node)
            graphSnapshot.graph.sourceRevision = file.graph.sourceRevision
            graphSnapshot.path = file.path
            const result = await writeGraphDocument(file, graphSnapshot, useBusinessGraphStore().nodes)
            file.path = result.path
            const latest = graphDocumentState(result.document)
            const unchanged = file.graph.version === graphSnapshot.graph.version
              && (graphSnapshot.kind !== 'text' || file.content === targetContent)
            let currentDraft = file.graph.draft
            if (graphSnapshot.kind === 'undo-close' && !unchanged) {
              currentDraft = Object.fromEntries(Object.entries(currentDraft).map(([key, value]) => [
                key,
                JSON.stringify(value) === JSON.stringify(graphSnapshot.graph.draft[key])
                  ? cloneGraphDocument(latest.draft[key]) : value,
              ]))
            }
            const version = file.graph.version
            const isLatestWrite = writesByFileId.get(file.id) === operation
            const previousStatus = graphSnapshot.graph.node?.properties?.status
            const closed = status => ['done', 'cancelled'].includes(status)
            const closedUndo = graphSnapshot.kind === 'graph' && latest.node?.kind === 'issue'
              && !closed(previousStatus) && closed(latest.node.properties?.status)
              ? {
                  nodeId: latest.node.id, status: previousStatus || 'backlog',
                  rank: graphSnapshot.graph.node.properties?.rank ?? null,
                  sourcePath: result.path, sourceRevision: latest.sourceRevision,
                }
              : file.graph.closedUndo?.sourceRevision === latest.sourceRevision ? file.graph.closedUndo : null
            Object.assign(file.graph, latest, {
              draft: unchanged ? latest.draft : currentDraft,
              nodeId: latest.nodeId || file.graph.nodeId || graphSnapshot.graph.node?.id,
              version, closedUndo,
            })
            if (unchanged || file.kind === 'graph') file.content = result.document.content
            file.dirty = !unchanged || !isLatestWrite
            file.saveState = isLatestWrite ? (unchanged ? SAVE_STATE.saved : SAVE_STATE.dirty) : SAVE_STATE.saving
            file.saveError = null
            if (!unchanged && isLatestWrite && file.kind === 'graph') scheduleGraphSave(file)
            return unchanged
          } else if (targetPath === scratchpad.path) {
            await scratchpad.save(targetContent, file.scratchpadBase ?? file.content)
            file.scratchpadBase = targetContent
          } else {
            await saveFile(targetPath, targetContent)
          }
          addRecentFile(targetPath)
          const isLatestWrite = writesByFileId.get(file.id) === operation
          const isCurrentSnapshot = file.path === targetPath && file.content === targetContent
          if (isLatestWrite) {
            file.dirty = !isCurrentSnapshot
            file.saveState = isCurrentSnapshot ? SAVE_STATE.saved : SAVE_STATE.dirty
            file.saveError = null
          }
          return isCurrentSnapshot
        } catch (error) {
          if (writesByFileId.get(file.id) === operation) {
            file.dirty = graphSnapshot?.kind !== 'undo-close'
              || file.graph.version !== graphSnapshot.graph.version
            file.saveState = SAVE_STATE.failed
            file.saveError = normalizeSaveError(error)
          }
          throw error
        }
      }
    operation = writesByFileId.has(file.id)
      ? previous.catch(() => {}).then(execute)
      : execute()
    operation = operation
      .finally(() => {
        if (writesByFileId.get(file.id) === operation) {
          writesByFileId.delete(file.id)
        }
      })
    writesByFileId.set(file.id, operation)
    return operation
  }

  const tabList = computed(() => {
    let untitledCount = 0
    return openFiles.value.map((f) => {
      const untitledIndex = f.path ? 0 : ++untitledCount
      return {
        id: f.id,
        name: f.path ? f.path.split('/').pop() : (untitledIndex === 1 ? 'Untitled.md' : `Untitled-${untitledIndex}.md`),
        dirty: f.dirty,
        saveState: f.saveState ?? (f.dirty ? SAVE_STATE.dirty : SAVE_STATE.idle),
      }
    })
  })

  const hasOpenFiles = computed(() => openFiles.value.length > 0)

  function addRecentFile(path) {
    if (!path) return
    if (path === scratchpad.path) return
    recentFiles.value = [
      path,
      ...recentFiles.value.filter((p) => p !== path),
    ].slice(0, RECENT_LIMIT)
  }

  function removeRecentFile(path) {
    if (!path) return
    recentFiles.value = recentFiles.value.filter((p) => p !== path)
  }

  function setRecentFiles(paths = []) {
    const seen = new Set()
    recentFiles.value = paths
      .filter(Boolean)
      .filter((path) => {
        if (seen.has(path)) return false
        seen.add(path)
        return true
      })
      .slice(0, RECENT_LIMIT)
  }

  function clearVisibleRecentFiles() {
    if (!workspaceProjectionEnabled.value) {
      recentFiles.value = []
      return
    }
    recentFiles.value = recentFiles.value.filter(path => (
      workspaceForPath(path) !== workspaceScope.value
    ))
  }

  // Open a file from disk path. If already open, just switch to it.
  // If the active tab is a newTab landing page, replace it in-place.
  async function openFile(path, content, {
    kind = 'text',
    preview = false,
    meta = null,
    workspacePath,
    graphDocument = null,
    isCurrent = () => true,
  } = {}) {
    if (path?.endsWith('/scratchpad.md') && typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      const canonical = await resolveScratchpad(path)
      if (canonical) {
        path = canonical
        preview = false
        meta = { ...meta, scratchpad: true }
      }
    }
    const open = openFiles.value.find(file => file.path === path)
    if (!open?.graph && !graphDocument && kind === 'text' && isGraphSourceCandidate(path)) {
      graphDocument = await graphSource(path)
    }
    if (!isCurrent()) return null
    // Recheck after native classification: concurrent opens share one tab.
    const active = currentFile.value
    const existingIdx = openFiles.value.findIndex(f => f.path === path)
    if (existingIdx !== -1) {
      if (active?.newTab) {
        const activeIdx = activeFileIndex.value
        openFiles.value.splice(activeIdx, 1)
        if (existingIdx > activeIdx) activeFileIndex.value = existingIdx - 1
        else activeFileIndex.value = existingIdx
      } else {
        activeFileIndex.value = existingIdx
      }
      const existing = openFiles.value[activeFileIndex.value]
      // Selecting an already-open path must not replace its rich draft or mode.
      if (!existing.graph) {
        if (graphDocument) {
          existing.graph = graphDocumentState(graphDocument)
          if (existing.dirty) {
            // This buffer predates Graph classification. Do not invent a
            // current-disk baseline for older unsaved source text.
            existing.graph.sourceRevision = ''
            existing.kind = 'text'
          } else {
            existing.content = graphDocument.content
            existing.kind = kind === 'graph' && graphDocument.node ? 'graph' : 'text'
          }
        } else existing.kind = kind
        existing.meta = meta
      }
      if (!preview) existing.preview = false
      const owner = owningWorkspacePath(path, [workspacePath, ...knownWorkspacePaths.value])
      if (owner) existing.workspacePath = owner
      addRecentFile(path)
      return existing
    }

    if (graphDocument) {
      content = graphDocument.content
      if (!graphDocument.node) kind = 'text'
    }
    const reusablePreviewIndex = preview
      ? openFiles.value.findIndex(file => file.preview && !file.dirty && !file.reviewPending && !file.reviews?.length && !writesByFileId.has(file.id) && isFileVisible(file))
      : -1
    const replacementIndex = active?.newTab
      ? activeFileIndex.value
      : reusablePreviewIndex
    if (replacementIndex >= 0) {
      const replacement = openFiles.value[replacementIndex]
      replacement.path = path
      replacement.draftId = null
      replacement.content = content
      replacement.scratchpadBase = path === scratchpad.path ? content : undefined
      replacement.newTab = false
      replacement.kind = kind
      replacement.preview = preview
      replacement.previewView = null
      replacement.previewRevision = 0
      replacement.meta = meta
      clearTimeout(graphSaveTimers.get(replacement.id))
      graphSaveTimers.delete(replacement.id)
      pausedGraphSaves.delete(replacement.id)
      graphRefreshVersions.delete(replacement.id)
      replacement.graph = graphDocument ? graphDocumentState(graphDocument) : null
      replacement.workspacePath = owningWorkspacePath(path, [
        workspacePath,
        ...knownWorkspacePaths.value,
      ])
      replacement.dirty = false
      replacement.saveState = SAVE_STATE.idle
      replacement.saveError = null
      replacement.reviews = null
      activeFileIndex.value = replacementIndex
      addRecentFile(path)
      return replacement
    }

    const file = makeFile({ path, content, kind, preview, meta, workspacePath })
    if (graphDocument) file.graph = graphDocumentState(graphDocument)
    openFiles.value.push(file)
    activeFileIndex.value = openFiles.value.length - 1
    addRecentFile(path)
    return file
  }

  // Create a new untitled file (Cmd+N — straight to blank editor)
  function newFile() {
    openFiles.value.push(makeFile({ path: null, content: '' }))
    activeFileIndex.value = openFiles.value.length - 1
  }

  // Open a new tab with the landing page (Cmd+T)
  function newTab() {
    openFiles.value.push(makeFile({ path: null, content: '', newTab: true }))
    activeFileIndex.value = openFiles.value.length - 1
  }

  function restoreDraft({ content = '', draftId = null } = {}) {
    const file = makeFile({
      path: null,
      content: String(content),
      dirty: Boolean(content),
      draftId,
    })
    openFiles.value.push(file)
    activeFileIndex.value = openFiles.value.length - 1
    return file
  }

  function restorePath({ path, content = '', dirty = false, workspacePath, graph = null, kind = 'text' } = {}) {
    if (!path) return null
    const existing = openFiles.value.find((file) => file.path === path)
    if (existing) {
      activeFileIndex.value = openFiles.value.indexOf(existing)
      return existing
    }
    const file = makeFile({
      path,
      content: String(content),
      dirty: Boolean(dirty),
      workspacePath,
      kind,
    })
    file.graph = graph ? restoredGraphState(graph) : null
    if (file.graph?.unavailable) {
      file.saveState = SAVE_STATE.failed
      file.saveError = GRAPH_UNAVAILABLE
    }
    openFiles.value.push(file)
    activeFileIndex.value = openFiles.value.length - 1
    return file
  }

  function hydrateSession(hydrate) {
    collapseLegacyDuplicateDrafts()
    if (sessionHydrationPromise) return sessionHydrationPromise
    if (sessionHydrated.value || openFiles.value.length > 0) {
      sessionHydrated.value = true
      return Promise.resolve(false)
    }

    const beforeFiles = [...openFiles.value]
    const beforeRecent = [...recentFiles.value]
    const beforeActiveIndex = activeFileIndex.value

    // Own the async restore at store scope, not component scope. During Vite
    // HMR the old Editor can unmount while loadSession() is still pending and
    // a new Editor mounts against the same Pinia store. Both mounts await this
    // one operation instead of each appending the saved drafts.
    sessionHydrated.value = true
    const pending = Promise.resolve()
      .then(() => hydrate())
      .then((result) => {
        ensureWorkspaceSelection()
        return result
      })
      .then(() => true)
      .catch((error) => {
        openFiles.value = beforeFiles
        recentFiles.value = beforeRecent
        activeFileIndex.value = beforeActiveIndex
        sessionHydrated.value = false
        throw error
      })
      .finally(() => {
        if (sessionHydrationPromise === pending) sessionHydrationPromise = null
      })
    sessionHydrationPromise = pending
    return pending
  }

  function activateSessionEntry(entry) {
    if (!entry) return false
    const index = entry.path
      ? openFiles.value.findIndex((file) => file.path === entry.path)
      : openFiles.value.findIndex((file) => file.draftId === entry.draftId)
    if (index < 0) return false
    if (!isFileVisible(openFiles.value[index])) {
      ensureWorkspaceSelection()
      return false
    }
    activeFileIndex.value = index
    return true
  }

  function collapseLegacyDuplicateDrafts() {
    const active = currentFile.value
    const byContent = new Map()
    const duplicateIds = new Set()

    for (const file of openFiles.value) {
      if (file.path || file.draftId) continue
      const key = String(file.content || '')
      const existing = byContent.get(key)
      if (!existing) {
        byContent.set(key, file)
        continue
      }
      if (file === active) {
        duplicateIds.add(existing.id)
        byContent.set(key, file)
      } else {
        duplicateIds.add(file.id)
      }
    }

    if (duplicateIds.size) {
      openFiles.value = openFiles.value.filter((file) => !duplicateIds.has(file.id))
    }
    for (const file of openFiles.value) {
      if (!file.path && !file.draftId) file.draftId = createDraftId()
    }
    const activeIndex = active
      ? openFiles.value.findIndex((file) => file === active)
      : -1
    if (activeIndex >= 0) activeFileIndex.value = activeIndex
    else if (openFiles.value.length) {
      activeFileIndex.value = Math.min(activeFileIndex.value, openFiles.value.length - 1)
    } else {
      activeFileIndex.value = 0
    }
  }

  // Update content (called on editor change)
  function updateContent(content) {
    const file = currentFile.value
    if (!file || file.kind !== 'text') return
    file.content = content
    if (file.graph) file.graph.version += 1
    file.newTab = false
    file.preview = false
    markFileDirty(file)
  }

  function markDirty(file = currentFile.value) {
    if (!file || !openFiles.value.includes(file) || !['text', 'graph'].includes(file.kind)) return
    file.preview = false
    markFileDirty(file)
  }

  // Replace a disk-backed snapshot only while the Editor still considers it
  // clean. Native watcher reads are asynchronous, so this guard belongs in
  // the store at the exact mutation boundary rather than only at read start.
  function replaceCleanContent(file, content) {
    if (
      !file
      || !openFiles.value.includes(file)
      || !file.path
      || file.kind !== 'text'
      || file.graph
      || file.dirty
    ) {
      return false
    }
    const nextContent = String(content)
    if (file.content === nextContent) return false
    file.content = nextContent
    if (file.path === scratchpad.path) file.scratchpadBase = nextContent
    file.saveState = SAVE_STATE.idle
    file.saveError = null
    file.reviews = null
    return true
  }

  // Switch tab
  function setActiveTab(idx) {
    if (idx >= 0 && idx < openFiles.value.length && isFileVisible(openFiles.value[idx])) {
      activeFileIndex.value = idx
    }
  }

  function setActiveVisibleTab(idx) {
    const file = visibleOpenFiles.value[idx]
    if (!file) return false
    activeFileIndex.value = openFiles.value.indexOf(file)
    return true
  }

  // Close tab without confirmation (caller is responsible for confirming).
  function closeFile(idx, { ensureOne = true } = {}) {
    const file = openFiles.value[idx]
    if (!file) return
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    pausedGraphSaves.delete(file.id)
    graphRefreshVersions.delete(file.id)

    openFiles.value.splice(idx, 1)
    if (openFiles.value.length === 0) {
      activeFileIndex.value = 0
      if (ensureOne) newFile()
    } else if (activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1
    } else if (activeFileIndex.value > idx) {
      activeFileIndex.value--
    } else if (activeFileIndex.value === idx) {
      activeFileIndex.value = Math.min(idx, openFiles.value.length - 1)
    }
    ensureWorkspaceSelection()
  }

  // Remove one explicitly discarded document. Unlike handleWorkspaceTrash,
  // this path does not recover dirty text as an untitled draft: the caller
  // has already confirmed that the buffer can be lost.
  function discardFile(file, { ensureOne = true } = {}) {
    const index = openFiles.value.indexOf(file)
    if (index < 0) return false
    if (file.path) removeRecentFile(file.path)
    closeFile(index, { ensureOne })
    return true
  }

  // Save current file
  async function save(file = currentFile.value) {
    if (!file || !['text', 'graph'].includes(file.kind)) return false
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    if (file.path) {
      if (!file.graph && isGraphSourceCandidate(file.path)) await classifyGraphDocument(file)
      return await writeFile(file)
    } else {
      return await saveAs(file)
    }
  }

  // Save As
  async function saveAs(file = currentFile.value) {
    if (file?.graph) {
      try { await waitForFile(file) } catch { /* A failed draft can still be exported. */ }
      const destination = await saveFileDialog(file.path || 'graph-entry.md')
      if (!destination) return false
      if (!openFiles.value.includes(file)) return false
      try { await waitForFile(file) } catch { /* Keep recovery independent of the original writer. */ }
      if (destination === file.path) return save(file)
      const { document: target } = await graphSaveDestination(destination, file)
      const content = file.dirty && file.kind === 'graph'
        ? await graphExportContent(file, useBusinessGraphStore().nodes) : file.content
      assertDestinationDraftAvailable(destination, file)
      if (target) {
        await saveGraphSource({ path: destination, content, expectedRevision: target.sourceRevision })
      } else {
        if (openFiles.value.some(open => open.path === destination && open.graph)) throw new Error(GRAPH_UNAVAILABLE)
        await saveFile(destination, content)
      }
      addRecentFile(destination)
      return true
    }
    if (!file || file.kind !== 'text') return false
    const defaultPath = file.path
      || (workspaceScope.value ? `${workspaceScope.value}/untitled.md` : 'untitled.md')
    let path = await saveFileDialog(defaultPath)
    if (!path) return false
    if (!openFiles.value.includes(file)) return false
    if (file.path === scratchpad.path && path.endsWith('/scratchpad.md')
      && typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      // Save As can select the project link. Use the shared save path so the
      // generic atomic file writer cannot replace that link with a plain file.
      path = await resolveScratchpad(path) || path
      if (!openFiles.value.includes(file)) return false
    }
    if (file.path === scratchpad.path && path !== scratchpad.path) {
      // Export a copy; the shared tab keeps its identity and destination.
      const { document } = await graphSaveDestination(path, file)
      if (document) await saveGraphSource({ path, content: file.content, expectedRevision: document.sourceRevision })
      else await saveFile(path, file.content)
      addRecentFile(path)
      return true
    }
    await waitForFile(file)
    const { document, other } = await graphSaveDestination(path, file)
    if (!openFiles.value.includes(file)) return false
    if (other) closeFile(openFiles.value.indexOf(other), { ensureOne: false })
    file.path = path
    file.draftId = null
    file.workspacePath = workspaceForPath(path)
    if (document) file.graph = graphDocumentState(document)
    const saved = await writeFile(file)
    // A newly created source can be classified without waiting for its index.
    if (!file.graph && isGraphSourceCandidate(file.path)) await classifyGraphDocument(file)
    return saved
  }

  async function graphSaveDestination(path, file) {
    let other = assertDestinationDraftAvailable(path, file)
    const document = isGraphSourceCandidate(path) ? await graphSource(path) : null
    other = assertDestinationDraftAvailable(path, file)
    if (other?.graph && !document) throw new Error(GRAPH_UNAVAILABLE)
    return { document, other }
  }

  function assertDestinationDraftAvailable(path, file) {
    const other = openFiles.value.find(open => open !== file && open.path === path)
    if (other?.reviewPending) throw new Error('Finish the review in the destination tab before replacing this file.')
    if (other?.dirty || (other && writesByFileId.has(other.id))) throw new Error('This destination has an unsaved draft in another tab.')
    return other
  }

  // Open file dialog and open the selected file
  async function openDialog() {
    const result = await openFileDialog(workspaceScope.value || undefined)
    if (!result) return
    await openFile(result.path, result.content, { kind: result.kind, meta: result.meta })
  }

  function moveTab(from, to) {
    if (from === to) return
    if (from < 0 || from >= openFiles.value.length) return
    if (to < 0 || to >= openFiles.value.length) return
    const active = activeFileIndex.value
    const [moved] = openFiles.value.splice(from, 1)
    openFiles.value.splice(to, 0, moved)
    if (active === from) activeFileIndex.value = to
    else if (from < active && to >= active) activeFileIndex.value--
    else if (from > active && to <= active) activeFileIndex.value++
  }

  function removeTabForTransfer(idx) {
    if (openFiles.value.length <= 1) return null
    const file = openFiles.value[idx]
    if (!file || writesByFileId.has(file.id)) return null
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    pausedGraphSaves.delete(file.id)
    graphRefreshVersions.delete(file.id)
    const removed = {
      path: file.path,
      content: file.content,
      dirty: file.dirty,
      draftId: file.draftId,
      kind: file.kind,
      preview: file.preview,
      meta: file.meta,
      workspacePath: file.workspacePath,
      ...(file.graph ? { graph: cloneGraphDocument(file.graph) } : {}),
    }
    openFiles.value.splice(idx, 1)
    if (activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1
    } else if (activeFileIndex.value > idx) {
      activeFileIndex.value--
    } else if (activeFileIndex.value === idx) {
      activeFileIndex.value = Math.min(idx, openFiles.value.length - 1)
    }
    ensureWorkspaceSelection()
    return removed
  }

  function addFileFromTransfer({ path, content, dirty, draftId, kind = 'text', preview = false, meta = null, workspacePath, graph = null }) {
    const existing = path && openFiles.value.find(file => file.path === path)
    if (existing) {
      if (existing.dirty && dirty) throw new Error('This file already has an unsaved draft in this window.')
      if (dirty) {
        existing.content = content || ''
        existing.kind = kind
        existing.graph = graph ? restoredGraphState(graph) : existing.graph
        markFileDirty(existing)
      }
      activeFileIndex.value = openFiles.value.indexOf(existing)
      return existing
    }
    const file = makeFile({ path: path || null, content: content || '', dirty: !!dirty, draftId, kind, preview, meta, workspacePath })
    if (graph) file.graph = restoredGraphState(graph)
    openFiles.value.push(file)
    activeFileIndex.value = openFiles.value.length - 1
    return file
  }

  function pathSuffixInside(path, parent) {
    const candidate = String(path || '').replace(/\\/g, '/')
    const boundary = String(parent || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!candidate || !boundary) return null
    if (candidate === boundary) return ''
    if (!candidate.startsWith(`${boundary}/`)) return null
    return String(path).slice(boundary.length)
  }

  function pathIsInside(path, parent) {
    return pathSuffixInside(path, parent) !== null
  }

  async function waitForWorkspacePaths(paths = []) {
    const targets = paths.filter(Boolean)
    if (!targets.length) return
    while (true) {
      const pending = [...new Set(openFiles.value
        .filter(file => file.path && targets.some(target => pathIsInside(file.path, target)))
        .map(file => writesByFileId.get(file.id))
        .filter(Boolean))]
      if (!pending.length) return
      await Promise.all(pending)
    }
  }

  function moveWorkspacePath(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return
    for (const file of openFiles.value) {
      if (!file.path) continue
      const suffix = pathSuffixInside(file.path, oldPath)
      if (suffix === null) continue
      file.path = `${String(newPath).replace(/[\\/]+$/, '')}${suffix}`
    }
    recentFiles.value = recentFiles.value.map((path) => {
      const suffix = pathSuffixInside(path, oldPath)
      return suffix === null
        ? path
        : `${String(newPath).replace(/[\\/]+$/, '')}${suffix}`
    })
  }

  function handleWorkspaceTrash(paths = []) {
    const targets = paths.filter(Boolean)
    if (!targets.length) return
    for (let index = openFiles.value.length - 1; index >= 0; index--) {
      const file = openFiles.value[index]
      if (!file.path || !targets.some((target) => pathIsInside(file.path, target))) continue
      if (file.dirty) {
        if (file.graph) {
          file.graph.unavailable = true
          file.saveState = SAVE_STATE.failed
          file.saveError = 'This Graph source is unavailable. The draft is kept in this tab.'
          continue
        }
        file.path = null
        file.draftId ||= createDraftId()
        file.newTab = false
        file.saveState = SAVE_STATE.dirty
        file.saveError = null
      } else {
        openFiles.value.splice(index, 1)
      }
    }
    recentFiles.value = recentFiles.value.filter((path) => (
      !targets.some((target) => pathIsInside(path, target))
    ))
    if (!openFiles.value.length) newFile()
    activeFileIndex.value = Math.min(activeFileIndex.value, openFiles.value.length - 1)
    ensureWorkspaceSelection()
  }

  function setFileReviews(file, reviews) {
    if (file) {
      file.reviews = Array.isArray(reviews) ? reviews : reviews ? [reviews] : null
      if (file.reviews?.length) file.preview = false
    }
  }

  function clearFileReviews(file) {
    if (file) file.reviews = null
  }

  async function waitForFile(file) {
    while (writesByFileId.has(file?.id)) await writesByFileId.get(file.id)
  }

  async function openGraphDocument(document, { preview = true, isCurrent = () => true } = {}) {
    if (!document?.node) throw new Error('This Graph entry is unavailable.')
    const path = document.node.provenance.sourcePath
    const file = await openFile(path, document.content, { preview, kind: 'graph', graphDocument: document, isCurrent })
    if (!file) return null
    if (!file.graph) {
      // A dirty source tab retains its source view and buffer.
      file.graph = graphDocumentState(document)
      if (file.dirty) file.kind = 'text'
    }
    return file
  }

  function graphDraftChanged(file) {
    if (!file?.graph || !openFiles.value.includes(file)) return
    file.graph.version += 1
    markDirty(file)
    scheduleGraphSave(file)
  }

  function scheduleGraphSave(file) {
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    if (pausedGraphSaves.has(file.id) || file.kind !== 'graph' || file.graph?.unavailable || !file.graph?.draft?.title?.trim()) return
    graphSaveTimers.set(file.id, setTimeout(() => {
      graphSaveTimers.delete(file.id)
      if (openFiles.value.includes(file) && file.dirty) void save(file).catch(() => {})
    }, 900))
  }

  function pauseGraphSave(file) {
    if (!file?.graph) return
    pausedGraphSaves.add(file.id)
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
  }

  function resumeGraphSave(file) {
    if (!file?.graph) return
    pausedGraphSaves.delete(file.id)
    if (openFiles.value.includes(file) && file.dirty) scheduleGraphSave(file)
  }

  async function setGraphView(file, view) {
    if (!file?.graph || !['details', 'source'].includes(view)) return false
    if (file.reviewPending) throw new Error('Finish the review before changing the entry view.')
    await waitForFile(file)
    if (!openFiles.value.includes(file)) return false
    if (file.reviewPending) throw new Error('Finish the review before changing the entry view.')
    if (file.dirty && !await save(file)) return false
    const path = file.path
    const version = file.graph.version
    const sourceRevision = file.graph.sourceRevision
    const document = await graphSource(path)
    if (!openFiles.value.includes(file) || file.reviewPending || file.path !== path || file.dirty || file.graph.version !== version || file.graph.sourceRevision !== sourceRevision) return false
    if (!document) {
      markGraphUnavailable(file)
      throw new Error(GRAPH_UNAVAILABLE)
    }
    if (view === 'details' && !document.node) throw new Error('Correct the Markdown properties before opening Details.')
    applyGraphDocument(file, document)
    file.kind = view === 'source' ? 'text' : 'graph'
    return true
  }

  function markGraphUnavailable(file, error = GRAPH_UNAVAILABLE) {
    file.graph.unavailable = true
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    file.saveState = SAVE_STATE.failed
    file.saveError = normalizeSaveError(error)
  }

  function applyGraphDocument(file, document) {
    const version = file.graph?.version || 0
    const nodeId = file.graph?.nodeId || file.graph?.node?.id
    const closedUndo = file.graph?.closedUndo?.sourceRevision === document.sourceRevision ? file.graph.closedUndo : null
    file.graph = { ...graphDocumentState(document), version, nodeId: document.node?.id || nodeId, closedUndo }
    file.content = document.content
    if (!document.node) file.kind = 'text'
    file.dirty = false
    file.saveState = SAVE_STATE.idle
    file.saveError = null
  }

  async function classifyGraphDocument(file) {
    if (!file || file.graph || !isGraphSourceCandidate(file.path) || !openFiles.value.includes(file)) return false
    await waitForFile(file)
    const path = file.path
    const content = file.content
    const document = await graphSource(path)
    if (!document || !openFiles.value.includes(file) || file.path !== path || file.graph || writesByFileId.has(file.id)) return false
    file.graph = graphDocumentState(document)
    if (file.dirty || file.content !== content) {
      file.graph.sourceRevision = ''
      return false
    }
    file.content = document.content
    return true
  }

  async function refreshGraphDocument(file, { paths = [] } = {}) {
    if (file?.reviewPending) return false
    if (!file?.graph) return classifyGraphDocument(file)
    if (!openFiles.value.includes(file)) return false
    const request = (graphRefreshVersions.get(file.id) || 0) + 1
    graphRefreshVersions.set(file.id, request)
    try { await waitForFile(file) } catch { /* Keep the failed draft and its revision. */ }
    const path = file.path
    const graph = file.graph
    const version = graph.version
    const sourceRevision = graph.sourceRevision
    const current = () => openFiles.value.includes(file) && !file.reviewPending && file.path === path
      && file.graph === graph && graph.version === version && graph.sourceRevision === sourceRevision
      && graphRefreshVersions.get(file.id) === request && !writesByFileId.has(file.id)
    if (!current()) return false
    let document
    let movedPath = null
    try {
      document = await graphSource(path)
      if (!document && paths.includes(path)) {
        const id = file.graph.nodeId || file.graph.node?.id
        const candidate = id ? await getGraphNode(id) : null
        const candidatePath = candidate?.provenance?.sourcePath
        if (candidatePath && candidatePath !== path && paths.includes(candidatePath)) {
          const moved = await graphSource(candidatePath)
          if (moved?.node?.id === id) {
            document = moved
            movedPath = candidatePath
          }
        }
      }
    } catch (error) {
      if (current()) markGraphUnavailable(file, error)
      return false
    }
    if (!current()) return false
    if (!document) {
      markGraphUnavailable(file)
      return false
    }
    if (movedPath) {
      const other = openFiles.value.find(candidate => candidate !== file && candidate.path === movedPath)
      if (other?.dirty || (other && writesByFileId.has(other.id))) {
        markGraphUnavailable(file, 'The moved source already has a draft in another tab. This draft is kept here.')
        return false
      }
      if (other) closeFile(openFiles.value.indexOf(other), { ensureOne: false })
      file.path = movedPath
      file.workspacePath = workspaceForPath(movedPath)
      removeRecentFile(path)
      addRecentFile(movedPath)
    }
    if (file.dirty) {
      // External text does not become the baseline of an existing draft.
      // The next save must compare against the revision that draft started on.
      const wasUnavailable = file.graph.unavailable
      file.graph.unavailable = false
      if (wasUnavailable) {
        file.saveState = SAVE_STATE.dirty
        file.saveError = null
      }
      return false
    }
    if (!movedPath && !file.graph.unavailable && file.graph.sourceRevision === document.sourceRevision
      && file.graph.node?.provenance?.scopeId === document.node?.provenance?.scopeId) return false
    applyGraphDocument(file, document)
    return true
  }

  async function refreshGraphDocuments(change = {}) {
    const paths = Array.isArray(change?.paths) && change.paths.length ? new Set(change.paths) : null
    return Promise.all(openFiles.value.filter(file => (file.graph || isGraphSourceCandidate(file.path)) && (!paths || paths.has(file.path)))
      .map(file => refreshGraphDocument(file, change || {})))
  }

  async function undoGraphClose(file) {
    if (!file?.graph || !openFiles.value.includes(file)) return false
    await waitForFile(file)
    if (file.dirty) throw new Error('Save this draft before you undo the close action.')
    const undo = file.graph.closedUndo
    if (!undo || file.graph.unavailable || undo.sourceRevision !== file.graph.sourceRevision || undo.sourcePath !== file.path) {
      throw new Error('This close action can no longer be undone.')
    }
    clearTimeout(graphSaveTimers.get(file.id))
    graphSaveTimers.delete(file.id)
    return writeFile(file, { graphOperation: 'undo-close' })
  }

  return {
    openFiles,
    recentFiles,
    workspaceProjectionEnabled,
    workspaceScope,
    knownWorkspacePaths,
    activeFileIndex,
    sessionHydrated,
    currentFile,
    visibleOpenFiles,
    visibleRecentFiles,
    activeVisibleFileIndex,
    tabList,
    hasOpenFiles,
    openFile,
    newFile,
    newTab,
    restoreDraft,
    restorePath,
    hydrateSession,
    activateSessionEntry,
    collapseLegacyDuplicateDrafts,
    updateContent,
    markDirty,
    replaceCleanContent,
    setActiveTab,
    setActiveVisibleTab,
    setWorkspaceScope,
    clearWorkspaceScope,
    ensureWorkspaceSelection,
    workspaceForPath,
    pathIsVisible,
    closeFile,
    discardFile,
    addRecentFile,
    removeRecentFile,
    setRecentFiles,
    clearVisibleRecentFiles,
    save,
    saveAs,
    openGraphDocument,
    graphDraftChanged,
    pauseGraphSave,
    resumeGraphSave,
    undoGraphClose,
    setGraphView,
    waitForFile,
    refreshGraphDocument,
    refreshGraphDocuments,
    openDialog,
    moveTab,
    removeTabForTransfer,
    addFileFromTransfer,
    waitForWorkspacePaths,
    moveWorkspacePath,
    handleWorkspaceTrash,
    setFileReviews,
    clearFileReviews,
  }
})

function createDraftId() {
  return globalThis.crypto?.randomUUID?.() || `draft-${nextDraftId++}`
}

export function pathIsInsideWorkspace(path, workspacePath) {
  const candidate = normalizeWorkspacePath(path)
  const root = normalizeWorkspacePath(workspacePath)
  return Boolean(candidate && root) && (
    candidate === root || candidate.startsWith(`${root}/`)
  )
}

export function owningWorkspacePath(path, workspacePaths = []) {
  const candidate = normalizeWorkspacePath(path)
  if (!candidate) return ''
  return normalizeWorkspacePaths(workspacePaths)
    .find(root => candidate === root || candidate.startsWith(`${root}/`)) || ''
}

function normalizeWorkspacePaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : [])
    .map(normalizeWorkspacePath)
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length)
}

function normalizeWorkspacePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}
