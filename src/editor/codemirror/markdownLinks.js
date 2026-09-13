import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { graphLinkId, graphReferencesIn } from './graphLinkSyntax.js'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function markdownLinkDestination(raw) {
  let target = String(raw || '').trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  if (!target || target.startsWith('#')) return null
  const graphId = graphLinkId(target)
  if (graphId) return { kind: 'graph', target: graphId }
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
      const destination = markdownLinkDestination(state.sliceDoc(current.from, current.to))
      return destination?.kind === 'graph' ? null : destination
    }
    if (current.name === 'Link' || current.name === 'Image' || current.name === 'Autolink') {
      const url = current.getChild('URL')
      const destination = url ? markdownLinkDestination(state.sliceDoc(url.from, url.to)) : null
      return destination?.kind === 'graph' ? null : destination
    }
  }
  return null
}

export function linkDestinationAt(state, pos) {
  const graphReference = graphReferencesIn(state).find(reference => reference.from <= pos && reference.to >= pos)
  if (graphReference) return { kind: 'graph', target: graphReference.targetId }
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state)
  // A caret position lands between characters. Check both sides so a click at
  // either edge of a link still resolves to it.
  for (const side of [-1, 1]) {
    const destination = linkDestinationIn(tree.resolveInner(pos, side), state)
    if (destination) return destination
  }
  return null
}

// Compatibility helper for callers that need only local file targets.
export function linkTargetAt(state, pos) {
  const destination = linkDestinationAt(state, pos)
  return destination?.kind === 'file' ? destination.target : null
}

export function linkDestinationForClick(event, view, selector = '.cm-graph-link') {
  if (
    event.button !== 0
    || event.shiftKey
    || event.altKey
    || !event.target?.closest?.(selector)
  ) {
    return null
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, true)
  return pos == null ? null : linkDestinationAt(view.state, pos)
}

export function markdownLinkOpen({
  enabled = () => true,
  selector = '.cm-graph-link',
  preserveRenderedLink = false,
  onOpenFile = () => {},
  onOpenUrl = () => {},
  onOpenGraph = () => {},
}) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!enabled(view, event) || !preserveRenderedLink) return false
      const destination = linkDestinationForClick(event, view, selector)
      if (!destination) return false
      // Live Preview reveals Markdown syntax when the caret enters the line.
      // Keep the rendered link in place until the following click opens it.
      event.preventDefault()
      return true
    },
    click(event, view) {
      if (!enabled(view, event)) return false
      const destination = linkDestinationForClick(event, view, selector)
      if (!destination) return false
      event.preventDefault()
      if (destination.kind === 'url') onOpenUrl(destination.target)
      else if (destination.kind === 'graph') onOpenGraph(destination.target)
      else onOpenFile(destination.target)
      return true
    },
  })
}

export function resolveMarkdownFileTarget(target, {
  sourcePath = '',
  fallbackDirectory = '',
  homeDirectory = '',
} = {}) {
  let value = String(target || '').trim()
  if (!value) return ''

  const fragment = value.indexOf('#')
  if (fragment >= 0) value = value.slice(0, fragment)
  if (!value) return ''

  if (value === '~' || value.startsWith('~/')) {
    if (!homeDirectory) return ''
    value = `${String(homeDirectory).replace(/[\\/]$/, '')}${value.slice(1)}`
  }

  if (value.startsWith('/') || WINDOWS_ABSOLUTE.test(value)) {
    return normalizeFilePath(value)
  }

  const sourceDirectory = directoryName(sourcePath)
  const base = sourceDirectory || String(fallbackDirectory || '').trim()
  if (!base) return ''
  return normalizeFilePath(`${base.replace(/[\\/]$/, '')}/${value}`)
}

function directoryName(path) {
  const value = String(path || '')
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (slash < 0) return ''
  if (slash === 0) return value[0]
  if (slash === 2 && WINDOWS_ABSOLUTE.test(value)) return value.slice(0, 3)
  return value.slice(0, slash)
}

function normalizeFilePath(path) {
  const value = String(path || '').replace(/\\/g, '/')
  const drive = value.match(/^[a-zA-Z]:/)?.[0] || ''
  const absolute = Boolean(drive) || value.startsWith('/')
  const rest = drive ? value.slice(drive.length) : value
  const parts = []

  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }

  if (drive) return `${drive}/${parts.join('/')}`
  return `${absolute ? '/' : ''}${parts.join('/')}`
}
