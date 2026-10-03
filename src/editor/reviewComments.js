import { commentMetadata, mapCommentRange, readCommentDocument, textChanges, writeCommentDocument } from '../services/comments/document.js'
import { snapCommentAnchor } from '../services/comments/anchor.js'

const logical = value => String(value).replace(/\r\n?/g, '\n')
const copy = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => JSON.stringify(a && commentMetadata(a)) === JSON.stringify(b && commentMetadata(b))

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
    records.push({
      id, before: a, after: b, live: {},
      anchors: {
        ...(a && !a.detached ? { original: { from: a.from, to: a.to } } : {}),
        ...(b && !b.detached ? { proposed: { from: b.from, to: b.to } } : {}),
      },
      proposedOnly: !a,
      change: same(a, b) ? null : !a ? 'Comment added' : !b ? 'Comment removed'
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
  return Object.values(session.commentDecisions || {}).filter(decision => decision === 'pending').length
}

function metadata(session, record, includeRemoved) {
  const decision = session.commentDecisions?.[record.id]
  const source = !record.change || decision === 'rejected' ? record.before : record.after
  if (record.live.deleted) return null
  if (!source && !includeRemoved && !record.live.replies?.length) return null
  const value = source || record.before || record.after
  if (!value) return null
  const replies = [...(value.replies || [])]
  for (const reply of record.live.replies || []) if (!replies.some(item => item.id === reply.id)) replies.push(reply)
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
      const source = session.references[reference]
      if (typeof source !== 'string') continue
      if (!mappings.has(reference)) mappings.set(reference, textChanges(source, target))
      const mapped = mapCommentRange(source, target, anchor, mappings.get(reference))
      const score = mapped.surviving / Math.max(1, anchor.to - anchor.from)
      if (!best || score > best.score || (score === best.score && reference === 'proposed')) best = { ...mapped, score }
    }
    const detached = value.excluded || !best || best.detached
      || (record.proposedOnly && target.slice(best.from, best.to) !== value.quote)
    return [{
      ...value,
      from: best?.from ?? target.length, to: detached ? best?.from ?? target.length : best.to,
      detached: detached ? value.detached || (record.proposedOnly ? 'rejected' : 'removed') : null,
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
  if (current.text !== session.references.original) return
  const previous = readCommentDocument(logical(session.documentContent ?? session.original))
  for (const old of previous.threads) {
    const record = session.comments.find(item => item.id === old.id)
    if (!record) continue
    const latest = current.threads.find(item => item.id === old.id)
    if (!latest) record.live.deleted = true
    else if (!same(old, latest)) {
      record.before = latest
      if (!record.change) record.after = latest
    }
  }
  for (const thread of current.threads) {
    if (session.comments.some(record => record.id === thread.id)) continue
    session.comments.push({ id: thread.id, before: thread, after: thread, change: null, live: {},
      anchors: thread.detached ? {} : { original: { from: thread.from, to: thread.to } } })
  }
  session.documentContent = currentContent
  session.commentRevision++
}

export function mutateReviewComment(session, action, input, author = 'ai', selection = null) {
  if (action === 'add') {
    if (!input.text?.trim()) throw new Error('Comment is empty.')
    const anchor = input.anchor_text
    if (!anchor) throw new Error('Select a passage for the comment.')
    const matches = []
    const sources = selection ? [[selection.reference || 'selection', logical(selection.document)]]
      : [['result', logical(session.result)], ['original', session.references.original]]
    for (const [reference, text] of sources) {
      const from = selection ? selection.from : text.indexOf(anchor)
      if (from < 0 || text.slice(from, from + anchor.length) !== anchor) continue
      if (!selection && text.indexOf(anchor, from + anchor.length) >= 0) throw new Error('The passage occurs more than once. Quote a longer passage.')
      matches.push({ reference, text, from, to: from + anchor.length })
    }
    if (!matches.length) throw new Error('The passage is no longer present. Read the document again.')
    if (matches.length > 1) {
      const mapped = mapCommentRange(matches[0].text, matches[1].text, matches[0])
      if (mapped.detached || mapped.from !== matches[1].from || mapped.to !== matches[1].to) {
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
  return result
}

export function reviewCommentSnapshot(session) {
  return copy({ comments: session.comments, references: session.references, commentRevision: session.commentRevision })
}
