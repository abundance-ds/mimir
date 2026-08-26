import { describe, it, expect } from 'vitest'
import { EditorState, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Strikethrough } from '@lezer/markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { _buildCheckboxDecorations, taskCheckboxExtension } from './taskCheckboxes.js'

function makeView(doc, cursorPos = 0) {
  const parent = document.createElement('div')
  const state = EditorState.create({
    doc,
    selection: { anchor: cursorPos },
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
    ],
  })
  const view = new EditorView({ state, parent })
  ensureSyntaxTree(view.state, view.state.doc.length, 1000)
  return view
}

function getDecos(doc, cursorPos = 0) {
  const view = makeView(doc, cursorPos)
  const decos = _buildCheckboxDecorations(view, () => true)
  const result = []
  const iter = decos.iter()
  while (iter.value) {
    result.push({
      from: iter.from,
      to: iter.to,
      class: iter.value.spec?.class,
      widget: iter.value.spec?.widget?.constructor?.name,
      checked: iter.value.spec?.widget?.checked,
    })
    iter.next()
  }
  view.destroy()
  return result
}

describe('taskCheckboxes', () => {
  it('returns no decorations when disabled', () => {
    const view = makeView('- [ ] task')
    const decos = _buildCheckboxDecorations(view, () => false)
    expect(decos.size).toBe(0)
    view.destroy()
  })

  it('renders a checkbox widget for a dashed task item', () => {
    const doc = '- [ ] task\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box.length).toBe(1)
    expect(box[0].checked).toBe(false)
    expect(box[0].from).toBe(doc.indexOf('['))
    expect(box[0].to).toBe(doc.indexOf('[') + 3)
  })

  it('renders a checkbox widget for a bare bracket line with no bullet', () => {
    const doc = '[ ] task\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box.length).toBe(1)
    expect(box[0].checked).toBe(false)
  })

  it('marks a checked task as checked and strikes through the label', () => {
    const doc = '- [x] done\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    const strike = decos.filter(d => d.class === 'cm-lp-task-done')
    expect(box[0].checked).toBe(true)
    expect(strike.length).toBe(1)
  })

  it('accepts uppercase X as checked', () => {
    const doc = '- [X] done\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box[0].checked).toBe(true)
  })

  it('does not strike through unchecked tasks', () => {
    const doc = '- [ ] pending\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const strike = decos.filter(d => d.class === 'cm-lp-task-done')
    expect(strike.length).toBe(0)
  })

  it('does not render a widget when the cursor is on the same line', () => {
    const doc = '- [ ] task'
    const decos = getDecos(doc, 2)
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box.length).toBe(0)
  })

  it('rebuilds when deferred Markdown parsing completes', () => {
    const doc = '```\n- [ ] not a task\n```\n\nother'
    const parent = document.createElement('div')
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('other') },
      extensions: [taskCheckboxExtension(() => true)],
    })
    const view = new EditorView({ state, parent })

    expect(view.dom.querySelector('.cm-lp-task-checkbox')).not.toBeNull()

    view.dispatch({
      effects: StateEffect.appendConfig.of(
        markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      ),
    })

    expect(view.dom.querySelector('.cm-lp-task-checkbox')).toBeNull()
    view.destroy()
  })

  it('ignores checkbox-like text inside fenced code blocks', () => {
    const doc = '```\n- [ ] not a checkbox\n```\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box.length).toBe(0)
  })

  it('ignores lines with text before the brackets', () => {
    const doc = 'foo [ ] bar\n\nother'
    const decos = getDecos(doc, doc.indexOf('other'))
    const box = decos.filter(d => d.widget === 'TaskCheckboxWidget')
    expect(box.length).toBe(0)
  })
})
