export function createAutoSaveController({
  save,
  getFile,
  isAutoSaveEnabled,
  onError = () => {},
  delay = 1000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const timers = new Map()

  function clear(file = null) {
    if (file) {
      if (!timers.has(file)) return false
      clearTimeoutFn(timers.get(file))
      timers.delete(file)
    } else {
      const hadTimers = timers.size > 0
      for (const timer of timers.values()) clearTimeoutFn(timer)
      timers.clear()
      return hadTimers
    }
    return true
  }

  function schedule(file = getFile()) {
    if (!file) return
    clear(file)
    if (!isAutoSaveEnabled(file)) return
    const scheduledFile = file
    if (!scheduledFile?.path) return

    timers.set(file, setTimeoutFn(async () => {
      timers.delete(scheduledFile)

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
    }, delay))
  }

  return { schedule, clear }
}
