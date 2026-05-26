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
    if (!getFile()?.path) return

    timer = setTimeoutFn(async () => {
      timer = null
      flush({ bridge: 'flush' })

      const file = getFile()
      if (!isAutoSaveEnabled() || !file?.path || !file.dirty) return

      try {
        await save({ source: 'auto' })
      } catch (error) {
        onError(error)
      }
    }, delay)
  }

  return { schedule, clear }
}
