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
  let timerFile = null

  function clear(file = null) {
    if (file && timerFile !== file) return false
    if (timer != null) {
      clearTimeoutFn(timer)
      timer = null
      timerFile = null
      return true
    }
    return false
  }

  function schedule(file = getFile()) {
    clear()
    if (!isAutoSaveEnabled(file)) return
    const scheduledFile = file
    if (!scheduledFile?.path) return

    timerFile = scheduledFile
    timer = setTimeoutFn(async () => {
      timer = null
      timerFile = null
      // Switching tabs flushes the old editor before changing active identity.
      // If the scheduled file is still active, synchronize the last pending
      // CodeMirror transaction here as well.
      if (getFile() === scheduledFile) flush({ bridge: 'flush' })

      if (
        !isAutoSaveEnabled(scheduledFile)
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
