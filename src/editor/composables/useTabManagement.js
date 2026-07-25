import { ref, computed } from 'vue'

export function useTabManagement({
  fileManager,
  diffStore,
  displayTabs,
  reviewTabActive,
  inlineAIState,
  activeFileIndex,
  flushEditorContent,
  saveCurrentFile,
}) {
  const closeConfirmFile = ref(null)
  let closeConfirmResolve = null
  const arrivedTabIndex = ref(-1)

  const closeConfirmFileName = computed(() => {
    const f = closeConfirmFile.value
    if (!f) return ''
    return f.path ? f.path.split('/').pop() : 'Untitled'
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

    if (file.dirty) {
      const action = await showCloseConfirmation(file)
      if (action === 'cancel') return
      if (action === 'save') {
        if (idx !== activeFileIndex.value) fileManager.setActiveTab(idx)
        try {
          const didSave = await saveCurrentFile({ source: 'manual' })
          if (!didSave) return
        } catch {
          return
        }
      }
    }

    if (fileManager.openFiles.length === 1) {
      closeEditorWindow()
    } else {
      fileManager.closeFile(idx)
    }
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
      getCurrentWindow().close()
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
    onCloseConfirm,
    onNewFile,
    onReorderTab,
  }
}
