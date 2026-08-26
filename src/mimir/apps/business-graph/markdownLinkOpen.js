// Direct-click navigation for highlighted Markdown links inside the graph note
// editor. File targets stay separate from safe web URLs so each uses the
// correct product-owned opener.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function cleanDestination(raw) {
  let target = String(raw || '').trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  if (!target || target.startsWith('#')) return null
  if (WINDOWS_ABSOLUTE.test(target)) return { kind: 'file', target }
  if (URI_SCHEME.test(target)) {
    let url
    try {
      url = new URL(target)
    } catch {
      return null
    }
    return ['http:', 'https:'].includes(url.protocol)
      ? { kind: 'url', target: url.href }
      : null
  }
  try {
    target = decodeURIComponent(target)
  } catch {
    // Keep the raw target when it is not valid percent-encoding.
  }
  return { kind: 'file', target }
}

function linkDestinationIn(node, state) {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'URL') {
      return cleanDestination(state.sliceDoc(current.from, current.to))
    }
    if (current.name === 'Link' || current.name === 'Image' || current.name === 'Autolink') {
      const url = current.getChild('URL')
      return url ? cleanDestination(state.sliceDoc(url.from, url.to)) : null
    }
  }
  return null
}

export function linkDestinationAt(state, pos) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state)
  // A caret position lands between characters; check both sides so a click at
  // either edge of a link still resolves to it.
  for (const side of [-1, 1]) {
    const destination = linkDestinationIn(tree.resolveInner(pos, side), state)
    if (destination) return destination
  }
  return null
}

// Compatibility helper for the file-link resolver used by existing callers.
export function linkTargetAt(state, pos) {
  const destination = linkDestinationAt(state, pos)
  return destination?.kind === 'file' ? destination.target : null
}

export function linkDestinationForClick(event, view) {
  if (
    event.button !== 0
    || event.shiftKey
    || event.altKey
    || !event.target?.closest?.('.cm-graph-link')
  ) {
    return null
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, true)
  return pos == null ? null : linkDestinationAt(view.state, pos)
}

export function markdownLinkOpen({
  enabled = () => true,
  onOpenFile = () => {},
  onOpenUrl = () => {},
}) {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!enabled()) return false
      const destination = linkDestinationForClick(event, view)
      if (!destination) return false
      event.preventDefault()
      if (destination.kind === 'url') onOpenUrl(destination.target)
      else onOpenFile(destination.target)
      return true
    },
  })
}
