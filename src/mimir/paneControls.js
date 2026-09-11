// The six valid layouts share one control ownership policy.
export function paneControls(layout, pane) {
  const mainRail = layout.activity.state === 'rail'
  const visible = layout[pane].state === 'expanded'
  const leading = []
  if (visible && pane === 'editor' && mainRail) leading.push('activity')
  return {
    leading,
    expanded: visible && layout[pane === 'activity' ? 'editor' : 'activity'].state === 'rail',
    quietRail: pane === 'activity',
  }
}
