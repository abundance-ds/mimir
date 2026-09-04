import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdownCodeBlocks } from './markdownCodeBlocks.js'

const views = []
afterEach(() => { while (views.length) views.pop().destroy() })

function makeView(doc, lang) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc,
    extensions: [lang, ...markdownCodeBlocks()],
  })
  const view = new EditorView({ state, parent })
  ensureSyntaxTree(view.state, view.state.doc.length, 1000)
  // Force a sync update so the plugin rebuilds with the parsed tree.
  view.dispatch({ changes: [] })
  views.push(view)
  return view
}

describe('markdownCodeBlocks', () => {
  it('marks every line inside a fenced code block', () => {
    const doc = 'before\n```js\nconst a = 1\n```\nafter'
    const view = makeView(doc, markdown({ base: markdownLanguage }))
    const lines = view.dom.querySelectorAll('.cm-md-code-line')
    expect(lines.length).toBe(3) // ```js, const a = 1, ```
    // "before" and "after" should not be marked
    const allLines = view.dom.querySelectorAll('.cm-line')
    const unmarked = [...allLines].filter(el => !el.classList.contains('cm-md-code-line'))
    expect(unmarked.length).toBe(2)
  })

  it('does not mark any lines in a non-markdown document', () => {
    const doc = 'const x = 1\nconst y = 2'
    const view = makeView(doc, javascript())
    const lines = view.dom.querySelectorAll('.cm-md-code-line')
    expect(lines.length).toBe(0)
  })
})
