import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { openFileDialog, saveFileDialog, saveFile } from '../services/fileSystem.js'
import { SAVE_STATE } from '../shared/saveState.js'

const RECENT_LIMIT = 12
let nextFileId = 1
let nextDraftId = 1

export const useFileStore = defineStore('files', () => {
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
    if (!ensureWorkspaceSelection({ preferScoped: scopeChanged })) {
      console.log('[files] no visible file after scope change to', nextScope, '→ creating blank')
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

  async function writeFile(file) {
    if (!file?.path) return false
    const targetPath = file.path
    const targetContent = file.content
    const previous = writesByFileId.get(file.id) || Promise.resolve()
    file.saveState = SAVE_STATE.saving
    file.saveError = null
    let operation
    const execute = async () => {
        try {
          await saveFile(targetPath, targetContent)
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
            file.dirty = true
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
  } = {}) {
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
      existing.kind = kind
      existing.meta = meta
      if (!preview) existing.preview = false
      const owner = owningWorkspacePath(path, [workspacePath, ...knownWorkspacePaths.value])
      if (owner) existing.workspacePath = owner
      addRecentFile(path)
      return existing
    }

    const reusablePreviewIndex = preview
      ? openFiles.value.findIndex(file => file.preview && !file.dirty && isFileVisible(file))
      : -1
    const replacementIndex = active?.newTab
      ? activeFileIndex.value
      : reusablePreviewIndex
    if (replacementIndex >= 0) {
      const replacement = openFiles.value[replacementIndex]
      replacement.path = path
      replacement.draftId = null
      replacement.content = content
      replacement.newTab = false
      replacement.kind = kind
      replacement.preview = preview
      replacement.meta = meta
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

  function restorePath({ path, content = '', dirty = false, workspacePath } = {}) {
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
    })
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
    file.newTab = false
    file.preview = false
    markFileDirty(file)
  }

  function markDirty(file = currentFile.value) {
    if (!file || !openFiles.value.includes(file) || file.kind !== 'text') return
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
      || file.dirty
    ) {
      return false
    }
    const nextContent = String(content)
    if (file.content === nextContent) return false
    file.content = nextContent
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

  // Save current file
  async function save(file = currentFile.value) {
    if (!file || file.kind !== 'text') return false
    if (file.path) {
      return await writeFile(file)
    } else {
      return await saveAs(file)
    }
  }

  // Save As
  async function saveAs(file = currentFile.value) {
    if (!file) return false
    const defaultPath = file.path
      || (workspaceScope.value ? `${workspaceScope.value}/untitled.md` : 'untitled.md')
    const path = await saveFileDialog(defaultPath)
    if (!path) return false
    if (!openFiles.value.includes(file)) return false
    file.path = path
    file.draftId = null
    file.workspacePath = workspaceForPath(path)
    return await writeFile(file)
  }

  // Open file dialog and open the selected file
  async function openDialog() {
    const result = await openFileDialog(workspaceScope.value || undefined)
    if (!result) return
    await openFile(result.path, result.content)
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
    if (!file) return null
    const removed = {
      path: file.path,
      content: file.content,
      dirty: file.dirty,
      draftId: file.draftId,
      kind: file.kind,
      preview: file.preview,
      meta: file.meta,
      workspacePath: file.workspacePath,
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

  function addFileFromTransfer({
    path,
    content,
    dirty,
    draftId,
    kind = 'text',
    preview = false,
    meta = null,
    workspacePath,
  }) {
    openFiles.value.push(makeFile({
      path: path || null,
      content: content || '',
      dirty: !!dirty,
      draftId,
      kind,
      preview,
      meta,
      workspacePath,
    }))
    activeFileIndex.value = openFiles.value.length - 1
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
    if (file) file.reviews = Array.isArray(reviews) ? reviews : reviews ? [reviews] : null
  }

  function clearFileReviews(file) {
    if (file) file.reviews = null
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
    addRecentFile,
    removeRecentFile,
    setRecentFiles,
    clearVisibleRecentFiles,
    save,
    saveAs,
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
