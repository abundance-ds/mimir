import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { StreamLanguage, syntaxHighlighting, ensureSyntaxTree, forceParsing, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { tags as t, styleTags } from '@lezer/highlight'
import {
  computeStats,
  createEditor,
  editorHighlightStyle,
  editorInputAttributesExtension,
  languageExtensionForPath,
  lineIndicatorExtensions,
  codeLanguageForInfo,
  wrapCompartment,
  lineIndicatorCompartment,
} from './core.js'

const views = []

afterEach(() => {
  while (views.length) views.pop().destroy()
})

function makeEditor(options = {}) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = createEditor({ parent, doc: '', ...options })
  views.push(view)
  return view
}

function makeView(extensions, doc = 'one\ntwo') {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  })
  views.push(view)
  return view
}

describe('computeStats', () => {
  it('counts words and characters and floors reading time at one minute', () => {
    const state = EditorState.create({ doc: 'one two  three\n' })
    expect(computeStats(state)).toEqual({ words: 3, characters: 15, readingMinutes: 1 })
  })

  it('treats an empty or whitespace-only doc as zero words', () => {
    expect(computeStats(EditorState.create({ doc: '' })))
      .toEqual({ words: 0, characters: 0, readingMinutes: 1 })
    expect(computeStats(EditorState.create({ doc: '   \n\t ' })))
      .toEqual({ words: 0, characters: 6, readingMinutes: 1 })
  })

  it('rounds reading minutes against the 230 wpm rate', () => {
    const state = EditorState.create({ doc: 'word '.repeat(500).trim() })
    expect(computeStats(state).readingMinutes).toBe(2)
  })
})

describe('languageExtensionForPath', () => {
  it('shares one markdown extension across markdown suffixes, case-insensitively', () => {
    const md = languageExtensionForPath('/notes/a.md')
    expect(md).not.toEqual([])
    for (const path of ['b.markdown', 'c.mdown', 'd.mkd', 'SHOUTY.MD', '/deep/dir/e.md']) {
      expect(languageExtensionForPath(path)).toBe(md)
    }
  })

  it('maps common extensions to their language support', () => {
    expect(languageExtensionForPath('app.js').language.name).toBe('javascript')
    expect(languageExtensionForPath('app.jsx').language.name).toBe('javascript')
    expect(languageExtensionForPath('app.ts').language.name).toBe('typescript')
    expect(languageExtensionForPath('app.tsx').language.name).toBe('typescript')
    expect(languageExtensionForPath('data.json').language.name).toBe('json')
    expect(languageExtensionForPath('style.css').language.name).toBe('css')
    expect(languageExtensionForPath('page.html').language.name).toBe('html')
    expect(languageExtensionForPath('script.py').language.name).toBe('python')
    expect(languageExtensionForPath('query.sql').language.name).toBe('sql')
    expect(languageExtensionForPath('config.yaml').language.name).toBe('yaml')
    expect(languageExtensionForPath('doc.xml').language.name).toBe('xml')
    expect(languageExtensionForPath('main.rs').language.name).toBe('rust')
  })

  it('uses legacy stream modes for R, shell, toml, and container files', () => {
    for (const path of ['stats.R', 'analysis.Rmd', 'deploy.sh', 'Cargo.toml', 'Dockerfile', 'Makefile', '.env']) {
      expect(languageExtensionForPath(path), path).toBeInstanceOf(StreamLanguage)
    }
  })

  it('returns no extension for unknown or missing extensions', () => {
    expect(languageExtensionForPath('image.png')).toEqual([])
    expect(languageExtensionForPath('LICENSE')).toEqual([])
    expect(languageExtensionForPath('')).toEqual([])
    expect(languageExtensionForPath()).toEqual([])
  })
})

