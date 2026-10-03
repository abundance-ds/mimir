import { commentMetadata, mapCommentRange, readCommentDocument, textChanges, writeCommentDocument } from '../services/comments/document.js'
import { snapCommentAnchor } from '../services/comments/anchor.js'

const logical = value => String(value).replace(/\r\n?/g, '\n')
const same = (a, b) => JSON.stringify(a && commentMetadata(a)) === JSON.stringify(b && commentMetadata(b))
const sameAttachment = (a, b) => a && b && a.from === b.from && a.to === b.to && a.detached === b.detached && a.quote === b.quote

export function createReviewComments(original, proposed) {
  const before = readCommentDocument(logical(original))
  const after = readCommentDocument(logical(proposed))
  const records = []
  for (const id of new Set([...before.threads, ...after.threads].map(thread => thread.id))) {
    const a = before.threads.find(thread => thread.id === id) || null
    let b = after.threads.find(thread => thread.id === id) || null
    const removedWithText = a && !b && before.text !== after.text
      && mapCommentRange(before.text, after.text, a).detached
    if (removedWithText) b = { ...a, detached: 'removed' }
    const moved = Boolean(a && b && before.text === after.text && !sameAttachment(a, b))
    records.push({
      id, before: a, after: b, live: {},
      anchors: {
        ...(a && !a.detached ? { original: { from: a.from, to: a.to } } : {}),
        ...(b && !b.detached ? { proposed: { from: b.from, to: b.to } } : {}),
      },
      proposedOnly: !a,
      moved,
      change: same(a, b) ? (moved ? 'Comment moved' : null) : !a ? 'Comment added' : !b ? 'Comment removed'
        : a.status !== b.status ? (b.status === 'resolved' ? 'Comment resolved' : 'Comment reopened')
          : a.replies.length !== b.replies.length ? 'Replies changed' : 'Comment changed',
    })
  }
  return {
    references: { original: before.text, proposed: after.text },
    comments: records,
    commentDecisions: Object.fromEntries(records.filter(record => record.change).map(record => [record.id, 'pending'])),
    commentRevision: 0,
    commentUI: { open: records.some(record => record.change), activeId: records.find(record => record.change)?.id || null, showResolved: false, drafts: {}, compose: null },
  }
}

export function pendingCommentChanges(session) {
  return Object.entries(session.commentDecisions || {}).filter(([id, decision]) => decision === 'pending'
    && !session.comments?.find(record => record.id === id)?.live.deleted).length
}

function metadata(session, record, includeRemoved) {
  const decision = session.commentDecisions?.[record.id]
  const source = !record.change || decision === 'rejected' ? record.before : record.after
  if (record.live.deleted) return null
  if (!source && !includeRemoved && !record.live.replies?.length) return null
  const value = source || record.before || record.after
  if (!value) return null
  const replies = [...(value.replies || [])].filter(reply => !record.live.deletedReplies?.includes(reply.id))
  for (const reply of record.live.replies || []) {
    const index = replies.findIndex(item => item.id === reply.id)
    if (index < 0) replies.push(reply)
    else replies[index] = reply
  }
  return {
    ...value, ...record.live, replies,
    ...(record.change ? { change: record.change, decision } : {}),
    excluded: !source,
  }
}

export function reviewComments(session, text = session.result, { includeRemoved = false } = {}) {
  const target = logical(text)
  const mappings = new Map()
  return (session.comments || []).flatMap(record => {
    const value = metadata(session, record, includeRemoved)
    if (!value) return []
    let best = null
    for (const [reference, anchor] of Object.entries(record.anchors)) {
      if (record.moved && reference !== (session.commentDecisions[record.id] === 'rejected' ? 'original' : 'proposed')) continue
      const source = session.references[reference]
      if (typeof source !== 'string') continue
      if (!mappings.has(reference)) mappings.set(reference, textChanges(source, target))
      const mapped = mapCommentRange(source, target, anchor, mappings.get(reference))
      const score = mapped.detached ? 0 : mapped.surviving / Math.max(1, anchor.to - anchor.from)
      if (!best || score > best.score || (score === best.score && reference === 'proposed')) best = { ...mapped, score }
    }
    const detached = value.excluded || !best || best.detached
      || (record.proposedOnly && target.slice(best.from, best.to) !== value.quote)
    return [{
      ...value,
      from: best?.from ?? target.length, to: detached ? best?.from ?? target.length : best.to,
      detached: detached ? value.detached || (record.proposedOnly ? 'rejected' : best?.reason || 'removed') : null,
      quote: value.quote || '',
      anchorText: detached ? value.quote || '' : target.slice(best.from, best.to),
    }]
  })
}

export function reviewContent(session, text = session.result) {
  if (!session.references) return text
  const result = writeCommentDocument(logical(text), reviewComments(session, text))
  return result.replace(/\n/g, session.lineEnding || '\n')
}

