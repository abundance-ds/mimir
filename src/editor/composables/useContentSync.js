const CONTENT_SYNC_DELAY = 150

export function useContentSync({
  editorSurfaceRef,
  currentFile,
  fileManager,
  documentBridge,
}) {
  let contentSyncTimer = null
  let confirmedFileId = null

  function currentEditorContent() {
    if (currentFile.value?.kind === 'graph') return currentFile.value.content || ''
    return editorSurfaceRef.value?.getContent?.() ?? currentFile.value?.content ?? ''
  }

  function syncDerivedContent(content, { bridge = 'schedule' } = {}) {
    const path = currentFile.value?.path || ''
    if (bridge === 'flush') documentBridge.flush(content, path)
    else if (bridge === 'schedule') documentBridge.schedule(content, path)
  }

  function flushEditorContent(options = {}) {
    clearTimeout(contentSyncTimer)
    const file = currentFile.value
    if (!file) return ''
    if (file.kind === 'graph') return file.content || ''
    if (confirmedFileId !== null && file.id !== confirmedFileId) {
      syncDerivedContent(file.content || '', options)
      return file.content || ''
    }
    const content = currentEditorContent()
    if (content !== file.content) {
      fileManager.updateContent(content)
    }
    confirmedFileId = file.id
    syncDerivedContent(content, options)
    return content
  }

  function scheduleContentSync() {
    clearTimeout(contentSyncTimer)
    contentSyncTimer = setTimeout(() => {
      flushEditorContent()
    }, CONTENT_SYNC_DELAY)
  }

  function syncOpenFileSnapshot({ bridge = 'flush' } = {}) {
    const file = currentFile.value
    if (!file) return
    confirmedFileId = file.id
    syncDerivedContent(file.content || '', { bridge })
  }

  function dispose() {
    clearTimeout(contentSyncTimer)
  }

  return {
    currentEditorContent,
    flushEditorContent,
    scheduleContentSync,
    syncOpenFileSnapshot,
    dispose,
  }
}
