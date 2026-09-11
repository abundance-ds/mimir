export const COMPACT_WORKBENCH_WIDTH = 1040
export const FOCUS_WORKBENCH_WIDTH = 760
export const CONTENT_PANE_MIN_WIDTH = 336

export function responsiveZoneFor(width) {
  if (width < FOCUS_WORKBENCH_WIDTH) return 'focus'
  if (width < COMPACT_WORKBENCH_WIDTH) return 'compact'
  return 'wide'
}

export function fittedEditorWidth(viewportWidth, requestedWidth, sidebarWidth) {
  const viewport = finiteWidth(viewportWidth)
  const requested = Math.max(CONTENT_PANE_MIN_WIDTH, finiteWidth(requestedWidth))
  const sidebar = Math.max(0, finiteWidth(sidebarWidth))
  const available = Math.max(
    CONTENT_PANE_MIN_WIDTH,
    viewport - sidebar - CONTENT_PANE_MIN_WIDTH,
  )
  return Math.min(requested, available)
}

export function fittedSidebarWidth(viewportWidth, requestedWidth, contentRailWidth = 44) {
  return Math.min(finiteWidth(requestedWidth), Math.max(240,
    finiteWidth(viewportWidth) - CONTENT_PANE_MIN_WIDTH - contentRailWidth))
}

export function applyResponsiveZone(workbench, zone, {
  preferEditor = false,
} = {}) {
  if (zone === 'wide') return

  workbench.setPaneState('sidebar', 'rail')
  if (zone === 'compact') return

  if (preferEditor) {
    workbench.setPaneState('activity', 'rail')
    workbench.setPaneState('editor', 'expanded')
  } else {
    workbench.setPaneState('editor', 'rail')
    workbench.setPaneState('activity', 'expanded')
  }
}

function finiteWidth(value) {
  const width = Number(value)
  return Number.isFinite(width) ? width : 0
}
