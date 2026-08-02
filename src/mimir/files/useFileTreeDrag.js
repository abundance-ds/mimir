// Files → Files drag and drop: moving rows between folders inside the tree.
//
// This is pointer-driven, not HTML5 drag and drop. Tauri's drag-drop
// interception (which useFileDrop.js depends on for OS drops) swallows the
// webview's native DnD events, so `draggable` rows would never receive a drop.
// Pointer events are untouched by that interception, and they let a drag share
// the external drop path's hit-testing, spring-open, and edge-scroll behavior.
import { computed, onScopeDispose, ref } from 'vue'
import { normalizeRelative, parentDirectory } from './filePaths.js'
import {
  EDGE_SCROLL_INTERVAL_MS,
  EDGE_SCROLL_STEP_PX,
  SPRING_OPEN_MS,
  edgeScrollDirection,
  resolveDropTarget,
} from './useFileDrop.js'

// Matches usePointerReorder: a press only becomes a drag once the pointer has
// clearly left the click it started as.
export const DRAG_THRESHOLD_PX = 5

/** Whether moving `entry` into the folder `target` would change anything. */
export function wouldMove(entry, target) {
  const relativePath = normalizeRelative(entry?.relativePath)
  if (!relativePath) return false
  if (parentDirectory(relativePath) === target) return false
  if (entry.isDirectory
    && (target === relativePath || target.startsWith(`${relativePath}/`))) return false
  return true
}

/**
 * The external drop target, narrowed to what an internal move can accept: a
 * drop that would move nothing (everything already lives there, or the target
 * sits inside a dragged folder) offers no target at all rather than a
 * highlight that a drop would ignore.
 */
export function resolveMoveTarget(element, rows, listElement, entries) {
  const target = resolveDropTarget(element, rows, listElement)
  if (!target) return null
  const destination = normalizeRelative(target.relativePath)
  if (!entries.some(entry => wouldMove(entry, destination))) return null
  const draggedDirectories = entries.filter(entry => entry.isDirectory)
  if (draggedDirectories.some((entry) => {
    const relativePath = normalizeRelative(entry.relativePath)
    return destination === relativePath || destination.startsWith(`${relativePath}/`)
  })) return null
  return target
}

/**
 * @param listRef     ref to this panel's tree container
 * @param rows        () => rendered rows, for path lookup and hit-testing
 * @param canDrag     () => whether rows may be dragged right now
 * @param dragEntries (row) => entries the drag carries
 * @param onMove      (entries, destinationRelativePath) => Promise
 * @param springOpen  (relativePath) => void, expands a hovered folder
 */
export function useFileTreeDrag({ listRef, rows, canDrag, dragEntries, onMove, springOpen }) {
  const dropTarget = ref(null)
  const entries = ref([])
  const pointer = ref({ x: 0, y: 0 })
  const active = ref(false)
  const suppressClick = ref(false)
  const dragging = computed(() => active.value)
  const draggedPaths = computed(() => new Set(entries.value.map(entry => entry.path)))
  let pending = null
  let springTimer = null
  let springPath = ''
  let edgeTimer = null
  let edgeDirection = 0
  let edgeY = 0
  let previousBodyCursor = ''
  let previousBodyUserSelect = ''

  function onPointerDown(event) {
    if (event.button !== 0 || !canDrag()) return
    if (event.target?.closest?.('[data-file-favorite], input, form')) return
    const rowElement = event.target?.closest?.('[data-file-row]')
    if (!rowElement) return
    const path = rowElement.getAttribute('data-file-row')
    const row = rows().find(item => item.entry.path === path)
    if (!row || row.missing || row.editing) return
    cancel()
    pending = { path, startX: event.clientX, startY: event.clientY }
    attach()
  }

  function onPointerMove(event) {
    if (!pending) return
    if (!active.value) {
      const distance = Math.abs(event.clientX - pending.startX)
        + Math.abs(event.clientY - pending.startY)
      if (distance < DRAG_THRESHOLD_PX) return
      const row = rows().find(item => item.entry.path === pending.path)
      const carried = row ? dragEntries(row) : []
      if (!carried.length) {
        cancel()
        return
      }
      entries.value = carried
      active.value = true
      beginDraggingAffordance()
    }
    hover(event.clientX, event.clientY)
  }

  function hover(x, y) {
    pointer.value = { x, y }
    const target = resolveMoveTarget(
      document.elementFromPoint(x, y),
      rows(),
      listRef.value,
      entries.value,
    )
    dropTarget.value = target
    edgeY = y
    updateEdgeScroll(y, Boolean(target))
    const collapsed = target?.collapsedDirectory || ''
    if (collapsed !== springPath) {
      clearSpring()
      if (collapsed) {
        springPath = collapsed
        springTimer = setTimeout(() => {
          springTimer = null
          springOpen?.(collapsed)
        }, SPRING_OPEN_MS)
      }
    }
  }

  function updateEdgeScroll(y, accepted) {
    const direction = accepted ? edgeScrollDirection(listRef.value, y) : 0
    if (direction === edgeDirection) return
    clearEdgeScroll()
    if (!direction) return
    edgeDirection = direction
    edgeTimer = setInterval(() => {
      const list = listRef.value
      if (!list || !edgeScrollDirection(list, edgeY)) {
        clearEdgeScroll()
        return
      }
      list.scrollTop += edgeDirection * EDGE_SCROLL_STEP_PX
    }, EDGE_SCROLL_INTERVAL_MS)
  }

  function onPointerUp() {
    const target = dropTarget.value
    const carried = entries.value
    const finished = active.value
    cancel()
    if (!finished) return
    // The click that ends the drag still reaches the row under the pointer;
    // without this it would toggle a folder or open a file the user only
    // dropped onto.
    suppressClick.value = true
    setTimeout(() => {
      suppressClick.value = false
    }, 0)
    if (target && carried.length) {
      void onMove(carried, normalizeRelative(target.relativePath))
    }
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

  function clearSpring() {
    clearTimeout(springTimer)
    springTimer = null
    springPath = ''
  }

  function clearEdgeScroll() {
    clearInterval(edgeTimer)
    edgeTimer = null
    edgeDirection = 0
  }

  function cancel() {
    detach()
    endDraggingAffordance()
    clearSpring()
    clearEdgeScroll()
    pending = null
    active.value = false
    entries.value = []
    dropTarget.value = null
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
    dragging,
    draggedPaths,
    dropTarget,
    entries,
    pointer,
    suppressClick,
    onPointerDown,
  }
}
