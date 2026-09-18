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
  trashWorkspaceEntries = null,
  discardModeForFile = () => '',
  cancelAutoSave = () => {},
  resumeAutoSave = () => {},
  flushSession = async () => {},
  requestWindowClose,
  embedded = false,
  onEmpty,
}) {
  const closeConfirmFile = ref(null)
  let closeConfirmResolve = null
  const discardConfirm = ref(null)
  const discardPending = ref(false)
  const discardError = ref('')
  const arrivedTabIndex = ref(-1)

  const closeConfirmFileName = computed(() => {
    const f = closeConfirmFile.value
    if (!f) return ''
    return f.graph?.draft?.title || f.graph?.node?.title || (f.path ? basename(f.path) : 'Untitled')
  })

  const discardConfirmFileName = computed(() => {
    const file = discardConfirm.value?.file
    return file?.path ? basename(file.path) : 'Untitled'
  })

  const discardConfirmMode = computed(() => discardConfirm.value?.mode || '')

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
    if (file?.reviewPending) return 'cancel'
    const pausedSave = cancelAutoSave(file)
    const resume = () => {
      fileManager.resumeGraphSave?.(file)
      if (pausedSave) resumeAutoSave(file)
    }
    fileManager.pauseGraphSave?.(file)
    try { await fileManager.waitForFile?.(file) }
    catch { /* Keep the existing confirmation available after a failed save. */ }
    if (!file?.dirty) { resume(); return 'clean' }
    const action = await showCloseConfirmation(file)
    if (action === 'cancel') { resume(); return 'cancel' }
    if (action === 'save') {
      const index = fileManager.openFiles.indexOf(file)
      if (index < 0) return 'cancel'
      if (index !== activeFileIndex.value) fileManager.setActiveTab(index)
      try {
        return await saveCurrentFile({ source: 'manual' }) ? 'saved' : 'cancel'
      } catch {
        return 'cancel'
      } finally {
        resume()
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

  function requestDiscardTab(idx) {
    const tab = displayTabs.value[idx]
    if (tab?.type !== 'file') return false
    const file = fileManager.openFiles[tabFileIndex(tab, idx)]
    return requestDiscardFile(file)
  }

  function requestDiscardFile(file) {
    const mode = discardModeForFile(file)
    if (!file || !mode) return false
    discardError.value = ''
    discardConfirm.value = { file, mode }
    return true
  }

  function cancelDiscard() {
    if (discardPending.value) return false
    discardConfirm.value = null
    discardError.value = ''
    return true
  }

  async function confirmDiscard() {
    const request = discardConfirm.value
    if (!request || discardPending.value) return false
    const { file, mode } = request
    const openIndex = fileManager.openFiles.indexOf(file)
    if (openIndex < 0) {
      cancelDiscard()
      return false
    }

    discardPending.value = true
    discardError.value = ''
    const wasActive = openIndex === activeFileIndex.value
    const autoSaveCancelled = cancelAutoSave(file)
    try {
      if (wasActive) {
        flushEditorContent({ bridge: 'flush' })
      }
      if (mode === 'trash') {
        if (typeof trashWorkspaceEntries !== 'function') {
          throw new Error('Moving files to the Trash is unavailable.')
        }
        await fileManager.waitForWorkspacePaths([file.path])
        await trashWorkspaceEntries([file.path])
      }

      const visibleFileCount = displayTabs.value.filter(tab => tab.type === 'file').length
      if (wasActive) inlineAIState.value = null
      fileManager.discardFile(file, { ensureOne: !embedded })
      discardConfirm.value = null
      discardError.value = ''
      if (embedded && visibleFileCount === 1) onEmpty?.()
      await flushSession()
      return true
    } catch (error) {
      discardError.value = error instanceof Error
        ? error.message
        : String(error || (mode === 'trash'
          ? 'Could not move the file to the Trash.'
          : 'Could not discard the draft.'))
      if (autoSaveCancelled) resumeAutoSave(file)
      return false
    } finally {
      discardPending.value = false
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
    discardConfirm,
    discardConfirmFileName,
    discardConfirmMode,
    discardError,
    discardPending,
    arrivedTabIndex,
    onSelectTab,
    onCloseTab,
    confirmFileClose,
    requestDiscardTab,
    requestDiscardFile,
    cancelDiscard,
    confirmDiscard,
    onCloseConfirm,
    onNewFile,
    onReorderTab,
  }
}

function tabFileIndex(tab, displayIndex) {
  return Number.isInteger(tab?.fileIndex) ? tab.fileIndex : displayIndex
}
