import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const graphHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: 'var(--color-ink)',
    fontWeight: '650',
  },
  { tag: tags.strong, color: 'var(--color-ink)', fontWeight: '680' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], class: 'cm-graph-link' },
  {
    tag: tags.monospace,
    color: 'var(--code, var(--color-ink-2))',
    fontFamily: 'var(--font-mono)',
  },
  { tag: tags.quote, color: 'var(--color-ink-3)', fontStyle: 'italic' },
  { tag: tags.contentSeparator, color: 'var(--color-ink-4)' },
])

const createGraphEditorTheme = (framed, openLinks) => EditorView.theme({
  '&': {
    minHeight: 'var(--graph-editor-min-height)',
    width: '100%',
    borderRadius: framed ? '3px' : '0',
    color: 'var(--color-ink)',
    backgroundColor: framed ? 'var(--color-chrome-high)' : 'transparent',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: framed
      ? '2px solid color-mix(in srgb, var(--color-accent) 22%, transparent)'
      : 'none',
    outlineOffset: '1px',
  },
  '.cm-scroller': {
    minHeight: 'var(--graph-editor-min-height)',
    overflowX: 'auto',
    overflowY: 'visible',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: 'var(--graph-editor-min-height)',
    padding: framed ? '12px 14px 44px' : '4px 0 28px',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': {
    color: 'var(--color-ink-4)',
    fontFamily: 'var(--font-sans)',
    fontStyle: 'normal',
  },
  '.cm-graph-link': {
    color: 'var(--color-accent)',
    cursor: openLinks ? 'pointer' : 'text',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
})

// CodeMirror retains mounted style modules in the document. Allocate each
// fixed variant once, so opening entries does not accumulate CSS rules.
const highlighting = syntaxHighlighting(graphHighlightStyle)
const variants = [false, true].map(framed =>
  [false, true].map(openLinks => [highlighting, createGraphEditorTheme(framed, openLinks)]),
)

export function graphMarkdownStyles(framed, openLinks) {
  return variants[framed ? 1 : 0][openLinks ? 1 : 0]
}
