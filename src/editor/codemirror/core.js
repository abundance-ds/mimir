import { EditorState, Compartment, Prec } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, foldKeymap, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { rust } from '@codemirror/lang-rust'
import { r } from '@codemirror/legacy-modes/mode/r'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { tags as t } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
import { detectActiveFormats } from './formatting.js'

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-ink)',
    backgroundColor: 'var(--color-chrome)',
    fontSize: 'var(--editor-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--editor-line-height)',
    letterSpacing: '0',
    backgroundColor: 'var(--editor-paper)',
  },
  '.cm-content': {
    caretColor: 'var(--color-accent)',
    maxWidth: 'var(--editor-max-width, none)',
    boxSizing: 'border-box',
    minHeight: '100%',
    margin: '0',
    padding: '24px clamp(8px, 3vw, 24px) clamp(72px, 20vh, 100px)',
    color: 'var(--color-ink)',
    textAlign: 'left',
  },
  '.cm-line': {
    padding: '0 2px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent)',
    borderLeftWidth: '2px',
  },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    background: 'var(--panel)',
    color: 'var(--color-ink)',
    borderRadius: '3px',
    boxShadow: 'var(--shadow-low)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete': {
    padding: '2px',
  },
  '.cm-tooltip-autocomplete ul': {
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete ul li': {
    borderRadius: '2px',
    padding: '6px 8px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--color-accent)',
    color: 'var(--color-accent-ink)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-chrome)',
    color: 'var(--color-ink)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--color-rule-light)',
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: '1px solid var(--color-rule-light)',
  },
  '.cm-search label': {
    color: 'var(--color-ink-2)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-ink)',
    border: '1px solid var(--color-rule)',
    borderRadius: '3px',
    outline: 'none',
  },
  '.cm-textfield:focus': {
    borderColor: 'var(--color-accent)',
  },
  '.cm-button': {
    backgroundColor: 'var(--color-chrome-mid)',
    color: 'var(--color-ink-2)',
    border: '1px solid var(--color-rule)',
    borderRadius: '3px',
    backgroundImage: 'none',
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--color-chrome)',
    color: 'var(--color-ink)',
  },
  '.cm-button:active, .cm-button[aria-checked="true"]': {
    backgroundColor: 'var(--color-accent-soft)',
  },
  '.cm-search .cm-button': {
    fontSize: '85%',
  },
}, { dark: false })

export const editorHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '650', fontSize: '1.55em', color: 'var(--ink-strong)' },
  { tag: t.heading2, fontWeight: '650', fontSize: '1.25em', color: 'var(--ink-strong)' },
  { tag: t.heading3, fontWeight: '650', color: 'var(--ink-strong)' },
  { tag: [t.strong], fontWeight: '700', color: 'var(--ink-strong)' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.monospace], fontFamily: 'var(--font-mono)', backgroundColor: 'var(--inline-code-bg)', color: 'var(--code)' },
  { tag: [t.link], color: 'var(--color-accent)', textDecoration: 'underline', textUnderlineOffset: '3px' },
  { tag: [t.quote], color: 'var(--quote)', fontStyle: 'italic' },
  { tag: [t.keyword, t.atom], color: 'var(--syntax-keyword)' },
  { tag: [t.propertyName], color: 'var(--syntax-property)' },
  { tag: [t.string], color: 'var(--syntax-string)' },
  { tag: [t.number], color: 'var(--syntax-number)' },
  { tag: [t.comment], color: 'var(--muted)' },
])

export const wrapCompartment = new Compartment()
export const spellcheckCompartment = new Compartment()
export const languageCompartment = new Compartment()
export const darkModeCompartment = new Compartment()

const editorInputAttributes = {
  autocorrect: 'off',
  autocapitalize: 'off',
  autocomplete: 'off',
  translate: 'no',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
}

export function editorInputAttributesExtension(spellcheck = false) {
  return EditorView.contentAttributes.of({
    ...editorInputAttributes,
    spellcheck: spellcheck ? 'true' : 'false',
  })
}

