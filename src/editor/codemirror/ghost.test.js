import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ghostExtension } from './ghost.js'

const views = []

function createView(doc, getSuggestions) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: ghostExtension({ getSuggestions }),
    }),
  })
  views.push(view)
  return view
}

function key(view, keyName, options = {}) {
  const event = new KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  view.contentDOM.dispatchEvent(event)
  return event
}

async function triggerGhost(view) {
  key(view, '+')
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: '+' },
    selection: { anchor: pos + 1 },
  })
  const second = key(view, '+')
  await vi.waitFor(() => expect(view.dom.querySelector('.ghost-text')).toBeTruthy())
  return second
}

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  }
})

describe('ghost completion', () => {
  it('does not consume ++ without a completion provider', () => {
    const view = createView('')
    key(view, '+')
    view.dispatch({ changes: { from: 0, insert: '+' }, selection: { anchor: 1 } })
    const second = key(view, '+')
    expect(second.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('+')
  })

  it('preserves increment and C++ syntax after an identifier', () => {
    const provider = vi.fn(async () => [' should not appear'])
    const view = createView('count', provider)
    key(view, '+')
    view.dispatch({ changes: { from: 5, insert: '+' }, selection: { anchor: 6 } })
    const second = key(view, '+')
    expect(second.defaultPrevented).toBe(false)
    expect(provider).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('count+')
  })

  it('accepts a whole suggestion with Tab and one word with Alt+Right', async () => {
    const view = createView('', async () => ['hello world'])
    const trigger = await triggerGhost(view)
    expect(trigger.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('')

    const partial = key(view, 'ArrowRight', { altKey: true })
    expect(partial.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('hello ')
    expect(view.dom.querySelector('.ghost-text')?.textContent).toBe('world')

    key(view, 'Tab')
    expect(view.state.doc.toString()).toBe('hello world')
    expect(view.dom.querySelector('.ghost-text')).toBeNull()
  })

  it('dismisses on Enter while leaving Enter available to the editor', async () => {
    const view = createView('', async () => ['suggestion'])
    await triggerGhost(view)
    const enter = key(view, 'Enter')
    expect(enter.defaultPrevented).toBe(false)
    expect(view.dom.querySelector('.ghost-text')).toBeNull()
  })

  it('clears empty and failed requests instead of inventing local prose', async () => {
    const empty = createView('', async () => [])
    key(empty, '+')
    empty.dispatch({ changes: { from: 0, insert: '+' }, selection: { anchor: 1 } })
    key(empty, '+')
    await vi.waitFor(() => expect(empty.dom.querySelector('.ghost-loading')).toBeNull())
    expect(empty.dom.querySelector('.ghost-text')).toBeNull()

    const failed = createView('', async () => {
      throw new Error('offline')
    })
    key(failed, '+')
    failed.dispatch({ changes: { from: 0, insert: '+' }, selection: { anchor: 1 } })
    key(failed, '+')
    await vi.waitFor(() => expect(failed.dom.querySelector('.ghost-loading')).toBeNull())
    expect(failed.dom.querySelector('.ghost-error-line')).toBeNull()
  })

  it('shows structured provider errors rather than swallowing configuration guidance', async () => {
    const view = createView('', async () => ({ error: 'Configure an API key.' }))
    key(view, '+')
    view.dispatch({ changes: { from: 0, insert: '+' }, selection: { anchor: 1 } })
    key(view, '+')
    await vi.waitFor(() => {
      expect(view.dom.querySelector('.ghost-error-line')?.textContent)
        .toContain('Configure an API key.')
    })
  })
})
