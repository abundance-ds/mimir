import { ref, computed } from 'vue'
import { basename } from '../../shared/utils/path.js'

export function useTabManagement({
  fileManager,
  diffStore,
  diffActive = computed(() => diffStore.active),
  displayTabs,
  reviewTabActive,
  gitReviewStore = null,
  gitReviewTabActive = ref(false),
  inlineAIState,
  activeFileIndex,
  flushEditorContent,
  saveCurrentFile,
  requestWindowClose,
  embedded = false,
  onEmpty,
}) {
  const closeConfirmFile = ref(null)
  let closeConfirmResolve = null
  const arrivedTabIndex = ref(-1)

  const closeConfirmFileName = computed(() => {
    const f = closeConfirmFile.value
    if (!f) return ''
    return f.path ? basename(f.path) : 'Untitled'
  })

  function onSelectTab(idx) {
    const tab = displayTabs.value[idx]
    if (tab?.type === 'review') {
      gitReviewTabActive.value = false
      reviewTabActive.value = true
      diffStore.clearBatchFocus()
      return
    }
    if (tab?.type === 'git-review') {
      reviewTabActive.value = false
      gitReviewTabActive.value = true
      return
    }
    const returningFromGit = gitReviewTabActive.value
    gitReviewTabActive.value = false
    reviewTabActive.value = false
    const fileIndex = tabFileIndex(tab, idx)
    if (diffActive.value && diffStore.isBatch) {
      flushEditorContent({ bridge: 'flush' })
      fileManager.setActiveTab(fileIndex)
      const file = fileManager.openFiles[fileIndex]
      if (file?.path) diffStore.focusBatchFile(file.path)
      return
    }
    const file = fileManager.openFiles[fileIndex]
    const returnsToSingleReview = returningFromGit
      && diffActive.value
      && !diffStore.isBatch
      && file
      && (
        (diffStore.fileId != null && file.id === diffStore.fileId)
        || (diffStore.fileId == null && diffStore.filePath && file.path === diffStore.filePath)
      )
    if (returnsToSingleReview) {
      flushEditorContent({ bridge: 'flush' })
      fileManager.setActiveTab(fileIndex)
      return
    }
    if (diffActive.value && !diffStore.isBatch) diffStore.deactivate()
    inlineAIState.value = null
    flushEditorContent({ bridge: 'flush' })
    fileManager.setActiveTab(fileIndex)
  }

  async function onCloseTab(idx) {
    const tab = displayTabs.value[idx]
    if (tab?.type === 'review') {
      diffStore.deactivate()
      reviewTabActive.value = false
      return
    }
    if (tab?.type === 'git-review') {
      gitReviewStore?.deactivate?.()
      gitReviewTabActive.value = false
      return
    }

    const fileIndex = tabFileIndex(tab, idx)
    if (fileIndex === activeFileIndex.value) flushEditorContent({ bridge: 'flush' })

    const file = fileManager.openFiles[fileIndex]
    if (!file) return

    const decision = await confirmFileClose(file)
    if (decision === 'cancel') return false

    const visibleFileCount = displayTabs.value.filter(candidate => candidate.type === 'file').length
    if (visibleFileCount === 1) {
      if (!embedded && fileManager.openFiles.length === 1) {
        return await requestWindowClose?.({
          confirmedFiles: [file],
          discardedFiles: decision === 'discard' ? [file] : [],
        })
          ?? await closeEditorWindow()
      }
      if (embedded) {
        fileManager.closeFile(fileIndex, { ensureOne: false })
        onEmpty?.()
      } else {
        fileManager.closeFile(fileIndex)
      }
    } else {
      fileManager.closeFile(fileIndex)
    }
    return true
  }

  async function confirmFileClose(file) {
    if (!file?.dirty) return 'clean'
    const action = await showCloseConfirmation(file)
    if (action === 'cancel') return 'cancel'
    if (action === 'save') {
      const index = fileManager.openFiles.indexOf(file)
      if (index < 0) return 'cancel'
      if (index !== activeFileIndex.value) fileManager.setActiveTab(index)
      try {
        return await saveCurrentFile({ source: 'manual' }) ? 'saved' : 'cancel'
      } catch {
        return 'cancel'
      }
    }
    return 'discard'
  }

  function showCloseConfirmation(file) {
    return new Promise(resolve => {
      closeConfirmFile.value = file
      closeConfirmResolve = resolve
    })
  }

  function onCloseConfirm(action) {
    closeConfirmFile.value = null
    if (closeConfirmResolve) {
      closeConfirmResolve(action)
      closeConfirmResolve = null
    }
  }

  async function closeEditorWindow() {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    } catch {
      window.close()
    }
  }

  function onNewFile() {
    gitReviewTabActive.value = false
    flushEditorContent({ bridge: 'flush' })
    fileManager.newFile()
  }

  function onReorderTab(from, to) {
    const source = displayTabs.value[from]
    const target = displayTabs.value[to]
    if (source?.type !== 'file' || target?.type !== 'file') return
    flushEditorContent({ bridge: 'flush' })
    fileManager.moveTab(tabFileIndex(source, from), tabFileIndex(target, to))
  }

  return {
    closeConfirmFile,
    closeConfirmFileName,
    arrivedTabIndex,
    onSelectTab,
    onCloseTab,
    confirmFileClose,
    onCloseConfirm,
    onNewFile,
    onReorderTab,
  }
}

function tabFileIndex(tab, displayIndex) {
  return Number.isInteger(tab?.fileIndex) ? tab.fileIndex : displayIndex
}
