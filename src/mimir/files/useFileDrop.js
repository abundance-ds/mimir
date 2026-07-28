// Desktop → Files drag and drop.
//
// The webview never sees an HTML drop for OS drags: Tauri intercepts them and
// reports real filesystem paths through the webview drag-drop event, which is
// what makes dropping *folders* possible at all. The price is that the event
// carries a window position instead of a DOM target, so the hovered row has to
// be hit-tested here.
import { onMounted, onUnmounted, ref } from 'vue'
import { isTauriRuntime, platformKind } from '../../shared/platform.js'
import { normalizeRelative, parentDirectory } from './filePaths.js'

// How long a collapsed folder must stay hovered before it springs open, so
// nested folders are reachable without dropping and dragging again.
export const SPRING_OPEN_MS = 700

// A native drag owns the mouse, so the tree cannot be scrolled by wheel or
// scrollbar while one is in progress. Without this, any row below the fold is
// an unreachable drop target. Holding the pointer near an edge scrolls there.
export const EDGE_SCROLL_ZONE_PX = 28
export const EDGE_SCROLL_STEP_PX = 12
export const EDGE_SCROLL_INTERVAL_MS = 16

/** Drop position → viewport point (CSS pixels), given event units per CSS pixel. */
export function dropPoint(position, scale = 1) {
  const divisor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: (position?.x || 0) / divisor, y: (position?.y || 0) / divisor }
}

/**
 * Tauri types the drop position as `PhysicalPosition`, but it does not convert
 * anything: `tauri-runtime-wry` relabels whatever wry reports. wry uses the
 * platform's own drag coordinates, which are NOT the same units everywhere:
 *
 * - macOS: `draggingLocation` in AppKit points — logical, not physical;
 * - Linux: GTK widget coordinates — also logical;
 * - Windows: `ScreenToClient` output — genuinely physical device pixels.
 *
 * So dividing by `devicePixelRatio` sends every macOS drop up and to the left
 * by the display scale. Verified against wry 0.55 / tauri-runtime-wry 2.11;
 * re-check on a wry bump.
 */
export function dropCoordinatesArePhysical() {
  return platformKind() === 'windows'
}

/**
 * Event units per CSS pixel.
 *
 * Measuring the window against the viewport rather than reading
 * `devicePixelRatio` also folds in interface zoom, which WebKit leaves out of
 * `devicePixelRatio` while it does change CSS pixel size.
 */
export async function measureDropScale() {
  const physical = dropCoordinatesArePhysical()
  const fallback = physical ? (globalThis.devicePixelRatio || 1) : 1
  if (!isTauriRuntime()) return fallback
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const appWindow = getCurrentWindow()
    const size = await appWindow.innerSize()
    const viewport = globalThis.innerWidth
    if (!(size?.width > 0) || !(viewport > 0)) return fallback
    if (physical) return size.width / viewport
    const factor = await appWindow.scaleFactor()
    if (!(factor > 0)) return fallback
    return size.width / factor / viewport
  } catch {
    // Fall through: a stale scale is better than refusing the drop.
  }
  return fallback
}

/**
 * Which way a point sits against a scrollable list's edges: -1 above, 1 below,
 * 0 when it is comfortably inside or the list cannot scroll that way.
 */
export function edgeScrollDirection(list, y, zone = EDGE_SCROLL_ZONE_PX) {
  if (!list) return 0
  const box = list.getBoundingClientRect?.()
  if (!box || box.height <= 0) return 0
  const maxScroll = list.scrollHeight - list.clientHeight
  if (maxScroll <= 0) return 0
  if (y <= box.top + zone) return list.scrollTop > 0 ? -1 : 0
  if (y >= box.bottom - zone) return list.scrollTop < maxScroll ? 1 : 0
  return 0
}

/**
 * Which workspace folder a drop at `element` lands in.
 *
 * Rows for files resolve to their containing folder — the same as Finder — and
 * anywhere else over the tree resolves to the workspace root. `highlightPath`
 * is the row to mark, or '' when the whole panel is the target. Returns null
 * when the point is not over this tree, or over a row whose entry is gone.
 */
