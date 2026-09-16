import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export const DEFAULT_SIDEBAR_FILES_HEIGHT = 240
export const MIN_SIDEBAR_FILES_HEIGHT = 112
const OPEN_DRAG_THRESHOLD = 6

// A window resize limits the displayed height, never the remembered height.
export function useSidebarFilesSize(props, emit, body) {
  const available = ref(600)
  const draft = ref(null)
  const opening = ref(false)
  const closing = ref(false)
  const resizing = ref(false)
  const maximum = computed(() => Math.max(0, available.value - 112))
  const minimum = computed(() => Math.min(MIN_SIDEBAR_FILES_HEIGHT, maximum.value))
  const clamp = value => Math.round(Math.max(minimum.value, Math.min(maximum.value, value)))
  const height = computed(() => draft.value == null ? clamp(props.filesHeight) : Math.min(maximum.value, draft.value))
  let observer, gesture

  function measure() { available.value = body.value?.clientHeight || 600 }
  function clearClickGuard() {
    window.removeEventListener('click', blockDragClick, true)
    window.removeEventListener('pointerdown', clearClickGuard, true)
  }
  function blockDragClick(event) {
    // Keyboard activation is always a new action. A pointer click after a drag
    // belongs to that drag, even if the collapsed row was replaced meanwhile.
    if (event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation() }
    clearClickGuard()
  }
  function guardDragClick() {
    window.addEventListener('click', blockDragClick, true)
    window.addEventListener('pointerdown', clearClickGuard, true)
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const delta = gesture.startY - event.clientY
    if (gesture.fromCollapsed) {
      const across = Math.abs(event.clientX - gesture.startX)
      if (Math.max(Math.abs(delta), across) >= OPEN_DRAG_THRESHOLD) guardDragClick()
      if (!resizing.value && (delta < OPEN_DRAG_THRESHOLD || delta <= across)) return
      resizing.value = true
      opening.value = delta >= OPEN_DRAG_THRESHOLD
      // Follow the pointer from the closed edge; apply the usable minimum on release.
      draft.value = Math.round(Math.max(0, Math.min(maximum.value, delta)))
    } else {
      if (!delta && !gesture.moved) return
      guardDragClick()
      const nextHeight = gesture.startHeight + delta
      // Keep the gesture's original edge after snapping, so reversing the same
      // drag opens Files again. A small gap prevents flicker at the threshold.
      const threshold = minimum.value / 2 + (closing.value ? OPEN_DRAG_THRESHOLD : 0)
      closing.value = nextHeight < threshold
      draft.value = clamp(nextHeight)
    }
    gesture.moved = true
  }
  function reset() {
    gesture = null
    draft.value = null
    opening.value = false
    closing.value = false
    resizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', abort)
    window.removeEventListener('keydown', keyDuringDrag, true)
    window.removeEventListener('blur', abort)
  }
  function focusControl() {
    nextTick(() => {
      body.value?.querySelector(props.filesCollapsed ? '[data-sidebar-files-toggle]' : '[data-sidebar-files-resize]')?.focus({ preventScroll: true })
    })
  }
  function finish(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    move(event)
    const moved = gesture.moved
    if (moved) {
      if (!gesture.fromCollapsed && closing.value) {
        emit('toggleFiles')
      } else if (!gesture.fromCollapsed || opening.value) {
        emit('resizeFiles', clamp(height.value))
        if (gesture.fromCollapsed) emit('toggleFiles')
      }
    }
    reset()
    if (moved) focusControl()
  }
  function abort() {
    if (!gesture) return
    guardDragClick()
    reset()
    focusControl()
  }
  watch(() => [props.collapsed, props.filesCollapsed], ([rail, filesClosed]) => {
    if (gesture && (rail || filesClosed !== gesture.fromCollapsed)) abort()
  })
  function keyDuringDrag(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); abort() }
  }
  function begin(event, fromCollapsed) {
    if (event.button !== 0 || props.collapsed || props.filesCollapsed !== fromCollapsed || gesture) return
    event.preventDefault()
    event.currentTarget?.focus({ preventScroll: true })
    clearClickGuard()
    measure()
    gesture = { fromCollapsed, startX: event.clientX, startY: event.clientY, startHeight: height.value, pointerId: event.pointerId, moved: false }
    resizing.value = !fromCollapsed
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('keydown', keyDuringDrag, true)
    window.addEventListener('blur', abort)
  }
  const start = event => begin(event, false)
  const startCollapsed = event => begin(event, true)
  function keydown(event) {
    const delta = event.shiftKey ? 56 : 28
    const next = { ArrowUp: height.value + delta, ArrowDown: height.value - delta, Home: minimum.value, End: maximum.value }[event.key]
    if (next == null) return
    event.preventDefault()
    event.stopPropagation()
    emit('resizeFiles', clamp(next))
  }
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      if (body.value) observer.observe(body.value)
    }
  })
  onBeforeUnmount(() => { reset(); clearClickGuard(); observer?.disconnect() })
  return { height, minimum, maximum, resizing, opening, closing, start, startCollapsed, keydown }
}
