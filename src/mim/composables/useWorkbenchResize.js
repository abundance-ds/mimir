import { ref } from 'vue'

export function useWorkbenchResize(workbench, options = {}) {
  const dragging = ref(false)
  let gesture = null

  function start(pane, event) {
    if (!['sidebar', 'editor'].includes(pane)) {
      throw new Error(`Pane '${pane}' does not have a user resize edge.`)
    }
    disposeGesture()
    gesture = {
      pane,
      startX: Number(event.clientX) || 0,
      startWidth: workbench.paneLayout[pane].width,
    }
    dragging.value = true
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd, { once: true })
    window.addEventListener('pointercancel', onEnd, { once: true })
  }

  function onMove(event) {
    if (!gesture) return
    const delta = (Number(event.clientX) || 0) - gesture.startX
    const width = gesture.pane === 'sidebar'
      ? gesture.startWidth + delta
      : gesture.startWidth - delta
    workbench.setPaneWidth(gesture.pane, width)
  }

  function onEnd() {
    if (!gesture) return
    disposeGesture()
    options.persist?.(workbench.layoutSnapshot())
  }

  function disposeGesture() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    gesture = null
    dragging.value = false
  }

  function dispose() {
    disposeGesture()
  }

  return { dragging, start, dispose }
}
