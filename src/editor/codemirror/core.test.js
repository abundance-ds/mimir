import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'
import {
  computeStats,
  createEditor,
  editorInputAttributesExtension,
  languageExtensionForPath,
  lineIndicatorExtensions,
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
  it('disables grammar tooling and toggles spellcheck on the content DOM', () => {
    const on = makeView(editorInputAttributesExtension(true))
    expect(on.contentDOM.getAttribute('spellcheck')).toBe('true')
    expect(on.contentDOM.getAttribute('autocorrect')).toBe('off')
    expect(on.contentDOM.getAttribute('data-gramm')).toBe('false')

    const off = makeView(editorInputAttributesExtension(false))
    expect(off.contentDOM.getAttribute('spellcheck')).toBe('false')
  })
})

describe('createEditor', () => {
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
