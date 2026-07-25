export function createAutoSaveController({
  flush,
  save,
  getFile,
  isAutoSaveEnabled,
  onError = () => {},
  delay = 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null

  function clear() {
    if (timer != null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  function schedule() {
    clear()
    if (!isAutoSaveEnabled()) return
    const scheduledFile = getFile()
    if (!scheduledFile?.path) return

    timer = setTimeoutFn(async () => {
      timer = null
      // Switching tabs flushes the old editor before changing active identity.
      // If the scheduled file is still active, synchronize the last pending
      // CodeMirror transaction here as well.
      if (getFile() === scheduledFile) flush({ bridge: 'flush' })

      if (
        !isAutoSaveEnabled()
        || !scheduledFile.path
        || !scheduledFile.dirty
      ) return

      try {
        await save({ source: 'auto', file: scheduledFile })
      } catch (error) {
        onError(error)
      }
    }, delay)
  }

  return { schedule, clear }
}
