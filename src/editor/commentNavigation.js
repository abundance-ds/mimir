export function commentNavigationTarget(comments, {
  activeId = null,
  cursorPos = 0,
  direction = 'next',
} = {}) {
  if (!comments?.length) return null

  const ordered = comments
    .slice()
    .sort((a, b) => (a.contentFrom ?? 0) - (b.contentFrom ?? 0))
  const step = direction === 'previous' ? -1 : 1
  const activeIndex = ordered.findIndex(comment => comment.id === activeId)

  if (activeIndex >= 0) {
    return ordered[(activeIndex + step + ordered.length) % ordered.length]
  }

  if (step > 0) {
    return ordered.find(comment => (comment.contentFrom ?? 0) >= cursorPos) || ordered[0]
  }

  return ordered
    .slice()
    .reverse()
    .find(comment => (comment.contentFrom ?? 0) < cursorPos) || ordered[ordered.length - 1]
}
