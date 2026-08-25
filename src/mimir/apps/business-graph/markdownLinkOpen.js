// Cmd/Ctrl+click navigation for Markdown file links inside the graph note
// editor. Only file targets resolve; external URLs and in-document anchors
// keep the default editing behavior.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function cleanTarget(raw) {
  let target = String(raw || '').trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  if (!target || target.startsWith('#')) return null
  if (WINDOWS_ABSOLUTE.test(target)) return target
  if (URI_SCHEME.test(target)) return null
  try {
    target = decodeURIComponent(target)
  } catch {
    // Keep the raw target when it is not valid percent-encoding.
  }
  return target
}

function linkTargetIn(node, state) {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'URL') return cleanTarget(state.sliceDoc(current.from, current.to))
    if (current.name === 'Link' || current.name === 'Image' || current.name === 'Autolink') {
      const url = current.getChild('URL')
      return url ? cleanTarget(state.sliceDoc(url.from, url.to)) : null
    }
  }
  return null
}

export function linkTargetAt(state, pos) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state)
  // A caret position lands between characters; check both sides so a click at
  // either edge of a link still resolves to it.
  for (const side of [-1, 1]) {
    const target = linkTargetIn(tree.resolveInner(pos, side), state)
    if (target) return target
  }
  return null
}

export function markdownLinkOpen({ onOpen }) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const target = linkTargetAt(view.state, pos)
      if (!target) return false
      event.preventDefault()
      onOpen(target)
      return true
    },
  })
}
