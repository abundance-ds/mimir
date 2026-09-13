import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'

// Match the native graph ID grammar exactly. Custom URLs never fall back to files.
export function graphLinkId(target) {
  return /^mimir:\/\/graph\/([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)$/.exec(String(target))?.[1] || null
}

function decodeText(text) {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    .replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g, entity => {
      const element = document.createElement('textarea')
      element.innerHTML = entity
      return element.value
    })
}

function referenceKey(value) {
  return decodeText(value).trim().replace(/\s+/g, ' ').toUpperCase()
}

function labelText(state, node, from, to) {
  const replacements = []
  node.cursor().iterate(current => {
    if (current.from < from || current.to > to) return
    let text
    if (['EmphasisMark', 'StrikethroughMark', 'HTMLTag', 'Image'].includes(current.name)) text = ''
    else if (current.name === 'Escape') text = state.sliceDoc(current.from + 1, current.to)
    else if (current.name === 'Entity') text = decodeText(state.sliceDoc(current.from, current.to))
    else if (current.name === 'HardBreak') text = ' '
    else if (current.name === 'InlineCode') {
      const marks = current.node.getChildren('CodeMark')
      text = state.sliceDoc(marks[0].to, marks[1].from).replace(/\r?\n/g, ' ')
      if (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) text = text.slice(1, -1)
    }
    if (text !== undefined) {
      replacements.push({ from: current.from, to: current.to, text })
      return false
    }
  })
  let result = '', cursor = from
  for (const replacement of replacements) {
    result += state.sliceDoc(cursor, replacement.from) + replacement.text
    cursor = replacement.to
  }
  return (result + state.sliceDoc(cursor, to)).replace(/\r?\n/g, ' ')
}

export function graphReferencesIn(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state)
  const definitions = new Map()
  tree.iterate({ enter(node) {
    if (node.name !== 'LinkReference') return
    const label = node.node.getChild('LinkLabel')
    const url = node.node.getChild('URL')
    if (label && url) {
      const key = referenceKey(state.sliceDoc(label.from + 1, label.to - 1))
      if (!definitions.has(key)) definitions.set(key, state.sliceDoc(url.from, url.to))
    }
    return false
  } })
  const references = []
  tree.iterate({ enter(node) {
    if (['Image', 'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment'].includes(node.name)) return false
    if (node.name !== 'Link' && node.name !== 'Autolink') return
    const url = node.node.getChild('URL')
    const marks = node.node.getChildren('LinkMark')
    const labelFrom = node.from + 1
    const labelTo = marks[1]?.from ?? node.to - 1
    const refLabel = node.node.getChild('LinkLabel')
    let destination = url ? state.sliceDoc(url.from, url.to) : definitions.get(referenceKey(
      refLabel && refLabel.to > refLabel.from + 2
        ? state.sliceDoc(refLabel.from + 1, refLabel.to - 1)
        : state.sliceDoc(labelFrom, labelTo),
    ))
    destination = decodeText(destination || '')
    if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1)
    const targetId = graphLinkId(destination)
    if (targetId) references.push({
      targetId,
      label: node.name === 'Autolink' ? destination : labelText(state, node.node, labelFrom, labelTo),
      from: node.from,
      to: node.to,
    })
    return false
  } })
  return references
}

export function graphMentionAt(state, pos) {
  const line = state.doc.lineAt(pos)
  const before = state.sliceDoc(line.from, pos)
  const match = /(?:^|[\s([{>"'])@([\p{L}\p{N}\p{M} ._'-]{0,120})$/u.exec(before)
  if (!match) return null
  const from = pos - match[1].length - 1
  const tree = ensureSyntaxTree(state, pos, 50) || syntaxTree(state)
  for (let node = tree.resolveInner(from + 1, -1); node; node = node.parent) {
    if (['Link', 'Image', 'Autolink', 'LinkReference', 'InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'Comment'].includes(node.name)) return null
  }
  return { from, to: pos, query: match[1] }
}

export function graphLinkMarkdown(node) {
  const title = String(node.title || '').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/[\\`*_[\]<>~]/g, '\\$&')
  return `[${title}](mimir://graph/${node.id})`
}

// A stale backlink selects a current occurrence to the same target, never arbitrary text.
export function referenceSelection(state, request, sourceRevision, { bodyFrom = 0, sourceBody = null } = {}) {
  const matches = graphReferencesIn(state).filter(reference => reference.from >= bodyFrom && reference.targetId === request.targetId)
  if (request.sourceRevision === sourceRevision) {
    const position = offset => bodyFrom + (sourceBody == null ? offset : sourceBody.slice(0, offset).replace(/\r\n/g, '\n').length)
    const exact = matches.find(reference => reference.from === position(request.from) && reference.to === position(request.to))
    if (exact) return { anchor: exact.from, head: exact.to }
  }
  const current = matches[0]
  return current ? { anchor: current.from, head: current.to } : { anchor: bodyFrom }
}
