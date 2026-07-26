import { afterEach, describe, expect, it } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import {
  detectActiveFormats,
  insertHorizontalRule,
  insertImage,
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleBulletList,
  toggleCheckbox,
  toggleHeading,
  toggleItalic,
  toggleNumberedList,
  toggleStrikethrough,
} from './formatting.js'

const views = []

afterEach(() => {
  while (views.length) views.pop().destroy()
})

function view(doc, anchor = 0, head = anchor) {
  const editor = new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      ],
    }),
  })
  views.push(editor)
  return editor
}

describe('Markdown formatting commands', () => {
  it('wraps and unwraps inline selections without losing the selection', () => {
    const editor = view('hello world', 0, 5)

    toggleBold(editor)
    expect(editor.state.doc.toString()).toBe('**hello** world')
    expect(editor.state.sliceDoc(
      editor.state.selection.main.from,
      editor.state.selection.main.to,
    )).toBe('hello')

    toggleBold(editor)
    expect(editor.state.doc.toString()).toBe('hello world')
    expect(editor.state.selection.main).toMatchObject({ from: 0, to: 5 })
  })

  it('inserts paired markers at a cursor and recognizes active inline formats', () => {
    const editor = view('text', 2)
    toggleItalic(editor)
    expect(editor.state.doc.toString()).toBe('te**xt')
    expect(editor.state.selection.main.head).toBe(3)

    const formatted = view('**bold** and ~~gone~~', 3)
    expect(detectActiveFormats(formatted.state)).toContain('bold')
    formatted.dispatch({ selection: { anchor: 16 } })
    expect(detectActiveFormats(formatted.state)).toContain('strikethrough')
    toggleStrikethrough(formatted)
    expect(formatted.state.doc.toString()).toBe('**bold** and gone')
  })

  it('toggles and replaces line prefixes across a selection', () => {
    const editor = view('one\ntwo', 0, 7)
    toggleBulletList(editor)
    expect(editor.state.doc.toString()).toBe('- one\n- two')
    toggleNumberedList(editor)
    expect(editor.state.doc.toString()).toBe('1. - one\n1. - two')

    const heading = view('## Title', 3)
    toggleHeading(heading, 1)
    expect(heading.state.doc.toString()).toBe('# Title')
    expect(detectActiveFormats(heading.state)).toContain('heading-1')

    const quote = view('note', 0, 4)
    toggleBlockquote(quote)
    expect(quote.state.doc.toString()).toBe('> note')
    toggleCheckbox(quote)
    expect(quote.state.doc.toString()).toBe('- [ ] > note')
  })

  it('inserts links, images, and horizontal rules with useful selections', () => {
    const link = view('docs', 0, 4)
    insertLink(link)
    expect(link.state.doc.toString()).toBe('[docs](url)')
    expect(link.state.sliceDoc(
      link.state.selection.main.from,
      link.state.selection.main.to,
    )).toBe('docs')

    const image = view('', 0)
    insertImage(image)
    expect(image.state.doc.toString()).toBe('![alt](url)')
    expect(image.state.sliceDoc(
      image.state.selection.main.from,
      image.state.selection.main.to,
    )).toBe('alt')

    const rule = view('above', 5)
    insertHorizontalRule(rule)
    expect(rule.state.doc.toString()).toBe('above\n---\n')
  })
})
