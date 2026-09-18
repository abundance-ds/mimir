// CLI redraws can arrive in several writes after a PTY resize. Retain one
// reading position briefly, without attaching it to durable terminal state.
const REDRAW_WINDOW_MS = 1000
const MAX_WRAPPED_ROWS = 64

export function createTerminalResizeAnchor(terminal) {
  let anchor = null
  let frame = 0
  let expiry = 0
  const bufferChange = terminal.buffer.onBufferChange(cancel)

  function cancel() {
    if (frame) cancelAnimationFrame(frame)
    if (expiry) clearTimeout(expiry)
    frame = 0
    expiry = 0
    anchor?.marker?.dispose()
    anchor = null
  }

  function begin() {
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal') {
      cancel()
      return
    }
    // Keep the original anchor throughout a continuous resize drag. A redraw
    // can temporarily leave an empty buffer or a viewport at the wrong end.
    if (!anchor) {
      const bottom = buffer.viewportY >= buffer.baseY
      let line = buffer.viewportY
      const first = Math.max(0, line - MAX_WRAPPED_ROWS)
      while (line > first && buffer.getLine(line)?.isWrapped) line -= 1
      const marker = !bottom && !buffer.getLine(line)?.isWrapped
        ? terminal.registerMarker(line - buffer.baseY - buffer.cursorY)
        : null
      anchor = {
        bottom,
        marker,
        cellOffset: (buffer.viewportY - line) * terminal.cols,
        fraction: buffer.baseY ? buffer.viewportY / buffer.baseY : 0,
      }
    }
    extend()
  }

  function extend() {
    if (expiry) clearTimeout(expiry)
    expiry = setTimeout(cancel, REDRAW_WINDOW_MS)
  }

  function restore() {
    frame = 0
    if (!anchor) return
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal') {
      cancel()
      return
    }
    const line = anchor.bottom
      ? buffer.baseY
      : anchor.marker && !anchor.marker.isDisposed
        ? anchor.marker.line + Math.floor(anchor.cellOffset / terminal.cols)
        : Math.round(anchor.fraction * buffer.baseY)
    const target = Math.max(0, Math.min(line, buffer.baseY))
    terminal.scrollToLine(target)
    // xterm 6 scrollToLine uses a relative DOM scroll. A height change can
    // leave that DOM position behind the buffer position for the first call.
    // Retry only if needed, within this same frame and through the public API.
    if (buffer.viewportY !== target) terminal.scrollToLine(target)
  }

  function applied(resized = false) {
    if (!anchor) return
    // Start the redraw window at the ordered resize event as well as at the
    // request. Output does not extend it indefinitely during active streaming.
    if (resized) extend()
    if (!frame) frame = requestAnimationFrame(restore)
  }

  return {
    begin,
    applied,
    cancel,
    dispose() {
      cancel()
      bufferChange.dispose()
    },
  }
}
