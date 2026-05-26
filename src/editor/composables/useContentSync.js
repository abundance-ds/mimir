const CONTENT_SYNC_DELAY = 150

export function useContentSync({
  editorSurfaceRef,
  currentFile,
  fileManager,
  documentBridge,
  preview,
  getViewMode,
}) {
  let contentSyncTimer = null

  function previewEnabled() {
    return getViewMode() !== 'source'
  }

  function currentEditorContent() {
    return editorSurfaceRef.value?.getContent?.() ?? currentFile.value?.content ?? ''
  }

  function syncDerivedContent(content, { bridge = 'schedule', previewMode = 'schedule' } = {}) {
    const path = currentFile.value?.path || ''
    if (bridge === 'flush') documentBridge.flush(content, path)
    else if (bridge === 'schedule') documentBridge.schedule(content, path)

    if (previewMode === 'flush') preview.render(content, previewEnabled())
    else if (previewMode === 'schedule') preview.schedule(content, previewEnabled())
  }

  function flushEditorContent(options = {}) {
    clearTimeout(contentSyncTimer)
    const file = currentFile.value
    if (!file) return ''
    const content = currentEditorContent()
    if (content !== file.content) {
      fileManager.updateContent(content)
    }
    syncDerivedContent(content, options)
    return content
  }

  function scheduleContentSync() {
    clearTimeout(contentSyncTimer)
    contentSyncTimer = setTimeout(() => {
      flushEditorContent()
    }, CONTENT_SYNC_DELAY)
  }

  function syncOpenFileSnapshot({ bridge = 'flush', previewMode = 'flush' } = {}) {
    const file = currentFile.value
    if (!file) return
    syncDerivedContent(file.content || '', { bridge, previewMode })
  }

  function dispose() {
    clearTimeout(contentSyncTimer)
  }

  return {
    currentEditorContent,
    flushEditorContent,
    scheduleContentSync,
    syncOpenFileSnapshot,
    previewEnabled,
    dispose,
  }
}
