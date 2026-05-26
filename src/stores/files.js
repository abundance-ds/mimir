import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { openFileDialog, saveFileDialog, saveFile } from '../services/fileSystem.js'
import { SAVE_STATE } from '../shared/saveState.js'
import { parseBoardEntry, serializeEntry } from '../services/board/loader.js'

const RECENT_LIMIT = 12
let nextFileId = 1

export const useFileStore = defineStore('files', () => {
  const openFiles = ref([])
  const recentFiles = ref([])
  // Each entry: { id, path, content, dirty, saveState, saveError }
  // path is null for unsaved/new files

  const activeFileIndex = ref(0)

  const currentFile = computed(() => openFiles.value[activeFileIndex.value] || null)

  function makeFile({ path, content = '', dirty = false, newTab = false }) {
    return {
      id: nextFileId++,
      path,
      content,
      dirty,
      newTab,
      saveState: dirty ? SAVE_STATE.dirty : SAVE_STATE.idle,
      saveError: null,
      reviews: null,
      meta: null,
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
    file.saveState = SAVE_STATE.saving
    file.saveError = null
    try {
      let contentToWrite = file.content
      if (file.meta) {
        contentToWrite = serializeEntry(file.meta, file.content)
      }
      await saveFile(file.path, contentToWrite)
      file.dirty = false
      file.saveState = SAVE_STATE.saved
      file.saveError = null
      addRecentFile(file.path)

      if (file.meta && window.__TAURI_INTERNALS__) {
        const entryId = file.path?.split('/').pop()?.replace(/\.md$/, '') || ''
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('shoulders://board-changed', { entryId })
        })
      }

      return true
    } catch (error) {
      file.dirty = true
      file.saveState = SAVE_STATE.failed
      file.saveError = normalizeSaveError(error)
      throw error
    }
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
      active.content = content
      active.newTab = false
      active.dirty = false
      active.saveState = SAVE_STATE.idle
      active.meta = null
      if (path && (path.includes('/issues/') || path.includes('/knowledge/')) && !path.includes('/node_modules/')) {
        try {
          const { meta, body } = parseBoardEntry(content)
          if (meta.type === 'issue' || meta.type === 'knowledge') {
            active.content = body
            active.meta = meta
          }
        } catch {}
      }
      addRecentFile(path)
      return
    }

    const file = makeFile({ path, content })
    if (path && (path.includes('/issues/') || path.includes('/knowledge/')) && !path.includes('/node_modules/')) {
      try {
        const { meta, body } = parseBoardEntry(content)
        if (meta.type === 'issue' || meta.type === 'knowledge') {
          file.content = body
          file.meta = meta
        }
      } catch {}
    }
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
  function closeFile(idx) {
    const file = openFiles.value[idx]
    if (!file) return

    openFiles.value.splice(idx, 1)
    if (openFiles.value.length === 0) {
      newFile()
    } else if (activeFileIndex.value >= openFiles.value.length) {
      activeFileIndex.value = openFiles.value.length - 1
    } else if (activeFileIndex.value > idx) {
      activeFileIndex.value--
    } else if (activeFileIndex.value === idx) {
      activeFileIndex.value = Math.min(idx, openFiles.value.length - 1)
    }
  }

  // Save current file
  async function save() {
    const file = currentFile.value
    if (!file) return false
    if (file.path) {
      return await writeFile(file)
    } else {
      return await saveAs()
    }
  }

  // Save As
  async function saveAs() {
    const file = currentFile.value
    if (!file) return false
    const defaultPath = file.path || 'untitled.md'
    const path = await saveFileDialog(defaultPath)
    if (!path) return false
    file.path = path
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
    const removed = { path: file.path, content: file.content, dirty: file.dirty }
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

  function addFileFromTransfer({ path, content, dirty }) {
    openFiles.value.push(makeFile({ path: path || null, content: content || '', dirty: !!dirty }))
    activeFileIndex.value = openFiles.value.length - 1
  }

  function setFileReviews(file, reviews) {
    if (file) file.reviews = Array.isArray(reviews) ? reviews : reviews ? [reviews] : null
  }

  function clearFileReviews(file) {
    if (file) file.reviews = null
  }

  function updateMeta(fileId, updates) {
    const file = openFiles.value.find(f => f.id === fileId)
    if (!file || !file.meta) return
    Object.assign(file.meta, updates, { updated: new Date().toISOString() })
    markFileDirty(file)
  }

  return {
    openFiles,
    recentFiles,
    activeFileIndex,
    currentFile,
    tabList,
    hasOpenFiles,
    openFile,
    newFile,
    newTab,
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
    setFileReviews,
    clearFileReviews,
    updateMeta,
  }
})
