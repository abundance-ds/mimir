import { afterEach, describe, expect, it } from 'vitest'
import { EditorSelection } from '@codemirror/state'
import { undo } from '@codemirror/commands'
import { createEditor } from './core.js'

const views = []

afterEach(() => {
  while (views.length) views.pop().destroy()
})

function editorAt(doc, { path = 'note.md', cursor = doc.length } = {}) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = createEditor({ parent, doc, path })
  views.push(view)
  view.dispatch({ selection: EditorSelection.cursor(cursor) })
  return view
}

function pressEnter(view) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
  )
  return view.state.doc.toString()
}

function caretLine(view) {
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

describe('markdown list continuation', () => {
  it('continues a list without inserting a blank line', () => {
    expect(pressEnter(editorAt('- bullet item'))).toBe('- bullet item\n- ')
    expect(pressEnter(editorAt('- one\n- two'))).toBe('- one\n- two\n- ')
    expect(pressEnter(editorAt('1. one\n2. two'))).toBe('1. one\n2. two\n3. ')
    expect(pressEnter(editorAt('- [ ] one\n- [x] two'))).toBe('- [ ] one\n- [x] two\n- [ ] ')
  })

  it('leaves the list on an empty item instead of loosening it', () => {
    // CodeMirror's default turns a tight two-item list loose here, which is
    // what produced "blank line, then a new bullet" while typing.
    expect(pressEnter(editorAt('- one\n- '))).toBe('- one\n')
    expect(pressEnter(editorAt('- one\n- two\n- '))).toBe('- one\n- two\n')
    expect(pressEnter(editorAt('1. one\n2. '))).toBe('1. one\n')
  })

  it('steps out one nesting level at a time on an empty item', () => {
    expect(pressEnter(editorAt('- one\n  - '))).toBe('- one\n- ')
  })

  it('keeps continuations tight in lists that are already loose', () => {
    expect(pressEnter(editorAt('- one\n\n- two'))).toBe('- one\n\n- two\n- ')
    expect(pressEnter(editorAt('1. one\n\n2. two'))).toBe('1. one\n\n2. two\n3. ')
    expect(pressEnter(editorAt('- [ ] one\n\n- [ ] two'))).toBe('- [ ] one\n\n- [ ] two\n- [ ] ')
  })

  it('places the caret after the marker it just inserted', () => {
    const tight = editorAt('- one\n- two')
    pressEnter(tight)
    expect(caretLine(tight)).toBe(3)
    expect(tight.state.selection.main.head).toBe(tight.state.doc.length)

    const loose = editorAt('- one\n\n- two')
    pressEnter(loose)
    expect(caretLine(loose)).toBe(4)
    expect(loose.state.selection.main.head).toBe(loose.state.doc.length)
  })

  it('still continues blockquotes and leaves other markup alone', () => {
    expect(pressEnter(editorAt('> quoted'))).toBe('> quoted\n> ')
    expect(pressEnter(editorAt('plain paragraph'))).toBe('plain paragraph\n')
  })

  it('does not touch Enter outside markdown documents', () => {
    expect(pressEnter(editorAt('const list = [', { path: 'main.js' }))).toBe('const list = [\n  ')
  })

  it('undoes a tightened continuation in a single step', () => {
    const view = editorAt('- one\n\n- two')
    pressEnter(view)
    undo(view)
    expect(view.state.doc.toString()).toBe('- one\n\n- two')
  })
})
