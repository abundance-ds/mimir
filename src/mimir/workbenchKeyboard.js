import { matchShortcut } from '../shared/shortcuts.js'

export function routeWorkbenchKey({
  key,
  primary,
  alt = false,
  shift = false,
  focusOwner = 'none',
  sidebarActivityId = '',
  sidebarSelectionCount = 0,
}) {
  const binding = matchShortcut({ key, primary, alt, shift }, ['global', 'panel'])
  if (!binding) return null
  if (binding.scope === 'global') return { action: binding.id }

  if (binding.id.startsWith('cycle-')) {
    const direction = binding.direction
    if (focusOwner === 'editor') return { action: 'cycle-editor', direction }
    if (focusOwner === 'activity' || focusOwner === 'sidebar') {
      return { action: 'cycle-activity', direction }
    }
    return null
  }

  if (binding.id === 'close') {
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
