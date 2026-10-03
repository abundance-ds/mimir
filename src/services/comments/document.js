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
export function mapCommentRange(before, after, range, changes = textChanges(before, after), { exact = false } = {}) {
  const from = changes.mapPos(Math.min(range.from, before.length), 1)
  const to = changes.mapPos(Math.min(range.to, before.length), -1)
  let surviving = Math.max(0, range.to - range.from)
  changes.iterChangedRanges((a, b) => { surviving -= Math.max(0, Math.min(b, range.to) - Math.max(a, range.from)) })
  const quote = before.slice(range.from, range.to)
  const mapped = after.slice(from, Math.max(from, to))
  const words = quote.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []
  const keptWords = new Set(mapped.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])
  // A character diff can align a few letters in unrelated text. Do not turn
  // that into an apparently precise comment anchor. Exact edits already
  // identify the occurrence and do not need this inference check.
  const uncertain = !exact && quote !== mapped && (surviving < quote.length / 2 || (words.length > 0 && !words.some(word => keptWords.has(word))))
  return { from, to: Math.max(from, to), surviving: Math.max(0, surviving), detached: to <= from || surviving <= 0 || uncertain,
    reason: surviving > 0 ? 'changed' : 'removed' }
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
    return { ...thread, from: range.from, to: range.to, detached: range.detached ? range.reason : null }
  }))
}

// Agent replacements may start inside a comment and end outside it. Replace
// prose first, then map complete threads; slicing the raw range breaks tags.
export function replaceCommentText(source, from, to, replacement) {
  return replaceCommentRanges(source, [{ from, to, replacement }])
}

// Convert every offset against the same source. Serializing one replacement
// before applying the next can move a tag across the next raw range.
export function replaceCommentRanges(source, replacements) {
  const parsed = parseCommentTags(source)
  const document = readCommentDocument(source)
  const edits = replacements.map(({ from, to, replacement }) => ({
    from: rawToCleanPos(parsed.comments, from), to: rawToCleanPos(parsed.comments, to),
    document: readCommentDocument(replacement || ''),
  })).sort((a, b) => a.from - b.from)
  if (edits.some((edit, i) => i && edit.from < edits[i - 1].to)) throw new Error('The proposed text ranges overlap.')
  const changes = ChangeSet.of(edits.map(edit => ({ from: edit.from, to: edit.to, insert: edit.document.text })), document.text.length)
  let cursor = 0
  let text = ''
  const inserted = []
  for (const edit of edits) {
    text += document.text.slice(cursor, edit.from)
    for (const thread of edit.document.threads) inserted.push({ ...thread, from: text.length + thread.from, to: text.length + thread.to })
    text += edit.document.text
    cursor = edit.to
  }
  text += document.text.slice(cursor)
  const threads = document.threads.filter(thread => !inserted.some(next => next.id === thread.id)).map(thread => {
    if (thread.detached) return thread
    const range = mapCommentRange(document.text, text, thread, changes, { exact: true })
    return { ...thread, from: range.from, to: range.to, detached: range.detached ? 'removed' : null }
  })
  return writeCommentDocument(text, [...threads, ...inserted])
}