export function syncReviewComments(session, currentContent) {
  if (!session.references || currentContent === session.documentContent) return
  const current = readCommentDocument(logical(currentContent))
  const textChanged = current.text !== session.references.original
  const reference = textChanged
    ? Object.keys(session.references).find(key => session.references[key] === current.text) || `document-${crypto.randomUUID()}`
    : 'original'
  session.references[reference] = current.text
  const pendingBefore = pendingCommentChanges(session)
  const previous = readCommentDocument(logical(session.documentContent ?? session.original))
  for (const old of previous.threads) {
    const record = session.comments.find(item => item.id === old.id)
    if (!record) continue
    const latest = current.threads.find(item => item.id === old.id)
    if (!latest) {
      // A concurrent prose deletion must not become an implicit discussion
      // deletion when the user rejects the now-stale review.
      if (!textChanged) record.live.deleted = true
    }
    else if (!same(old, latest) || !sameAttachment(old, latest)) {
      if (old.status !== latest.status) record.live.status = latest.status
      const changed = latest.replies.filter(reply => JSON.stringify(reply) !== JSON.stringify(old.replies.find(item => item.id === reply.id)))
      record.live.replies = [...(record.live.replies || []).filter(reply => !changed.some(item => item.id === reply.id)), ...changed]
      record.live.deletedReplies = [...new Set([...(record.live.deletedReplies || []), ...old.replies.filter(reply => !latest.replies.some(item => item.id === reply.id)).map(reply => reply.id)])]
      record.before = latest
      if (!record.change) record.after = latest
      if (!latest.detached) record.anchors[reference] = { from: latest.from, to: latest.to }
    }
  }
  for (const thread of current.threads) {
    if (session.comments.some(record => record.id === thread.id)) continue
    session.comments.push({ id: thread.id, before: thread, after: thread, change: null, live: {},
      anchors: thread.detached ? {} : { [reference]: { from: thread.from, to: thread.to } } })
  }
  session.documentContent = currentContent
  session.commentRevision++
  session.pending += pendingCommentChanges(session) - pendingBefore
}

export function mutateReviewComment(session, action, input, author = 'ai', selection = null) {
  const pendingBefore = pendingCommentChanges(session)
  if (action === 'add') {
    if (!input.text?.trim()) throw new Error('Comment is empty.')
    const anchor = input.anchor_text
    if (!anchor) throw new Error('Select a passage for the comment.')
    const matches = []
    const sources = selection ? [[selection.reference || 'selection', logical(selection.document)]]
      : [['result', logical(session.result)], ['original', session.references.original], ['comparison', logical(session.base)]]
    for (const [reference, text] of sources) {
      const from = selection ? selection.from : text.indexOf(anchor)
      if (from < 0 || text.slice(from, from + anchor.length) !== anchor) continue
      if (!selection && text.indexOf(anchor, from + anchor.length) >= 0) throw new Error('The passage occurs more than once. Quote a longer passage.')
      matches.push({ reference, text, from, to: from + anchor.length })
    }
    if (!matches.length) throw new Error('The passage is no longer present. Read the document again.')
    for (const other of matches.slice(1)) {
      const mapped = mapCommentRange(matches[0].text, other.text, matches[0])
      if (mapped.detached || mapped.from !== other.from || mapped.to !== other.to) {
        throw new Error('The quotation identifies different passages in the document and proposal. Quote more surrounding text.')
      }
    }
    const match = matches[0]
    const range = snapCommentAnchor(match.text, match.from, match.to)
    if (!range) throw new Error('Select passage text, not only Markdown marks.')
    if (reviewComments(session, match.text).some(thread => !thread.detached && range.from < thread.to && range.to > thread.from)) {
      throw new Error('This passage already has a discussion. Reply to it or select another passage.')
    }
    const reference = Object.keys(session.references).find(key => session.references[key] === match.text) || `comment-${crypto.randomUUID()}`
    session.references[reference] = match.text
    const id = crypto.randomUUID()
    const thread = { id, author, text: input.text.trim(), status: 'active', created: new Date().toISOString(), replies: [], quote: match.text.slice(range.from, range.to) }
    const originalRange = mapCommentRange(match.text, session.references.original, range)
    const proposedOnly = originalRange.detached || session.references.original.slice(originalRange.from, originalRange.to) !== thread.quote
    session.comments.push({ id, before: thread, after: thread, discussion: true, proposedOnly, change: null, live: {}, anchors: { [reference]: range } })
    session.commentRevision++
    return { comment_id: id, status: 'created', anchor: thread.quote.slice(0, 80) }
  }
  const record = session.comments.find(item => item.id === input.comment_id)
  if (!record || record.live.deleted) throw new Error('Comment not found.')
  let result = { comment_id: record.id }
  if (action === 'reply') {
    if (!input.text?.trim()) throw new Error('Reply is empty.')
    const reply = { id: crypto.randomUUID(), author, text: input.text.trim(), ts: new Date().toISOString() }
    record.live.replies = [...(record.live.replies || []), reply]
    result = { ...result, reply_id: reply.id, status: 'replied' }
  } else if (action === 'resolve' || action === 'reopen') {
    record.live.status = action === 'resolve' ? 'resolved' : 'active'
    result.status = record.live.status
  } else if (action === 'delete') {
    record.live.deleted = true
    result.status = 'deleted'
  } else throw new Error(`Unknown comment action: ${action}`)
  session.commentRevision++
  session.pending += pendingCommentChanges(session) - pendingBefore
  return result
}