describe('lineIndicatorExtensions', () => {
  it('renders line numbers with gutter and row highlights when enabled', () => {
    const view = makeView(lineIndicatorExtensions(true))
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeTruthy()
    expect(view.dom.querySelector('.cm-activeLineGutter')).toBeTruthy()
    expect(view.dom.querySelector('.cm-activeLine')).toBeTruthy()
  })

  it('falls back to the active-line row highlight when disabled', () => {
    const view = makeView(lineIndicatorExtensions(false))
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeFalsy()
    expect(view.dom.querySelector('.cm-activeLine')).toBeTruthy()
  })
})

describe('editorInputAttributesExtension', () => {
  it('disables writing suggestions and grammar tooling while toggling spellcheck', () => {
    const on = makeView(editorInputAttributesExtension(true))
    expect(on.contentDOM.getAttribute('spellcheck')).toBe('true')
    expect(on.contentDOM.getAttribute('autocorrect')).toBe('off')
    expect(on.contentDOM.getAttribute('autocomplete')).toBe('off')
    expect(on.contentDOM.getAttribute('writingsuggestions')).toBe('false')
    expect(on.contentDOM.getAttribute('data-gramm')).toBe('false')

    const off = makeView(editorInputAttributesExtension(false))
    expect(off.contentDOM.getAttribute('spellcheck')).toBe('false')
  })
})

describe('createEditor', () => {
  it('uses a compact tonal and weight hierarchy for Markdown headings', () => {
    expect(editorHighlightStyle.specs.slice(0, 3).map(({ fontWeight, fontSize, color }) => ({
      fontWeight,
      fontSize,
      color,
    }))).toEqual([
      { fontWeight: '700', fontSize: '1.3em', color: 'var(--editor-heading-1)' },
      { fontWeight: '650', fontSize: '1.15em', color: 'var(--color-ink)' },
      { fontWeight: '560', fontSize: '1.05em', color: 'var(--color-ink-3)' },
    ])
  })

  it('creates a view holding the doc with wrap on and chrome hidden by default', () => {
    const view = makeEditor({ doc: '# Title\n\nBody', path: '/notes/readme.md' })
    expect(view.state.doc.toString()).toBe('# Title\n\nBody')
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false')
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeFalsy()
    expect(view.state.facet(EditorView.darkTheme)).toBe(false)
  })

  it('honors initialSettings for wrap, spellcheck, line numbers, and dark mode', () => {
    const view = makeEditor({
      doc: 'text',
      initialSettings: { wordWrap: false, spellCheck: true, lineNumbers: true, isDark: true },
    })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('true')
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeTruthy()
    expect(view.state.facet(EditorView.darkTheme)).toBe(true)
  })

  it('accepts extra extensions into the composed state', () => {
    const view = makeEditor({
      doc: 'x',
      extensions: [EditorView.contentAttributes.of({ 'data-feature': 'live' })],
    })
    expect(view.contentDOM.getAttribute('data-feature')).toBe('live')
  })

  it('supports reconfiguration through the exported compartments', () => {
    const view = makeEditor({ doc: 'one\ntwo' })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
    view.dispatch({ effects: wrapCompartment.reconfigure([]) })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)

    expect(view.dom.querySelector('.cm-lineNumbers')).toBeFalsy()
    view.dispatch({ effects: lineIndicatorCompartment.reconfigure(lineIndicatorExtensions(true)) })
    expect(view.dom.querySelector('.cm-lineNumbers')).toBeTruthy()
  })

  it('reports document changes through onChange and onStats', () => {
    const onChange = vi.fn()
    const onStats = vi.fn()
    const view = makeEditor({ doc: 'one', onChange, onStats })

    view.dispatch({ changes: { from: 3, insert: ' two' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onStats).toHaveBeenCalledWith({ words: 2, characters: 7, readingMinutes: 1 })
  })

  it('reports cursor position and selection state through onCursor', () => {
    const onCursor = vi.fn()
    const view = makeEditor({ doc: 'alpha\nbeta', onCursor })

    view.dispatch({ selection: { anchor: 8 } })
    expect(onCursor).toHaveBeenLastCalledWith({
      line: 2, column: 3, offset: 8, hasSelection: false,
    })

    view.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(onCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasSelection: true }),
    )
  })

  it('publishes ranged selections through onSelectionCommand', () => {
    const onSelectionCommand = vi.fn()
    const view = makeEditor({ doc: 'alpha beta', onSelectionCommand })

    view.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(onSelectionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: 5, text: 'alpha' }),
    )

    onSelectionCommand.mockClear()
    view.dispatch({ selection: { anchor: 3 } })
    expect(onSelectionCommand).not.toHaveBeenCalled()
  })

  it('forces a selection command on Mod-k only while rewrite is enabled', () => {
    // CodeMirror normalizes "Mod" with its own platform sniff, so mirror it.
    const mac = /Mac/.test(navigator.platform)
    const modK = () => new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    })

    const onSelectionCommand = vi.fn()
    let enabled = true
    const view = makeEditor({
      doc: 'alpha',
      onSelectionCommand,
      isSelectionRewriteEnabled: () => enabled,
    })

    view.contentDOM.dispatchEvent(modK())
    expect(onSelectionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: 0, text: '', force: true }),
    )

    onSelectionCommand.mockClear()
    enabled = false
    view.contentDOM.dispatchEvent(modK())
    expect(onSelectionCommand).not.toHaveBeenCalled()
  })
})