const markdownExtension = markdown({ base: markdownLanguage, extensions: [Strikethrough] })

export function languageExtensionForPath(path = '') {
  const filename = String(path || '').split('/').pop() || ''
  const lower = filename.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop() : lower

  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return markdownExtension
  if (['js', 'mjs', 'cjs'].includes(ext)) return javascript()
  if (['jsx'].includes(ext)) return javascript({ jsx: true })
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true })
  if (['tsx'].includes(ext)) return javascript({ typescript: true, jsx: true })
  if (['json', 'jsonc', 'map'].includes(ext)) return json()
  if (['css'].includes(ext)) return css()
  if (['html', 'htm'].includes(ext)) return html()
  if (['py', 'pyw'].includes(ext)) return python()
  if (['sql'].includes(ext)) return sql()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  if (['xml', 'svg', 'xhtml'].includes(ext)) return xml()
  if (['rs'].includes(ext)) return rust()
  if (['r', 'rprofile', 'rmd', 'qmd'].includes(ext)) return StreamLanguage.define(r)
  if (['sh', 'bash', 'zsh', 'fish', 'env'].includes(ext) || lower === 'makefile') return StreamLanguage.define(shell)
  if (['toml'].includes(ext)) return StreamLanguage.define(toml)
  if (lower === 'dockerfile' || ext === 'dockerfile') return StreamLanguage.define(dockerFile)
  return []
}

export function createEditor({ parent, doc, path = '', extensions = [], onChange, onCursor, onStats, onSelectionCommand, onActiveFormats, isSelectionRewriteEnabled = () => true, initialSettings }) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      onChange?.(update)
      onStats?.(computeStats(update.state))
    }
    if (update.selectionSet || update.docChanged) {
      const selection = update.state.selection.main
      const line = update.state.doc.lineAt(selection.head)
      onCursor?.({
        line: line.number,
        column: selection.head - line.from + 1,
        offset: selection.head,
        hasSelection: selection.from !== selection.to,
      })
      if (selection.from !== selection.to) {
        onSelectionCommand?.({
          from: selection.from,
          to: selection.to,
          text: update.state.sliceDoc(selection.from, selection.to),
          coords: update.view.coordsAtPos(selection.to),
        })
      }
      onActiveFormats?.(detectActiveFormats(update.state))
    }
  })

  const selectionRewriteKeymap = Prec.highest(keymap.of([
    {
      key: 'Mod-k',
      run(view) {
        if (!isSelectionRewriteEnabled()) return false
        const selection = view.state.selection.main
        onSelectionCommand?.({
          from: selection.from,
          to: selection.to,
          text: selection.from === selection.to ? '' : view.state.sliceDoc(selection.from, selection.to),
          coords: view.coordsAtPos(selection.to),
          force: true,
        })
        return true
      },
    },
  ]))

  const showWordWrap = initialSettings?.wordWrap ?? true
  const showSpellcheck = initialSettings?.spellCheck ?? false
  const isDark = initialSettings?.isDark ?? false

  const state = EditorState.create({
    doc,
    extensions: [
      wrapCompartment.of(showWordWrap ? EditorView.lineWrapping : []),
      spellcheckCompartment.of(editorInputAttributesExtension(showSpellcheck)),
      highlightActiveLine(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      languageCompartment.of(languageExtensionForPath(path)),
      editorTheme,
      darkModeCompartment.of(isDark ? EditorView.darkTheme.of(true) : []),
      syntaxHighlighting(editorHighlightStyle),
      keymap.of([
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      selectionRewriteKeymap,
      updateListener,
      ...extensions,
    ],
  })

  return new EditorView({ state, parent })
}

export function computeStats(state) {
  const text = state.doc.toString()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const characters = text.length
  const readingMinutes = Math.max(1, Math.round(words / 230))
  return { words, characters, readingMinutes }
}
