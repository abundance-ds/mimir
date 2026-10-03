import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'
import { createReviewComments, pendingCommentChanges } from './reviewComments.js'

const logicalText = value => String(value).replace(/\r\n?/g, '\n')
const text = value => Text.of(logicalText(value).split('\n'))

// The immutable source and proposal are separate from the comparison baseline.
// Accept advances the baseline; reject changes the result. Both must survive
// replacement of a CodeMirror view, and both belong to the same Undo step.
export function createReviewSession(original, proposed) {
  const lineEnding = proposed.match(/\r\n?|\n/)?.[0] || original.match(/\r\n?|\n/)?.[0] || '\n'
  const serialize = value => logicalText(value).replace(/\n/g, lineEnding)
  const comments = createReviewComments(original, proposed)
  const session = {
    version: 1, id: crypto.randomUUID(), original, proposed, lineEnding,
    ...comments,
    documentContent: original,
    base: serialize(comments.references.original), result: serialize(comments.references.proposed),
    past: [], future: [], revision: 0, pending: 0,
    position: null, currentChunk: 0,
  }
  session.pending = reviewChunks(session).length + pendingCommentChanges(session)
  return session
}

export function reviewChunks(session) {
  return Chunk.build(text(session.base), text(session.result), { scanLimit: 5000 })
}

function snapshot(session) {
  return { base: session.base, result: session.result, pending: session.pending, commentDecisions: { ...session.commentDecisions } }
}

export function recordReview(session, base, result, action = 'edit') {
  if (base === session.base && result === session.result) return false
  session.past.push({ ...snapshot(session), action })
  session.future = []
  session.base = base
  session.result = result
  session.pending = reviewChunks(session).length + pendingCommentChanges(session)
  session.currentChunk = Math.min(session.currentChunk, Math.max(0, session.pending - 1))
  return true
}

export function decideRemaining(session, action) {
  const before = snapshot(session)
  let commentsChanged = false
  for (const [id, value] of Object.entries(session.commentDecisions || {})) {
    if (value !== 'pending') continue
    session.commentDecisions[id] = action === 'accept' ? 'accepted' : 'rejected'
    commentsChanged = true
  }
  const changed = action === 'accept'
    ? recordReview(session, session.result, session.result, 'accept remaining')
    : recordReview(session, session.base, session.base, 'reject remaining')
  if (changed) session.past[session.past.length - 1].commentDecisions = before.commentDecisions
  else if (commentsChanged) { session.past.push({ ...before, action }); session.future = [] }
  session.pending = reviewChunks(session).length + pendingCommentChanges(session)
  if (changed || commentsChanged) session.revision++
  return changed || commentsChanged
}

export function decideCommentChange(session, id, decision) {
  if (!Object.hasOwn(session.commentDecisions || {}, id) || !['accepted', 'rejected'].includes(decision)) return false
  session.past.push({ ...snapshot(session), action: 'comment change' })
  session.future = []
  session.commentDecisions[id] = decision
  session.pending = reviewChunks(session).length + pendingCommentChanges(session)
  session.revision++
  return true
}

export function moveReviewHistory(session, direction) {
  const from = direction === 'undo' ? session.past : session.future
  const to = direction === 'undo' ? session.future : session.past
  const previous = from.pop()
  if (!previous) return false
  to.push({ ...snapshot(session), action: previous.action })
  Object.assign(session, { base: previous.base, result: previous.result, pending: previous.pending, commentDecisions: previous.commentDecisions || {} })
  session.revision++
  return true
}

export function reviewStatus(session) {
  if (session.pending) return 'pending'
  return logicalText(session.result) === (session.references?.original ?? logicalText(session.original))
    && !Object.values(session.commentDecisions || {}).includes('accepted') ? 'rejected' : 'accepted'
}
