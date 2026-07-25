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
  // Each entry: { id, path, content, dirty, saveState, saveError }
  // path is null for unsaved/new files

  const activeFileIndex = ref(0)
  const sessionHydrated = ref(false)
  let sessionHydrationPromise = null
  const writesByFileId = new Map()

  const currentFile = computed(() => openFiles.value[activeFileIndex.value] || null)

  function makeFile({
    path,
    content = '',
    dirty = false,
    newTab = false,
    draftId = null,
  }) {
    return {
      id: nextFileId++,
      path,
      draftId: path ? null : (draftId || createDraftId()),
      content,
      dirty,
      newTab,
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

  // Open a file from disk path. If already open, just switch to it.
  // If the active tab is a newTab landing page, replace it in-place.
  async function openFile(path, content) {
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
      addRecentFile(path)
      return
    }

    if (active?.newTab) {
      active.path = path
      active.draftId = null
      active.content = content
      active.newTab = false
      active.dirty = false
      active.saveState = SAVE_STATE.idle
      addRecentFile(path)
      return
    }

    const file = makeFile({ path, content })
    openFiles.value.push(file)
    activeFileIndex.value = openFiles.value.length - 1
    addRecentFile(path)
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

  function restorePath({ path, content = '', dirty = false } = {}) {
    if (!path) return null
    const existing = openFiles.value.find((file) => file.path === path)
    if (existing) {
      activeFileIndex.value = openFiles.value.indexOf(existing)
      return existing
    }
    const file = makeFile({ path, content: String(content), dirty: Boolean(dirty) })
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
    if (!file) return
    file.content = content
    file.newTab = false
    markFileDirty(file)
  }

  function markDirty() {
    const file = currentFile.value
    if (!file) return
    markFileDirty(file)
  }

  // Switch tab
  function setActiveTab(idx) {
    if (idx >= 0 && idx < openFiles.value.length) {
      activeFileIndex.value = idx
    }
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
  }

  // Save current file
  async function save(file = currentFile.value) {
    if (!file) return false
    if (file.path) {
      return await writeFile(file)
    } else {
      return await saveAs(file)
    }
  }

  // Save As
  async function saveAs(file = currentFile.value) {
    if (!file) return false
    const defaultPath = file.path || 'untitled.md'
    const path = await saveFileDialog(defaultPath)
    if (!path) return false
    if (!openFiles.value.includes(file)) return false
    file.path = path
    file.draftId = null
    return await writeFile(file)
  }

  // Open file dialog and open the selected file
  async function openDialog() {
    const result = await openFileDialog()
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
    }
    openFiles.value.splice(idx, 1)
    if (activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1
    } else if (activeFileIndex.value > idx) {
      activeFileIndex.value--
    } else if (activeFileIndex.value === idx) {
      activeFileIndex.value = Math.min(idx, openFiles.value.length - 1)
    }
    return removed
  }

  function addFileFromTransfer({ path, content, dirty, draftId }) {
    openFiles.value.push(makeFile({
      path: path || null,
      content: content || '',
      dirty: !!dirty,
      draftId,
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
    activeFileIndex,
    sessionHydrated,
    currentFile,
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
    setActiveTab,
    closeFile,
    addRecentFile,
    removeRecentFile,
    setRecentFiles,
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
