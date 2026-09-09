export function routeWorkbenchKey({
  key,
  primary,
  alt = false,
  shift = false,
  focusOwner = 'none',
  sidebarActivityId = '',
  sidebarSelectionCount = 0,
}) {
  if (!primary) return null
  const normalized = String(key || '').toLowerCase()

  if (!alt && !shift && normalized === 'p') return { action: 'quick-open' }
  if (!alt && !shift && ['t', 'n'].includes(normalized) && focusOwner === 'activity') return { action: 'new-tab' }
  if (!alt && !shift && normalized === 'b') return { action: 'toggle-sidebar' }

  if (alt && !shift && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const direction = key === 'ArrowLeft' ? -1 : 1
    if (focusOwner === 'editor') return { action: 'cycle-editor', direction }
    if (focusOwner === 'activity' || focusOwner === 'sidebar') {
      return { action: 'cycle-activity', direction }
    }
    return null
  }

  if (!alt && !shift && normalized === 'w') {
    if (focusOwner === 'editor') return { action: 'close-editor' }
    if (focusOwner === 'activity') return { action: 'close-activity', activityId: '' }
    if (focusOwner === 'sidebar') {
      if (sidebarSelectionCount > 0) return { action: 'close-selected-activities' }
      if (sidebarActivityId) {
        return { action: 'close-activity', activityId: sidebarActivityId }
      }
    }
    return { action: 'close-focused' }
  }

  return null
}
