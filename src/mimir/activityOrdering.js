export const ACTIVITY_SORT_MODES = Object.freeze([
  'manual',
  'recent',
  'attention',
  'name',
])

const ATTENTION_RANK = Object.freeze({
  'needs-input': 0,
  error: 1,
  working: 2,
  starting: 3,
  idle: 4,
  ready: 5,
  interrupted: 6,
  stopped: 7,
  done: 8,
})

export function orderActivities(items, {
  mode = 'manual',
  manualOrder = [],
  blockingInputActivityIds = new Set(),
  restoringActivityIds = new Set(),
} = {}) {
  const rows = [...items]
  const canonical = recent(rows)

  if (mode === 'name') {
    return canonical.sort((left, right) => (
      left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
      || left.id.localeCompare(right.id)
    ))
  }
  if (mode === 'attention') {
    return canonical.sort((left, right) => (
      attentionRank(left, blockingInputActivityIds, restoringActivityIds)
        - attentionRank(right, blockingInputActivityIds, restoringActivityIds)
      || timestamp(right.updatedAt) - timestamp(left.updatedAt)
      || left.id.localeCompare(right.id)
    ))
  }
  if (mode === 'recent') return canonical

  const orderIndex = new Map(manualOrder.map((id, index) => [id, index]))
  return canonical.sort((left, right) => {
    const leftIndex = orderIndex.get(left.id)
    const rightIndex = orderIndex.get(right.id)
    const leftOrdered = leftIndex !== undefined
    const rightOrdered = rightIndex !== undefined

    // A newly launched Activity has no saved position yet. It belongs at the
    // top where it is visible, ahead of the user's established manual order.
    if (!leftOrdered && rightOrdered) return -1
    if (leftOrdered && !rightOrdered) return 1
    if (leftOrdered && rightOrdered) return leftIndex - rightIndex

    // Rank unsaved rows against each other by creation, never by updatedAt:
    // PTY output and status changes bump that stamp several times a second,
    // which would make live rows swap places while the user reads them.
    return timestamp(right.createdAt) - timestamp(left.createdAt)
      || left.id.localeCompare(right.id)
  })
}

export function reorderActivityIds(currentIds, movingId, beforeId = null) {
  const reordered = currentIds.filter((id) => id !== movingId)
  if (!beforeId) return [...reordered, movingId]
  const index = reordered.indexOf(beforeId)
  if (index < 0) return [...reordered, movingId]
  reordered.splice(index, 0, movingId)
  return reordered
}

export function moveActivityId(currentIds, movingId, direction) {
  const index = currentIds.indexOf(movingId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= currentIds.length) return [...currentIds]
  const reordered = [...currentIds]
  const [moving] = reordered.splice(index, 1)
  reordered.splice(target, 0, moving)
  return reordered
}

function recent(items) {
  return items.sort((left, right) => (
    timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || left.id.localeCompare(right.id)
  ))
}

function attentionRank(activity, blockingInputActivityIds, restoringActivityIds) {
  if (collectionHas(restoringActivityIds, activity.id)) return ATTENTION_RANK.idle
  if (
    activity.status === 'needs-input'
    && !collectionHas(blockingInputActivityIds, activity.id)
  ) return ATTENTION_RANK.idle
  return ATTENTION_RANK[activity.status] ?? Number.MAX_SAFE_INTEGER
}

function collectionHas(collection, id) {
  return typeof collection?.has === 'function'
    ? collection.has(id)
    : Array.isArray(collection) && collection.includes(id)
}

function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
