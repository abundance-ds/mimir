import { ChangeSet } from '@codemirror/state'
import { diff } from '@codemirror/merge'
import { buildCommentTag, parseCommentTags, rawToCleanPos } from './parser.js'

export function commentMetadata(comment) {
  return {
    id: comment.id, author: comment.author || 'user', text: comment.text || '',
    status: comment.status || 'active', created: comment.created,
    replies: (comment.replies || []).map(reply => ({ ...reply })),
  }
}

export function readCommentDocument(source) {
  const parsed = parseCommentTags(source)
  return {
    text: parsed.cleanText,
    threads: parsed.comments.map(comment => ({
      ...commentMetadata(comment), from: comment.cleanFrom, to: comment.cleanTo,
      quote: comment.quote ?? comment.anchorText,
      detached: comment.detached || null,
      // Reuse stored spelling and optional attributes on text-only edits.
      source: {
        open: source.slice(comment.tagFrom, comment.contentFrom),
        tail: source.slice(comment.contentTo, comment.tagTo),
        metadata: JSON.stringify(commentMetadata(comment)),
        detached: comment.detached || null,
      },
    })),
  }
}

export function textChanges(before, after) {
  return ChangeSet.of(diff(before, after, { scanLimit: 5000 }).map(change => ({
    from: change.fromA, to: change.toA, insert: after.slice(change.fromB, change.toB),
  })), before.length)
}

// Map the known occurrence, never search for a similar sentence elsewhere.
// A fully replaced/deleted anchor is kept as a quoted, detached discussion.
export function mapCommentRange(before, after, range, changes = textChanges(before, after)) {
  const from = changes.mapPos(Math.min(range.from, before.length), 1)
  const to = changes.mapPos(Math.min(range.to, before.length), -1)
  let surviving = Math.max(0, range.to - range.from)
  changes.iterChangedRanges((a, b) => { surviving -= Math.max(0, Math.min(b, range.to) - Math.max(a, range.from)) })
  return { from, to: Math.max(from, to), surviving: Math.max(0, surviving), detached: to <= from || surviving <= 0 }
}

export function writeCommentDocument(text, threads) {
  const ordered = threads.slice().sort((a, b) => a.from - b.from || a.to - b.to)
  const detached = []
  let cursor = 0
  let result = ''
  for (const thread of ordered) {
    if (thread.detached || thread.to <= thread.from || thread.from < cursor) {
      // Overlapping discussions remain readable without creating nested XML.
      detached.push({ ...thread, detached: thread.detached || 'changed' })
      continue
    }
    result += text.slice(cursor, thread.from) + render(thread, text.slice(thread.from, thread.to))
    cursor = thread.to
  }
  result += text.slice(cursor)
  for (const thread of detached) result += render(thread, '')
  return result
}

function render(thread, anchorText) {
  if (thread.source && (thread.detached || null) === thread.source.detached
    && JSON.stringify(commentMetadata(thread)) === thread.source.metadata) {
    return thread.source.open + anchorText + thread.source.tail
  }
  return buildCommentTag({ ...thread, anchorText })
}

export function rewriteCommentDocument(source, text) {
  const document = readCommentDocument(source)
  if (document.text === text) return source
  const changes = textChanges(document.text, text)
  return writeCommentDocument(text, document.threads.map(thread => {
    if (thread.detached) return thread
    const range = mapCommentRange(document.text, text, thread, changes)
    return { ...thread, from: range.from, to: range.to, detached: range.detached ? 'removed' : null }
  }))
}

// Agent replacements may start inside a comment and end outside it. Replace
// prose first, then map complete threads; slicing the raw range breaks tags.
export function replaceCommentText(source, from, to, replacement) {
  const parsed = parseCommentTags(source)
  if (!parsed.comments.length) return source.slice(0, from) + replacement + source.slice(to)
  const start = rawToCleanPos(parsed.comments, from)
  const end = rawToCleanPos(parsed.comments, to)
  const text = parsed.cleanText.slice(0, start) + replacement + parsed.cleanText.slice(end)
  const document = readCommentDocument(source)
  const changes = ChangeSet.of({ from: start, to: end, insert: replacement }, document.text.length)
  return writeCommentDocument(text, document.threads.map(thread => {
    if (thread.detached) return thread
    const range = mapCommentRange(document.text, text, thread, changes)
    return { ...thread, from: range.from, to: range.to, detached: range.detached ? 'removed' : null }
  }))
}
