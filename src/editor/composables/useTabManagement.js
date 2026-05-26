import { ref, computed } from 'vue'
import { editorWindowChromeOptions } from '../../shared/windowChrome.js'

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

  async function onTabDragOut(tabIndex, screenX, screenY) {
    flushEditorContent({ bridge: 'flush' })

    const file = fileManager.openFiles[tabIndex]
    const fileData = { path: file.path || '', content: file.content || '', dirty: file.dirty || false }
    const windowLabel = new URLSearchParams(location.search).get('window') || ''

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke('tab_drag_resolve', {
        sourceLabel: windowLabel,
        screenX,
        screenY,
        fileData,
      })
      if (result === 'transferred') {
        await removeOrCloseAfterTransfer(tabIndex)
      } else if (result === 'create_new') {
        const [cx, cy] = await invoke('get_cursor_position', { screenX, screenY })
        await createEditorWindowWithFile(file, cx, cy)
        await removeOrCloseAfterTransfer(tabIndex)
      }
    } catch (err) {
      try {
        await createEditorWindowWithFile(file, screenX, screenY)
        await removeOrCloseAfterTransfer(tabIndex)
      } catch { /* ignore */ }
    }
  }

  async function createEditorWindowWithFile(file, screenX, screenY) {
    const label = `editor-${Date.now()}`
    const params = new URLSearchParams({ view: 'editor', window: label })
    const url = `/?${params.toString()}`
    const width = 1280
    const height = 860

    const transferData = { path: file.path || '', content: file.content || '', dirty: file.dirty || false }
    localStorage.setItem(`shoulders:tab-transfer:${label}`, JSON.stringify(transferData))

    if (!window.__TAURI_INTERNALS__) {
      window.open(url, label, `width=${width},height=${height}`)
      return
    }

    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const title = file.path ? file.path.split('/').pop() + ' — Shoulders' : 'Untitled — Shoulders'

    const posOpts = (screenX != null && screenY != null)
      ? { x: screenX - width / 2, y: screenY - 20 }
      : { center: true }

    const editorWindow = new WebviewWindow(label, {
      url,
      title,
      width,
      height,
      minWidth: 300,
      minHeight: 620,
      resizable: true,
      ...posOpts,
      ...editorWindowChromeOptions,
    })

    await new Promise((resolve) => {
      editorWindow.once('tauri://created', () => resolve(true))
      editorWindow.once('tauri://error', () => resolve(false))
    })
  }

  async function removeOrCloseAfterTransfer(tabIndex) {
    const removed = fileManager.removeTabForTransfer(tabIndex)
    if (removed) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      getCurrentWindow().close()
    } catch {
      window.close()
    }
  }

  function receiveTransferredFile(data) {
    fileManager.addFileFromTransfer({
      path: data.path || data.filePath || '',
      content: data.content || data.fileContent || '',
      dirty: data.dirty ?? data.fileDirty ?? false,
    })
    arrivedTabIndex.value = fileManager.openFiles.length - 1
    setTimeout(() => { arrivedTabIndex.value = -1 }, 600)
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
    onTabDragOut,
    receiveTransferredFile,
  }
}
