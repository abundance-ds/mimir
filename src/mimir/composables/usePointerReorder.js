import { computed, onUnmounted, ref } from 'vue'
import { reorderActivityIds } from '../activityOrdering.js'

const DRAG_THRESHOLD = 5

export function usePointerReorder({
  root,
  rowSelector,
  keyAttribute,
  keys,
  onReorder,
  axis = 'y',
}) {
  const drag = ref(null)
  const dropIndicator = ref(null)
  const suppressClick = ref(false)
  const dragging = computed(() => drag.value?.active === true)
  let previousBodyCursor = ''
  let previousBodyUserSelect = ''
  let draggingAffordanceActive = false

  function onPointerDown(event, key) {
    if (event.button !== 0 || event.target?.closest?.('[data-no-reorder], input')) return
    cancel()
    drag.value = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('keydown', onKeyDown)
  }

  function onPointerMove(event) {
    if (!drag.value) return
    if (!drag.value.active) {
      const distance = Math.abs(event.clientX - drag.value.startX)
        + Math.abs(event.clientY - drag.value.startY)
      if (distance < DRAG_THRESHOLD) return
      drag.value.active = true
      beginDraggingAffordance()
    }
    updateDropIndicator(axis === 'x' ? event.clientX : event.clientY)
  }

  function onPointerUp() {
    detach()
    endDraggingAffordance()
    if (drag.value?.active && dropIndicator.value) {
      onReorder(reorderActivityIds(
        keys(),
        drag.value.key,
        dropIndicator.value.beforeId,
      ))
      suppressClick.value = true
      window.setTimeout(() => {
        suppressClick.value = false
      }, 0)
    }
    drag.value = null
    dropIndicator.value = null
  }

  function onPointerCancel() {
    cancel()
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !drag.value) return
    event.preventDefault()
    cancel()
  }

  function cancel() {
    detach()
    endDraggingAffordance()
    drag.value = null
    dropIndicator.value = null
  }

  function beginDraggingAffordance() {
    if (!document.body) return
    previousBodyCursor = document.body.style.cursor
    previousBodyUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    draggingAffordanceActive = true
  }

  function endDraggingAffordance() {
    if (!document.body || !draggingAffordanceActive) return
    document.body.style.cursor = previousBodyCursor
    document.body.style.userSelect = previousBodyUserSelect
    draggingAffordanceActive = false
  }

  function updateDropIndicator(position) {
    const rows = root.value?.querySelectorAll(rowSelector) || []
    let best = null
    for (const row of rows) {
      const id = row.getAttribute(keyAttribute)
      if (id === drag.value?.key) continue
      const rect = row.getBoundingClientRect()
      if (position < (axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2)) {
        best = { beforeId: id, afterId: null }
        break
      }
      best = { beforeId: null, afterId: id }
    }
    dropIndicator.value = best
  }

  function detach() {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerCancel)
    document.removeEventListener('keydown', onKeyDown)
  }

  onUnmounted(cancel)

  return {
    drag,
    dragging,
    dropIndicator,
    suppressClick,
    onPointerDown,
  }
}
