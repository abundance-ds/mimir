import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { history, undo } from '@codemirror/commands'
import { spellingChunks, spellingExtension, spellingWordAt } from './spelling.js'

const views = []
afterEach(() => { for (const view of views.splice(0)) view.destroy() })
const pause = () => new Promise(resolve => setTimeout(resolve, 25))
const marks = view => [...view.dom.querySelectorAll('.cm-misspelled')].map(node => node.textContent)
function make(doc, check, extra = []) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc, extensions: [markdown(), history(), spellingExtension({ check, delay: 1 }), extra],
  }) })
  views.push(view)
  return view
}

describe('spelling ranges', () => {
  it('withholds code, URLs, email, and comment tags without shifting Unicode offsets', () => {
    const doc = '😀 mispelled **wurd** `codde` [label](https://exammple.test) a@exammple.test\n\n```js\nconst codde = 1\n```\n\n<comment id="xx" text="hidden">visibble</comment>'
    const state = EditorState.create({ doc, extensions: [markdown()] })
    const text = spellingChunks(state, [{ from: 0, to: doc.length }]).map(chunk => chunk.text).join('')
    expect(text.length).toBe(doc.length)
    expect(text).toContain('mispelled')
    expect(text).toContain('wurd')
    expect(text).not.toContain('codde')
    expect(text).not.toContain('exammple')
    expect(text).not.toContain('hidden')
    expect(text.indexOf('mispelled')).toBe(3)
  })

  it('does not spellcheck source code and bounds requests for long documents', () => {
    const code = EditorState.create({ doc: 'const wurd = 1', extensions: [javascript()] })
    expect(spellingChunks(code, [{ from: 0, to: code.doc.length }])).toEqual([])
    const state = EditorState.create({ doc: 'mispelled 😀 '.repeat(3000) })
    const chunks = spellingChunks(state, [{ from: 0, to: state.doc.length }])
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.text.length <= 8192)).toBe(true)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(state.doc.toString())
  })

  it('selects accented, combining, and non-Latin words at UTF-16 positions', () => {
    const state = EditorState.create({ doc: '😀 café Straße привет' })
    expect(spellingWordAt(state, 8)).toEqual({ from: 3, to: 8, text: 'café' })
    expect(spellingWordAt(state, 12).text).toBe('Straße')
    expect(spellingWordAt(state, state.doc.length).text).toBe('привет')
  })
})

describe('spelling decorations', () => {
  it('draws underlines with native spellcheck off and does not change text or undo', async () => {
    const check = vi.fn(async () => [{ from: 3, to: 11 }])
    const view = make('😀 mispeled word', check)
    await pause()
    expect(marks(view)).toEqual(['mispeled'])
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false')
    expect(view.contentDOM.getAttribute('writingsuggestions')).toBe('false')
    expect(undo(view)).toBe(false)
    view.dispatch({ changes: { from: 3, to: 11, insert: 'misspelled' }, userEvent: 'input.spelling' })
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('😀 mispeled word')
  })

  it('rejects old results after editing and after changing the document', async () => {
    let resolve
    const check = vi.fn(() => new Promise(done => { resolve = done }))
    const view = make('mispeled', check)
    await pause()
    const first = resolve
    view.dispatch({ changes: { from: 0, to: 8, insert: 'correct' } })
    first([{ from: 0, to: 8 }])
    await pause()
    expect(marks(view)).toEqual([])
    const second = resolve
    view.setState(EditorState.create({ doc: 'another document', extensions: [spellingExtension({ check: async () => [], delay: 1 })] }))
    second([{ from: 0, to: 7 }])
    await pause()
    expect(marks(view)).toEqual([])
  })

  it('keeps marks across cursor moves without asking the native checker again', async () => {
    const check = vi.fn(async () => [{ from: 0, to: 8 }])
    const view = make('mispeled word', check)
    await pause()
    view.dispatch({ selection: { anchor: 8 } })
    await pause()
    expect(marks(view)).toEqual(['mispeled'])
    expect(check).toHaveBeenCalledTimes(1)
    expect(view.dom.querySelector('[role="menu"]')).toBeNull()
  })

  it('removes marks and cancels pending checks when the setting is disabled', async () => {
    const compartment = new Compartment()
    const check = vi.fn(async () => [{ from: 0, to: 8 }])
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'mispeled',
      extensions: [compartment.of(spellingExtension({ check, delay: 1 }))],
    }) })
    views.push(view)
    await pause()
    expect(marks(view)).toEqual(['mispeled'])
    view.dispatch({ effects: compartment.reconfigure([]) })
    expect(marks(view)).toEqual([])
    await pause()
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('waits for composition to end and survives system checker failure', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ from: 0, to: 8 }])
    const view = make('mispeled', check)
    vi.spyOn(view, 'composing', 'get').mockReturnValue(true)
    await pause()
    expect(check).not.toHaveBeenCalled()
    vi.spyOn(view, 'composing', 'get').mockReturnValue(false)
    await pause()
    expect(marks(view)).toEqual([])
    view.dispatch({ changes: { from: 8, insert: ' ' } })
    await pause()
    expect(marks(view)).toEqual(['mispeled'])
  })
})