describe('styleTags remap', () => {
  // Verify that the markdown extension remaps HeaderMark and CodeText.
  function mountMd(doc) {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = createEditor({ parent, doc, path: '/test.md' })
    ensureSyntaxTree(view.state, view.state.doc.length, 1000)
    view.dispatch({ changes: [] })
    views.push(view)
    return view
  }

  it('gives HeaderMark the class for t.special(t.heading), not t.processingInstruction', () => {
    const view = mountMd('# Hello')
    const specialHeadingClass = editorHighlightStyle.style([t.special(t.heading)])
    const processingClass = editorHighlightStyle.style([t.processingInstruction])
    expect(specialHeadingClass).toBeTruthy()
    expect(processingClass).toBeTruthy()
    // The # span should carry the special heading class
    const spans = [...view.contentDOM.querySelectorAll('span')]
    const hashSpan = spans.find(s => s.textContent.trim() === '#')
    expect(hashSpan).toBeTruthy()
    expect(hashSpan.className).toContain(specialHeadingClass)
    expect(hashSpan.className).not.toContain(processingClass)
  })

  it('gives fenced CodeText the class for t.special(t.monospace), not plain t.monospace', () => {
    const view = mountMd('```\nhello\n```')
    const specialMonoClass = editorHighlightStyle.style([t.special(t.monospace)])
    const plainMonoClass = editorHighlightStyle.style([t.monospace])
    expect(specialMonoClass).toBeTruthy()
    expect(plainMonoClass).toBeTruthy()
    expect(specialMonoClass).not.toBe(plainMonoClass)
    // The "hello" text should have the special mono class
    const spans = [...view.contentDOM.querySelectorAll('span')]
    const codeSpan = spans.find(s => s.textContent === 'hello')
    expect(codeSpan).toBeTruthy()
    expect(codeSpan.className).toContain(specialMonoClass)
    expect(codeSpan.className).not.toContain(plainMonoClass)
  })

  it('gives a bare URL the link class', () => {
    const view = mountMd('See https://example.com/docs now')
    const linkClass = editorHighlightStyle.style([t.link])
    expect(linkClass).toBeTruthy()
    const spans = [...view.contentDOM.querySelectorAll('span')]
    const urlSpan = spans.find(s => s.textContent === 'https://example.com/docs')
    expect(urlSpan).toBeTruthy()
    expect(urlSpan.className).toContain(linkClass)
  })
})

