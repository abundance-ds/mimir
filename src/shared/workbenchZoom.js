// Interface zoom: whole-window webview zoom, persisted as `workbenchZoom` (percent)
// in settings. Distinct from the editor's content zoom (editorUI.zoomLevel),
// which scales only editor text and is controlled from the editor footer.
import { isTauriRuntime, primaryModifierPressed } from './platform.js'

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

function isZoomInKey(event) {
  return event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd'
}

function isZoomOutKey(event) {
  return event.key === '-' || event.key === '_' || event.code === 'Minus' || event.code === 'NumpadSubtract'
}

function isZoomResetKey(event) {
  return event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0'
}

// Primary modifier only (Cmd on macOS): Ctrl+- must keep reaching terminal
// shells on macOS, where it is readline undo.
export function workbenchZoomKeyAction(event) {
  if (!primaryModifierPressed(event) || event.altKey) return null
  if (isZoomInKey(event)) return 'in'
  if (isZoomOutKey(event)) return 'out'
  if (isZoomResetKey(event)) return 'reset'
  return null
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
