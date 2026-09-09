// Interface zoom: whole-window webview zoom, persisted as `workbenchZoom` (percent)
// in settings. Distinct from the editor's content zoom (editorUI.zoomLevel),
// which scales only editor text and is controlled from the editor footer.
import { isTauriRuntime } from './platform.js'

import { shortcutForEvent } from './shortcuts.js'

export const WORKBENCH_ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
export const DEFAULT_WORKBENCH_ZOOM = 100

const MIN_WORKBENCH_ZOOM = WORKBENCH_ZOOM_LEVELS[0]
const MAX_WORKBENCH_ZOOM = WORKBENCH_ZOOM_LEVELS[WORKBENCH_ZOOM_LEVELS.length - 1]

export function clampWorkbenchZoom(value) {
  // Number() would coerce null/'' to 0 and silently clamp them to minimum.
  const numeric = Math.round(typeof value === 'number' ? value : Number.parseFloat(value))
  if (!Number.isFinite(numeric)) return DEFAULT_WORKBENCH_ZOOM
  return Math.min(MAX_WORKBENCH_ZOOM, Math.max(MIN_WORKBENCH_ZOOM, numeric))
}

export function nextWorkbenchZoom(current, action) {
  if (action === 'reset') return DEFAULT_WORKBENCH_ZOOM
  const zoom = clampWorkbenchZoom(current)
  if (action === 'in') {
    return WORKBENCH_ZOOM_LEVELS.find((level) => level > zoom) ?? MAX_WORKBENCH_ZOOM
  }
  if (action === 'out') {
    return WORKBENCH_ZOOM_LEVELS.findLast((level) => level < zoom) ?? MIN_WORKBENCH_ZOOM
  }
  return zoom
}

// Ctrl shortcuts on macOS remain available to terminal shells.
export function workbenchZoomKeyAction(event) {
  const binding = shortcutForEvent(event, ['global'])
  return binding?.id.startsWith('zoom-') ? binding.id.slice(5) : null
}

export async function applyWorkbenchZoom(percent) {
  if (!isTauriRuntime()) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(clampWorkbenchZoom(percent) / 100)
  } catch (error) {
    console.warn('[workbenchZoom] could not apply interface zoom:', error)
  }
}
