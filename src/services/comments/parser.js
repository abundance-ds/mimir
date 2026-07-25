export function escapeAttr(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function unescapeAttr(str) {
  if (!str) return ''
  return str.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function parseAttrs(tagStr) {
  const attrs = {}
  const re = /(\w+)="([^"]*)"/g
  let m
  while ((m = re.exec(tagStr)) !== null) {
    attrs[m[1]] = unescapeAttr(m[2])
  }
  return attrs
}

function parseReplies(inner) {
  const replies = []
  const re = /<reply\s+([^/]*?)\/>/g
  let m
  while ((m = re.exec(inner)) !== null) {
    const attrs = parseAttrs(m[1])
    replies.push({ id: attrs.id, author: attrs.author, text: attrs.text || '', ts: attrs.ts })
  }
  return replies
}

const COMMENT_RE = /<comment\s+([^>]*)>([\s\S]*?)<\/comment>/g

export function parseCommentTags(text) {
  const comments = []
  const offsetMap = []
  let cleanParts = []
  let cleanLen = 0
  let lastEnd = 0

  let m
  const re = new RegExp(COMMENT_RE.source, COMMENT_RE.flags)
  while ((m = re.exec(text)) !== null) {
    const tagFrom = m.index
    const tagTo = m.index + m[0].length
    const attrStr = m[1]
    const inner = m[2]
    const attrs = parseAttrs(attrStr)
    const openTagEnd = m.index + '<comment '.length + attrStr.length + '>'.length

    const replies = parseReplies(inner)

    let contentEnd = inner.length
    const firstReply = inner.indexOf('<reply ')
    if (firstReply !== -1) contentEnd = firstReply
    const anchorText = inner.slice(0, contentEnd)

    const contentFrom = openTagEnd
    const contentTo = openTagEnd + contentEnd

    if (tagFrom > lastEnd) {
      cleanParts.push(text.slice(lastEnd, tagFrom))
      cleanLen += tagFrom - lastEnd
    }

    offsetMap.push({ cleanPos: cleanLen, rawPos: contentFrom })
    cleanParts.push(anchorText)
    cleanLen += anchorText.length
    offsetMap.push({ cleanPos: cleanLen, rawPos: tagTo })

    comments.push({
      id: attrs.id,
      author: attrs.author,
      text: attrs.text || '',
      status: attrs.status || 'active',
      created: attrs.created,
      replies,
      tagFrom,
      tagTo,
      contentFrom,
      contentTo,
      anchorText,
    })

    lastEnd = tagTo
  }

  if (lastEnd < text.length) {
    cleanParts.push(text.slice(lastEnd))
  }

  return {
    comments,
    cleanText: cleanParts.join(''),
    offsetMap,
  }
}

export function stripCommentTags(text) {
  return text.replace(/<comment\s+[^>]*>([\s\S]*?)<\/comment>/g, (_, inner) => {
    const firstReply = inner.indexOf('<reply ')
    return firstReply !== -1 ? inner.slice(0, firstReply) : inner
  })
}

export function buildCommentTag(comment) {
  const { id, author, text, status, created, anchorText, replies } = comment
  let tag = `<comment id="${escapeAttr(id)}" author="${escapeAttr(author)}" text="${escapeAttr(text)}"`
  if (status) tag += ` status="${escapeAttr(status)}"`
  if (created) tag += ` created="${escapeAttr(created)}"`
  tag += `>${anchorText || ''}`
  if (replies?.length) {
    for (const r of replies) {
      tag += `<reply id="${escapeAttr(r.id)}" author="${escapeAttr(r.author)}" text="${escapeAttr(r.text)}"`
      if (r.ts) tag += ` ts="${escapeAttr(r.ts)}"`
      tag += '/>'
    }
  }
  tag += '</comment>'
  return tag
}

export function cleanToRawPos(offsetMap, cleanPos) {
  if (offsetMap.length === 0) return cleanPos
  let lastRaw = 0
  let lastClean = 0
  for (const { cleanPos: cp, rawPos: rp } of offsetMap) {
    if (cleanPos < cp) return lastRaw + (cleanPos - lastClean)
    lastClean = cp
    lastRaw = rp
  }
  return lastRaw + (cleanPos - lastClean)
}
