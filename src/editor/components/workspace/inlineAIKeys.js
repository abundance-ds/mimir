export function inlineAIKeyAction(event, { hasPendingEdit = false } = {}) {
  if (event.key === 'Escape') return 'escape'
  if (event.key !== 'Enter') return null
  if ((event.metaKey || event.ctrlKey) && hasPendingEdit) return 'accept'
  if (!event.shiftKey) return 'submit'
  return null
}
