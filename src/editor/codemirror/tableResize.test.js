import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { history, undo } from '@codemirror/commands'
import { livePreviewExtension, tableWidthsField } from './livePreview.js'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const sample = 'Intro\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\nEnd'
const views = []
afterEach(() => { vi.restoreAllMocks(); views.splice(0).forEach(view => { const dom = view.dom.parentNode; view.destroy(); dom.remove() }) })
function setup(doc = sample, enabled = () => true) {
  const compartment = new Compartment()
  const extension = () => livePreviewExtension(enabled, () => '/test.md', undefined, { resizableTables: () => true })
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), history(), compartment.of(extension())] })
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({ state, parent })
  ensureSyntaxTree(view.state, doc.length, 1000)
  view.dispatch({})
  for (const header of view.dom.querySelectorAll('th')) {
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ width: 200 })
  }
  views.push(view)
  return { view, compartment, extension }
}
function resize(view, index = 0, key = 'ArrowRight') {
  const handle = view.dom.querySelectorAll('.cm-lp-column-resize')[index]
  handle.focus()
  handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  return handle
}

describe('table column resizing', () => {
  it('keeps source, selection, focus, and undo unchanged; resets to automatic layout', () => {
    const { view } = setup()
    const selection = view.state.selection
    const handle = resize(view)
    expect(view.state.doc.toString()).toBe(sample)
    expect(view.state.selection).toBe(selection)
    expect(document.activeElement).toBe(handle)
    expect(undo(view)).toBe(false)
    expect(view.state.field(tableWidthsField)[0].widths).toEqual([208, 192])
    expect(view.dom.querySelector('table').style.width).toBe('100%')
    view.dom.querySelector('.cm-lp-table-controls button').click()
    expect(view.state.field(tableWidthsField)).toEqual([])
    expect(view.dom.querySelector('table').style.width).toBe('100%')
  })

  it('keeps widths through source, tab state restoration, and extension reconfiguration', () => {
    const { view, compartment, extension } = setup()
    resize(view)
    view.dispatch({ selection: { anchor: sample.indexOf('Alpha') } })
    expect(view.dom.querySelector('table')).toBeNull()
    view.dispatch({ selection: { anchor: 0 } })
    expect(view.dom.querySelector('table').style.width).toBe('100%')
    const saved = view.state
    const other = setup().view.state
    view.setState(other)
    expect(view.state.field(tableWidthsField)).toEqual([])
    view.setState(saved)
    view.dispatch({ effects: compartment.reconfigure(extension()) })
    expect(view.dom.querySelector('table').style.width).toBe('100%')
  })

  it('maps edits before a table, keeps cell edits, and discards deleted tables', () => {
    const { view } = setup()
    resize(view)
    view.dispatch({ changes: { from: 0, insert: 'More\n' } })
    expect(view.state.field(tableWidthsField)[0].from).toBe(sample.indexOf('|') + 5)
    const from = view.state.doc.toString().indexOf('Alpha')
    view.dispatch({ changes: { from, to: from + 5, insert: 'Changed' } })
    expect(view.state.field(tableWidthsField)[0].widths).toEqual([208, 192])
    const entry = view.state.field(tableWidthsField)[0]
    view.dispatch({ changes: { from: entry.from, to: entry.to } })
    expect(view.state.field(tableWidthsField)).toEqual([])
  })

  it('keeps identical tables independent', () => {
    const { view } = setup(sample + '\n\n' + sample)
    resize(view)
    resize(view, 1, 'ArrowLeft')
    expect(view.state.field(tableWidthsField).map(entry => entry.widths)).toEqual([[208, 192], [192, 208]])
  })

  it('keeps the third column in place and clamps resizing at the adjacent minimum', () => {
    const { view } = setup('Intro\n\n| A | B | C |\n| --- | --- | --- |\n| One | Two | Three |')
    expect(view.dom.querySelectorAll('.cm-lp-column-resize')).toHaveLength(2)
    const handle = view.dom.querySelector('.cm-lp-column-resize')
    handle.setPointerCapture = vi.fn()
    for (const [type, x] of [['pointerdown', 0], ['pointermove', 500], ['pointerup', 500]]) {
      handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, bubbles: true, cancelable: true }))
    }
    expect(view.state.field(tableWidthsField)[0].widths).toEqual([336, 64, 200])
    expect(view.dom.querySelector('table').style.width).toBe('100%')
    expect([...view.dom.querySelectorAll('col')].reduce((sum, col) => sum + parseFloat(col.style.width), 0)).toBeCloseTo(100)
  })

  it('clears widths on column changes and keeps them while preview is disabled', () => {
    let enabled = true
    const { view } = setup(sample, () => enabled)
    resize(view)
    enabled = false
    view.dispatch({})
    expect(view.dom.querySelector('table')).toBeNull()
    enabled = true
    view.dispatch({})
    expect(view.dom.querySelector('table').style.width).toBe('100%')
    const from = sample.indexOf('| Name')
    const to = sample.indexOf('| Alpha')
    view.dispatch({ changes: { from, to, insert: '| Name | Value | Extra |\n| --- | --- | --- |\n' } })
    expect(view.state.field(tableWidthsField)).toEqual([])
  })

  it('captures a drag, cancels on Escape, and commits on release', () => {
    const { view } = setup()
    const handle = view.dom.querySelector('.cm-lp-column-resize')
    handle.setPointerCapture = vi.fn()
    const pointer = (type, x) => handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, bubbles: true, cancelable: true }))
    pointer('pointerdown', 100)
    pointer('pointermove', 150)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(view.state.field(tableWidthsField)).toEqual([])
    pointer('pointerdown', 100)
    pointer('pointermove', 150)
    pointer('pointerup', 150)
    expect(view.state.field(tableWidthsField)[0].widths).toEqual([250, 150])
    expect(view.state.selection.main.head).toBe(0)
    expect(view.dom.querySelector('.cm-lp-table-resizing')).toBeNull()
    pointer('pointerdown', 100)
    pointer('pointermove', 200)
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
    pointer('pointerup', 200)
    expect(view.state.field(tableWidthsField)[0].widths).toEqual([250, 150])
    expect(view.dom.querySelector('.cm-lp-table-resizing')).toBeNull()
  })
})
