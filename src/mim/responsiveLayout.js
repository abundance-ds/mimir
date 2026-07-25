export const COMPACT_WORKBENCH_WIDTH = 1040
export const FOCUS_WORKBENCH_WIDTH = 760

export function responsiveZoneFor(width) {
  if (width < FOCUS_WORKBENCH_WIDTH) return 'focus'
  if (width < COMPACT_WORKBENCH_WIDTH) return 'compact'
  return 'wide'
}

export function applyResponsiveZone(workbench, zone, {
  preferEditor = false,
  desktopLayout = null,
} = {}) {
  if (zone === 'wide') {
    if (desktopLayout) workbench.restoreLayout(desktopLayout)
    return
  }

  workbench.setPaneState('sidebar', 'rail')
  if (zone === 'compact') {
    workbench.setPaneState(
      'activity',
      desktopLayout?.activity?.state === 'rail' ? 'rail' : 'expanded',
    )
    workbench.setPaneState(
      'editor',
      desktopLayout?.editor?.state === 'rail' ? 'rail' : 'expanded',
    )
    return
  }

  if (preferEditor) {
    workbench.setPaneState('activity', 'rail')
    workbench.setPaneState('editor', 'expanded')
  } else {
    workbench.setPaneState('editor', 'rail')
    workbench.setPaneState('activity', 'expanded')
  }
}
