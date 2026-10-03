import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'

const logicalText = value => String(value).replace(/\r\n?/g, '\n')
const text = value => Text.of(logicalText(value).split('\n'))

// The immutable source and proposal are separate from the comparison baseline.
// Accept advances the baseline; reject changes the result. Both must survive
// replacement of a CodeMirror view, and both belong to the same Undo step.
export function createReviewSession(original, proposed) {
  const lineEnding = proposed.match(/\r\n?|\n/)?.[0] || original.match(/\r\n?|\n/)?.[0] || '\n'
  const serialize = value => logicalText(value).replace(/\n/g, lineEnding)
  const session = {
    original, proposed, lineEnding,
    base: serialize(original), result: serialize(proposed),
    past: [], future: [], revision: 0, pending: 0,
    position: null, currentChunk: 0,
  }
  session.pending = reviewChunks(session).length
  return session
}

export function reviewChunks(session) {
  return Chunk.build(text(session.base), text(session.result), { scanLimit: 5000 })
}

function snapshot(session) {
  return { base: session.base, result: session.result, pending: session.pending }
}

export function recordReview(session, base, result, action = 'edit') {
  if (base === session.base && result === session.result) return false
  session.past.push({ ...snapshot(session), action })
  session.future = []
  session.base = base
  session.result = result
  session.pending = reviewChunks(session).length
  session.currentChunk = Math.min(session.currentChunk, Math.max(0, session.pending - 1))
  return true
}

export function decideRemaining(session, action) {
  const changed = action === 'accept'
    ? recordReview(session, session.result, session.result, 'accept remaining')
    : recordReview(session, session.base, session.base, 'reject remaining')
  if (changed) session.revision++
  return changed
}

export function moveReviewHistory(session, direction) {
  const from = direction === 'undo' ? session.past : session.future
  const to = direction === 'undo' ? session.future : session.past
  const previous = from.pop()
  if (!previous) return false
  to.push({ ...snapshot(session), action: previous.action })
  Object.assign(session, { base: previous.base, result: previous.result, pending: previous.pending })
  session.revision++
  return true
}

export function reviewStatus(session) {
  if (session.pending) return 'pending'
  return logicalText(session.result) === logicalText(session.original) ? 'rejected' : 'accepted'
}
