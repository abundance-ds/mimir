// Work board drag: moving a card to another column and placing it in a column.
//
// Pointer-driven, not HTML5 drag and drop. Tauri's drag-drop interception
// swallows the webview's native DnD, so a `draggable` card never receives a
// `drop` (docs/gotchas.md#html5-drag-and-drop-is-dead-inside-the-webview).
// `usePointerReorder.js` covers one vertical list; the board also needs the
// column under the pointer, so the hit-test lives here.
import { computed, onScopeDispose, ref } from 'vue'

// Matches usePointerReorder: a press only becomes a drag once the pointer has
// clearly left the click it started as.
export const DRAG_THRESHOLD_PX = 5
const EDGE_SCROLL_ZONE_PX = 48
const EDGE_SCROLL_STEP_PX = 16
const EDGE_SCROLL_INTERVAL_MS = 16

/**
 * Where a drop at this viewport point lands: the column under the pointer and
 * the card the dragged one goes before (`''` places it last). Off the board,
 * or over the dragged card itself, there is no target.
 */
export function resolveBoardTarget(element, clientY, draggedId = '') {
  const column = element?.closest?.('[data-board-column]')
  if (!column) return null
  const columnId = column.getAttribute('data-board-column')
  const cards = [...column.querySelectorAll('[data-board-card]')]
    .filter(card => card.getAttribute('data-board-card') !== draggedId)
  for (const card of cards) {
    const box = card.getBoundingClientRect()
    if (clientY < box.top + box.height / 2) {
      return { columnId, beforeId: card.getAttribute('data-board-card') }
    }
  }
  return { columnId, beforeId: '' }
}

/**
 * @param boardRef ref to the horizontally scrolling board track
 * @param canDrag  (id) => whether that card may be dragged right now
 * @param onDrop   (id, { columnId, beforeId }) => void
 */
export function useBoardDrag({ boardRef, canDrag = () => true, onDrop }) {
  const draggedId = ref('')
  const target = ref(null)
  const active = ref(false)
  const suppressClick = ref(false)
  const dragging = computed(() => active.value)
  let pending = null
  let point = { x: 0, y: 0 }
  let columnBody = null
  let edgeTimer = null
  let previousBodyCursor = ''
  let previousBodyUserSelect = ''

  function onPointerDown(event, id) {
    if (event.button !== 0 || !canDrag(id)) return
    // Row controls (priority, status, due date) own their own presses.
    if (event.target?.closest?.('button, input, select, textarea')) return
    cancel()
    pending = { id, startX: event.clientX, startY: event.clientY }
    attach()
  }

  function onPointerMove(event) {
    if (!pending) return
    if (!active.value) {
      const distance = Math.abs(event.clientX - pending.startX)
        + Math.abs(event.clientY - pending.startY)
      if (distance < DRAG_THRESHOLD_PX) return
      draggedId.value = pending.id
      active.value = true
      beginDraggingAffordance()
    }
    hover(event.clientX, event.clientY)
  }

  function hover(x, y) {
    point = { x, y }
    const element = document.elementFromPoint(x, y)
    target.value = resolveBoardTarget(element, y, draggedId.value)
    columnBody = element?.closest?.('[data-board-column-body]') || null
    startEdgeScroll()
  }

  // Held at an edge, the board keeps scrolling: the track runs wider than the
  // pane and a column runs longer than it, and a pointer drag gets none of the
  // autoscroll a native drag used to.
  function startEdgeScroll() {
    if (edgeTimer) return
    edgeTimer = setInterval(() => {
      const track = scrollAxis(
        boardRef.value, 'scrollLeft', 'clientWidth', 'scrollWidth', point.x, 'left', 'right',
      )
      const column = scrollAxis(
        columnBody, 'scrollTop', 'clientHeight', 'scrollHeight', point.y, 'top', 'bottom',
      )
      // Scrolling moves the board under a pointer that never moved, so the
      // target has to be read again to follow it.
      if (track || column) hover(point.x, point.y)
    }, EDGE_SCROLL_INTERVAL_MS)
  }

  /** Scrolls one axis if the pointer rests in its edge zone; whether it moved. */
  function scrollAxis(element, offset, client, scroll, position, near, far) {
    if (!element) return false
    const max = element[scroll] - element[client]
    if (max <= 0) return false
    const box = element.getBoundingClientRect()
    const before = element[offset]
    if (position <= box[near] + EDGE_SCROLL_ZONE_PX && before > 0) {
      element[offset] = Math.max(0, before - EDGE_SCROLL_STEP_PX)
    } else if (position >= box[far] - EDGE_SCROLL_ZONE_PX && before < max) {
      element[offset] = Math.min(max, before + EDGE_SCROLL_STEP_PX)
    }
    return element[offset] !== before
  }

  function onPointerUp() {
    const id = draggedId.value
    const dropped = target.value
    const finished = active.value
    cancel()
    if (!finished) return
    // The click that ends the drag still reaches the card under the pointer;
    // without this it would open work the user only dropped onto.
    suppressClick.value = true
    setTimeout(() => {
      suppressClick.value = false
    }, 0)
    if (id && dropped) onDrop(id, dropped)
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || !pending) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  function beginDraggingAffordance() {
    if (!document.body) return
    previousBodyCursor = document.body.style.cursor
    previousBodyUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  function endDraggingAffordance() {
    if (!document.body || !active.value) return
    document.body.style.cursor = previousBodyCursor
    document.body.style.userSelect = previousBodyUserSelect
  }

  function cancel() {
    detach()
    endDraggingAffordance()
    clearInterval(edgeTimer)
    edgeTimer = null
    columnBody = null
    pending = null
    active.value = false
    draggedId.value = ''
    target.value = null
  }

  function attach() {
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', onKeyDown, true)
  }

  function detach() {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', cancel)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  onScopeDispose(cancel)

  return {
    draggedId,
    dragging,
    dropTarget: target,
    suppressClick,
    onPointerDown,
  }
}
