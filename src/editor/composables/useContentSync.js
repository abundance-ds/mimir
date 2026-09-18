export function useContentSync({
  currentFile,
  documentBridge,
}) {
  // FileStore receives editor transactions synchronously. Reading or publishing
  // a document never pulls text from whichever view happens to be mounted.
  function currentEditorContent() {
    return currentFile.value?.content || ''
  }

  function syncDerivedContent(content, { bridge = 'schedule' } = {}) {
    const path = currentFile.value?.path || ''
    if (bridge === 'flush') documentBridge.flush(content, path)
    else if (bridge === 'schedule') documentBridge.schedule(content, path)
  }

  function flushEditorContent(options = {}) {
    const file = currentFile.value
    if (!file) return ''
    if (file.kind === 'graph') return file.content || ''
    const content = currentEditorContent()
    syncDerivedContent(content, options)
    return content
  }

  function scheduleContentSync() {
    flushEditorContent()
  }

  function syncOpenFileSnapshot({ bridge = 'flush' } = {}) {
    const file = currentFile.value
    if (!file) return
    syncDerivedContent(file.content || '', { bridge })
  }

  return {
    currentEditorContent,
    flushEditorContent,
    scheduleContentSync,
    syncOpenFileSnapshot,
  }
}
