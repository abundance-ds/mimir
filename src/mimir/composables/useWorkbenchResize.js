import { ref } from 'vue'
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_RAIL_WIDTH } from '../../stores/workbench.js'

const COLLAPSE_WIDTH = (SIDEBAR_MIN_WIDTH + SIDEBAR_RAIL_WIDTH) / 2
const REOPEN_WIDTH = COLLAPSE_WIDTH + 12

export function useWorkbenchResize(workbench, options = {}) {
  const dragging = ref(false)
  const sidebarPreview = ref(null)
  let gesture = null
  let frame = null
  let pendingWidth = null

  function start(pane, event) {
    if (!['sidebar', 'editor'].includes(pane)) {
      throw new Error(`Pane '${pane}' does not have a user resize edge.`)
    }
    if (event.button != null && event.button !== 0) return
    disposeGesture()
    event.preventDefault?.()
    const paneElement = event.currentTarget?.closest?.('[data-pane-shell]')?.querySelector(`[data-pane="${pane}"]`)
    const saved = workbench.paneLayout[pane]
    gesture = {
      pane,
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: Number(event.clientX) || 0,
      startWidth: paneElement?.getBoundingClientRect().width || (pane === 'sidebar' && saved.state === 'rail' ? SIDEBAR_RAIL_WIDTH : saved.width),
      savedWidth: saved.width,
      moved: false,
    }
    event.currentTarget?.setPointerCapture?.(event.pointerId)
    if (pane === 'sidebar') sidebarPreview.value = { ...saved }
    dragging.value = true
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('lostpointercapture', abort)
    window.addEventListener('blur', abort)
    window.addEventListener('keydown', onKeydown, true)
  }

  function ownsPointer(event) {
    return gesture && event.pointerId === gesture.pointerId
  }

  // Keep the original drag edge through collapse so the same gesture can reverse.
  // Apply only the last pointer position in each frame.
  function onMove(event) {
    if (!ownsPointer(event)) return
    const delta = (Number(event.clientX) || 0) - gesture.startX
    if (!delta && !gesture.moved) return
    gesture.moved = true
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
    if (gesture.pane === 'sidebar') {
      const threshold = sidebarPreview.value.state === 'rail' ? REOPEN_WIDTH : COLLAPSE_WIDTH
      sidebarPreview.value = pendingWidth < threshold
        ? { state: 'rail', width: gesture.savedWidth }
        : { state: 'expanded', width: Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, pendingWidth))) }
    } else {
      workbench.setPaneWidth(gesture.pane, pendingWidth)
    }
    pendingWidth = null
  }

  function onEnd(event) {
    if (!ownsPointer(event)) return
    onMove(event)
    flush()
    const moved = gesture.moved
    if (moved && sidebarPreview.value) {
      workbench.setPaneWidth('sidebar', sidebarPreview.value.width)
      workbench.setPaneState('sidebar', sidebarPreview.value.state)
    }
    disposeGesture()
    if (moved) options.persist?.(workbench.layoutSnapshot())
  }

  function abort(event) {
    if (!gesture || (['pointercancel', 'lostpointercapture'].includes(event?.type) && !ownsPointer(event))) return
    if (gesture.pane === 'editor') workbench.setPaneWidth('editor', gesture.savedWidth)
    disposeGesture()
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    abort()
  }

  function disposeGesture() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', abort)
    window.removeEventListener('lostpointercapture', abort)
    window.removeEventListener('blur', abort)
    window.removeEventListener('keydown', onKeydown, true)
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    pendingWidth = null
    if (gesture?.target?.hasPointerCapture?.(gesture.pointerId)) {
      gesture.target.releasePointerCapture(gesture.pointerId)
    }
    gesture = null
    sidebarPreview.value = null
    dragging.value = false
  }

  function dispose() {
    abort()
  }

  return { dragging, sidebarPreview, start, dispose, flush }
}
