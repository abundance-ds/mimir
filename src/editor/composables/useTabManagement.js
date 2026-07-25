import { ref, computed } from 'vue'
import { basename } from '../../shared/utils/path.js'

export function useTabManagement({
  fileManager,
  diffStore,
  displayTabs,
  reviewTabActive,
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
      reviewTabActive.value = true
      diffStore.clearBatchFocus()
      return
    }
    reviewTabActive.value = false
    if (diffStore.active && diffStore.isBatch) {
      flushEditorContent({ bridge: 'flush' })
      fileManager.setActiveTab(idx)
      const file = fileManager.openFiles[idx]
      if (file?.path) diffStore.focusBatchFile(file.path)
      return
    }
    if (diffStore.active && !diffStore.isBatch) diffStore.deactivate()
    inlineAIState.value = null
    flushEditorContent({ bridge: 'flush' })
    fileManager.setActiveTab(idx)
  }

  async function onCloseTab(idx) {
    const tab = displayTabs.value[idx]
    if (tab?.type === 'review') {
      diffStore.deactivate()
      reviewTabActive.value = false
      return
    }

    if (idx === activeFileIndex.value) flushEditorContent({ bridge: 'flush' })

    const file = fileManager.openFiles[idx]
    if (!file) return

    const decision = await confirmFileClose(file)
    if (decision === 'cancel') return false

    if (fileManager.openFiles.length === 1) {
      if (!embedded) {
        return await requestWindowClose?.({
          confirmedFiles: [file],
          discardedFiles: decision === 'discard' ? [file] : [],
        })
          ?? await closeEditorWindow()
      }
      fileManager.closeFile(idx, { ensureOne: false })
      onEmpty?.()
    } else {
      fileManager.closeFile(idx)
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
    flushEditorContent({ bridge: 'flush' })
    fileManager.newFile()
  }

  function onReorderTab(from, to) {
    flushEditorContent({ bridge: 'flush' })
    fileManager.moveTab(from, to)
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
