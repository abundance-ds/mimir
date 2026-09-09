// The six valid layouts share one control ownership policy.
export function paneControls(layout, pane) {
  const mainRail = layout.activity.state === 'rail'
  const sidebarRail = layout.sidebar.state === 'rail'
  const visible = layout[pane].state === 'expanded'
  const leading = []
  if (visible && ((pane === 'activity' && sidebarRail) || (pane === 'editor' && mainRail && sidebarRail))) leading.push('sidebar')
  if (visible && pane === 'editor' && mainRail) leading.push('activity')
  return {
    leading,
    expanded: visible && layout[pane === 'activity' ? 'editor' : 'activity'].state === 'rail',
    quietRail: pane === 'activity',
  }
}