describe('codeLanguageForInfo', () => {
  it('resolves common JS aliases to a javascript Language', () => {
    for (const info of ['js', 'javascript', 'mjs', 'cjs']) {
      const lang = codeLanguageForInfo(info)
      expect(lang, info).toBeTruthy()
      expect(lang.name).toBe('javascript')
    }
  })

  it('resolves typescript aliases', () => {
    expect(codeLanguageForInfo('ts').name).toBe('typescript')
    expect(codeLanguageForInfo('typescript').name).toBe('typescript')
  })

  it('resolves tsx with jsx', () => {
    const lang = codeLanguageForInfo('tsx')
    expect(lang).toBeTruthy()
    expect(lang.name).toBe('typescript')
  })

  it('resolves other known languages', () => {
    expect(codeLanguageForInfo('json').name).toBe('json')
    expect(codeLanguageForInfo('css').name).toBe('css')
    expect(codeLanguageForInfo('html').name).toBe('html')
    expect(codeLanguageForInfo('python').name).toBe('python')
    expect(codeLanguageForInfo('py').name).toBe('python')
    expect(codeLanguageForInfo('sql').name).toBe('sql')
    expect(codeLanguageForInfo('yaml').name).toBe('yaml')
    expect(codeLanguageForInfo('yml').name).toBe('yaml')
    expect(codeLanguageForInfo('xml').name).toBe('xml')
    expect(codeLanguageForInfo('rust').name).toBe('rust')
    expect(codeLanguageForInfo('rs').name).toBe('rust')
  })

  it('resolves legacy stream modes (shell, r, toml, dockerfile)', () => {
    for (const info of ['sh', 'bash', 'zsh', 'shell']) {
      expect(codeLanguageForInfo(info), info).toBeInstanceOf(StreamLanguage)
    }
    expect(codeLanguageForInfo('r')).toBeInstanceOf(StreamLanguage)
    expect(codeLanguageForInfo('toml')).toBeInstanceOf(StreamLanguage)
    expect(codeLanguageForInfo('dockerfile')).toBeInstanceOf(StreamLanguage)
  })

  it('returns null for unknown or empty info strings', () => {
    expect(codeLanguageForInfo('foo')).toBeNull()
    expect(codeLanguageForInfo('')).toBeNull()
    expect(codeLanguageForInfo(null)).toBeNull()
  })

  it('uses only the first word of the info string', () => {
    expect(codeLanguageForInfo('js some-meta').name).toBe('javascript')
  })

  it('produces nested language nodes in a fenced block', () => {
    const doc = '```js\nconst a = 1\n```'
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = createEditor({ parent, doc, path: '/test.md' })
    forceParsing(view, view.state.doc.length, 5000)
    views.push(view)

    // Nested languages are overlays; use resolveInner to find them.
    const tree = syntaxTree(view.state)
    const inner = tree.resolveInner(doc.indexOf('const') + 1, 1)
    // Walk up to find a VariableDeclaration
    let found = false
    let node = inner
    while (node) {
      if (node.name === 'VariableDeclaration') { found = true; break }
      node = node.parent
    }
    expect(found).toBe(true)
  })

  it('parses an unknown fence info without error and has no nested language node', () => {
    const doc = '```foo\nconst a = 1\n```'
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = createEditor({ parent, doc, path: '/test.md' })
    forceParsing(view, view.state.doc.length, 5000)
    views.push(view)

    const tree = syntaxTree(view.state)
    const inner = tree.resolveInner(doc.indexOf('const') + 1, 1)
    let found = false
    let node = inner
    while (node) {
      if (node.name === 'VariableDeclaration') { found = true; break }
      node = node.parent
    }
    expect(found).toBe(false)
  })

  it('handles an empty info string fence without error', () => {
    const doc = '```\nconst a = 1\n```'
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = createEditor({ parent, doc, path: '/test.md' })
    forceParsing(view, view.state.doc.length, 5000)
    views.push(view)

    const tree = syntaxTree(view.state)
    const inner = tree.resolveInner(doc.indexOf('const') + 1, 1)
    let found = false
    let node = inner
    while (node) {
      if (node.name === 'VariableDeclaration') { found = true; break }
      node = node.parent
    }
    expect(found).toBe(false)
  })
})
