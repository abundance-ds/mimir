import { ref } from 'vue'

export function useWorkbenchResize(workbench, options = {}) {
  const dragging = ref(false)
  let gesture = null
  let frame = null
  let pendingWidth = null

  function start(pane, event) {
    if (!['sidebar', 'editor'].includes(pane)) {
      throw new Error(`Pane '${pane}' does not have a user resize edge.`)
    }
    disposeGesture()
    const paneElement = event.currentTarget?.closest?.('[data-pane-shell]')?.querySelector(`[data-pane="${pane}"]`)
    gesture = {
      pane,
      startX: Number(event.clientX) || 0,
      startWidth: paneElement?.getBoundingClientRect().width || workbench.paneLayout[pane].width,
    }
    dragging.value = true
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd, { once: true })
    window.addEventListener('pointercancel', onEnd, { once: true })
  }

  // pointermove fires at 60+ Hz; only record the latest width here and apply it
  // at most once per animation frame. onEnd flushes synchronously so the final
  // width is exact.
  function onMove(event) {
    if (!gesture) return
    const delta = (Number(event.clientX) || 0) - gesture.startX
    pendingWidth = gesture.pane === 'sidebar'
      ? gesture.startWidth + delta
      : gesture.startWidth - delta
    if (frame === null) frame = window.requestAnimationFrame(onFrame)
  }

  function onFrame() {
    frame = null
    flush()
  }

  function flush() {
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    if (!gesture || pendingWidth === null) return
    workbench.setPaneWidth(gesture.pane, pendingWidth)
    pendingWidth = null
  }

  function onEnd() {
    if (!gesture) return
    flush()
    disposeGesture()
    options.persist?.(workbench.layoutSnapshot())
  }

  function disposeGesture() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    pendingWidth = null
    gesture = null
    dragging.value = false
  }

  function dispose() {
    disposeGesture()
  }

  return { dragging, start, dispose, flush }
}