export function resolveDropTarget(element, rows = [], listElement = null) {
  if (!element || typeof element.closest !== 'function') return null
  const list = element.closest('[data-files-list]')
  if (!list || (listElement && list !== listElement)) return null

  const rowElement = element.closest('[data-file-row]')
  if (!rowElement) return { relativePath: '', highlightPath: '' }

  const path = rowElement.getAttribute('data-file-row')
  const row = rows.find((item) => item.entry.path === path)
  if (!row || row.missing || row.editing) return null
  if (row.entry.isDirectory) {
    return {
      relativePath: normalizeRelative(row.entry.relativePath),
      highlightPath: row.entry.path,
      collapsedDirectory: row.expanded ? '' : normalizeRelative(row.entry.relativePath),
    }
  }

  const parent = parentDirectory(row.entry.relativePath)
  const parentRow = rows.find(
    (item) => item.entry.isDirectory && normalizeRelative(item.entry.relativePath) === parent,
  )
  return { relativePath: parent, highlightPath: parentRow?.entry.path || '' }
}

/**
 * @param listRef       ref to this panel's tree container
 * @param rows          () => rendered rows, for path lookup
 * @param acceptsDrop   () => whether a workspace is open
 * @param importPaths   (destinationRelativePath, paths) => Promise
 * @param springOpen    (relativePath) => void, expands a hovered folder
 */
export function useFileDrop({ listRef, rows, acceptsDrop, importPaths, springOpen }) {
  const dropTarget = ref(null)
  const importing = ref(false)
  let unlisten = null
  let springTimer = null
  let springPath = ''
  // Re-measured when a drag enters, since the window can be zoomed or moved to
  // another display between drags; the platform default covers the first hover
  // of a drag. `dragToken` retires a measurement whose drag ended in flight.
  let scale = dropCoordinatesArePhysical() ? (globalThis.devicePixelRatio || 1) : 1
  let dragToken = 0
  let edgeTimer = null
  let edgeDirection = 0
  let edgeY = 0

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

  function clearTarget() {
    dragToken += 1
    clearSpring()
    clearEdgeScroll()
    dropTarget.value = null
  }

  // Refuses while an import is running: highlighting a folder that `drop`
  // would then ignore promises something that will not happen.
  function targetAt(position) {
    if (!acceptsDrop() || importing.value) return null
    const { x, y } = dropPoint(position, scale)
    return resolveDropTarget(document.elementFromPoint(x, y), rows(), listRef.value)
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

  function hover(position) {
    const target = targetAt(position)
    dropTarget.value = target
    edgeY = dropPoint(position, scale).y
    updateEdgeScroll(edgeY, Boolean(target))
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

  async function drop(payload) {
    const target = targetAt(payload.position)
    clearTarget()
    const paths = (payload.paths || []).filter(Boolean)
    if (!target || !paths.length || importing.value) return
    importing.value = true
    try {
      await importPaths(target.relativePath, paths)
    } finally {
      importing.value = false
    }
  }

  // Exported for tests, which cannot raise a native drag.
  async function handleDragDrop(payload) {
    if (!payload) return
    if (payload.type === 'enter') {
      const token = ++dragToken
      hover(payload.position)
      const measured = await measureDropScale()
      if (token !== dragToken) return
      scale = measured
      hover(payload.position)
    } else if (payload.type === 'over') {
      hover(payload.position)
    } else if (payload.type === 'drop') {
      await drop(payload)
    } else {
      clearTarget()
    }
  }

  let disposed = false

  onMounted(async () => {
    if (!isTauriRuntime()) return
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      const off = await getCurrentWebview().onDragDropEvent(
        (event) => { void handleDragDrop(event?.payload) },
      )
      // The panel can close while the subscription is still resolving.
      if (disposed) off()
      else unlisten = off
    } catch (error) {
      console.warn('[files] drag and drop is unavailable:', error)
    }
  })

  onUnmounted(() => {
    disposed = true
    clearSpring()
    clearEdgeScroll()
    unlisten?.()
    unlisten = null
  })

  return { dropTarget, importing, handleDragDrop }
}
