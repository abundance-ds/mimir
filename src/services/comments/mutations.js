import { buildCommentTag, cleanToRawPos, escapeAttr, parseCommentTags } from './parser.js'
import { snapCommentAnchor } from './anchor.js'

// Text transformations are shared by agent tools and never select a document.
export function mutateComment(content, action, input, author = 'ai') {
  const { comments, cleanText, offsetMap } = parseCommentTags(content)
  if (action === 'add') {
    const anchor = input.anchor_text
    const index = cleanText.indexOf(anchor)
    if (!anchor || index < 0) throw new Error('Could not find anchor_text in the document. Ensure it matches exactly.')
    if (cleanText.indexOf(anchor, index + anchor.length) >= 0) throw new Error('anchor_text matches more than one passage. Provide a longer, unique anchor.')
    const range = snapCommentAnchor(content, cleanToRawPos(offsetMap, index), cleanToRawPos(offsetMap, index + anchor.length))
    if (!range) throw new Error('anchor_text covers only Markdown structure. Anchor to passage text instead.')
    const { from, to } = range
    if (comments.some(comment => from < comment.tagTo && to > comment.tagFrom)) throw new Error('Anchor text overlaps with an existing comment. Choose a non-overlapping passage.')
    const id = crypto.randomUUID()
    const anchorText = content.slice(from, to)
    const tag = buildCommentTag({ id, author, text: input.text, created: new Date().toISOString(), anchorText })
    return { content: content.slice(0, from) + tag + content.slice(to), result: { comment_id: id, status: 'created', anchor: anchorText.slice(0, 80) } }
  }
  const comment = comments.find(item => item.id === input.comment_id)
  if (!comment) throw new Error(`Comment "${input.comment_id}" not found.`)
  const result = { comment_id: comment.id }
  let from, to, insert
  if (action === 'reply') {
    const id = crypto.randomUUID()
    from = to = comment.tagTo - '</comment>'.length
    insert = `<reply id="${escapeAttr(id)}" author="${escapeAttr(author)}" text="${escapeAttr(input.text)}" ts="${new Date().toISOString()}"/>`
    Object.assign(result, { reply_id: id, status: 'replied' })
  } else if (action === 'delete') {
    from = comment.tagFrom; to = comment.tagTo; insert = comment.anchorText
    result.status = 'deleted'
  } else if (action === 'resolve' || action === 'reopen') {
    from = comment.tagFrom; to = comment.contentFrom
    const tag = content.slice(from, to)
    result.status = action === 'resolve' ? 'resolved' : 'active'
    insert = /\sstatus="[^"]*"/.test(tag)
      ? tag.replace(/\sstatus="[^"]*"/, ` status="${result.status}"`)
      : tag.replace(/>$/, ` status="${result.status}">`)
  } else throw new Error(`Unknown comment action: ${action}`)
  return { content: content.slice(0, from) + insert + content.slice(to), result }
}

export function documentComments(content) {
  return parseCommentTags(content).comments.map(comment => {
    const lines = content.slice(0, comment.contentFrom).split(/\r\n?|\n/)
    return {
      id: comment.id, author: comment.author || 'user', text: comment.text,
      status: comment.status, created: comment.created || null, anchorText: comment.anchorText,
      ...(comment.detached ? { attachment: comment.detached, anchorText: comment.quote } : {}),
      line: lines.length, column: lines.at(-1).length + 1,
      replies: comment.replies.map(reply => ({ id: reply.id, author: reply.author || 'agent', text: reply.text, timestamp: reply.ts || null })),
    }
  })
}
