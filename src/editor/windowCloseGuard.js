export function createWindowCloseGuard({
  getWindow,
  flushContent,
  getDirtyFiles,
  confirmFile,
  flushSession,
  beforeNativeClose,
  beforeNativeHide,
  hideOnClose = false,
  awaitReady,
  onError = (error) => console.error('[editor-close]', error),
}) {
  let windowRef = null
  let windowPromise = null
  let unlisten = null
  let closePromise = null
  let hidePromise = null
  let allowNativeClose = false
  let disposed = false

  function resolveWindow() {
    if (windowRef) return Promise.resolve(windowRef)
    if (!windowPromise) {
      windowPromise = Promise.resolve()
        .then(() => getWindow?.())
        .then((value) => {
          windowRef = value || null
          return windowRef
        })
    }
    return windowPromise
  }

  async function setup() {
    const currentWindow = await resolveWindow()
    if (!currentWindow?.onCloseRequested || disposed) return false
    const stop = await currentWindow.onCloseRequested((event) => {
      if (allowNativeClose) return
      event.preventDefault()
      const transition = hideOnClose && currentWindow.hide
        ? requestHide()
        : requestClose()
      void transition.catch(onError)
    })
    if (disposed) {
      stop?.()
      return false
    }
    unlisten = stop
    return true
  }

  function requestHide() {
    if (closePromise) return closePromise
    if (hidePromise) return hidePromise
    hidePromise = (async () => {
      const currentWindow = await resolveWindow()
      if (!currentWindow?.hide) return null

      await awaitReady?.()
      flushContent?.()
      await flushSession?.([])
      const readyToHide = await beforeNativeHide?.()
      if (readyToHide === false) return false
      await currentWindow.hide()
      return true
    })().finally(() => {
      hidePromise = null
    })
    return hidePromise
  }

  function requestClose({
    confirmedFiles = [],
    discardedFiles = [],
    closeNative = true,
    revealBeforeConfirm = false,
  } = {}) {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (hidePromise) await hidePromise
      const currentWindow = await resolveWindow()
      if (!currentWindow?.close) return null

      await awaitReady?.()
      flushContent?.()
      const confirmed = new Set(confirmedFiles)
      const discarded = new Set(discardedFiles)
      const dirtyFiles = [...(getDirtyFiles?.() || [])]
      const needsConfirmation = dirtyFiles.some(file => file?.dirty && !confirmed.has(file))
      if (revealBeforeConfirm && needsConfirmation) {
        await currentWindow.show?.()
        await currentWindow.setFocus?.()
      }
      for (const file of dirtyFiles) {
        if (!file?.dirty || confirmed.has(file)) continue
        const decision = await confirmFile?.(file)
        if (decision === false || decision === 'cancel') return false
        if (decision === 'discard') discarded.add(file)
      }

      await flushSession?.([...discarded])
      if (!closeNative) return true
      const readyToClose = await beforeNativeClose?.()
      if (readyToClose === false) return false
      allowNativeClose = true
      try {
        await currentWindow.close()
        return true
      } catch (error) {
        allowNativeClose = false
        throw error
      }
    })().finally(() => {
      closePromise = null
    })
    return closePromise
  }

  function dispose() {
    disposed = true
    unlisten?.()
    unlisten = null
  }

  return { setup, requestClose, dispose }
}
