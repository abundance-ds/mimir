import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Window } from 'happy-dom'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { commentsExtension } from './comments.js'

let windowRef

beforeEach(() => {
  windowRef = new Window({ url: 'http://localhost' })
  windowRef.SyntaxError = SyntaxError
  globalThis.window = windowRef
  globalThis.document = windowRef.document
  globalThis.navigator = windowRef.navigator
  globalThis.HTMLElement = windowRef.HTMLElement
  globalThis.MutationObserver = windowRef.MutationObserver
  globalThis.DOMRect = windowRef.DOMRect
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  windowRef?.happyDOM?.abort()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.navigator
  delete globalThis.HTMLElement
  delete globalThis.MutationObserver
  delete globalThis.DOMRect
  delete globalThis.requestAnimationFrame
  delete globalThis.cancelAnimationFrame
  delete globalThis.ResizeObserver
})

function mountCommentEditor({ doc, onCommentAction }) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [commentsExtension({ onCommentAction })],
    }),
    parent,
  })
  return { parent, view }
}

function writeInput(input, value) {
  input.value = value
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function buttonByAction(parent, action) {
  return [...parent.getElementsByTagName('button')].find(button => button.dataset.commentAction === action)
}

describe('commentsExtension inline widget', () => {
  it('sends Save directly from the widget button', async () => {
    const actions = []
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="">World</comment>',
      onCommentAction: (action) => {
        actions.push(action)
        return { ok: true }
      },
    })

    writeInput(parent.getElementsByClassName('cm-comment-input')[0], 'Clarify this')
    buttonByAction(parent, 'save-text').click()
    await Promise.resolve()

    expect(actions).toEqual([{ type: 'save-text', id: 'c1', text: 'Clarify this' }])
    view.destroy()
  })

  it('keeps the draft visible when Save fails', async () => {
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="">World</comment>',
      onCommentAction: () => ({ ok: false, error: 'Comment not found.' }),
    })

    const input = parent.getElementsByClassName('cm-comment-input')[0]
    writeInput(input, 'Keep this draft')
    buttonByAction(parent, 'save-text').click()
    await Promise.resolve()

    expect(input.value).toBe('Keep this draft')
    expect(parent.getElementsByClassName('cm-comment-block')[0].classList.contains('has-error')).toBe(true)
    expect(parent.getElementsByClassName('cm-comment-error')[0].textContent).toBe('Comment not found.')
    view.destroy()
  })

  it('minimizes and restores a dense discussion without changing the document', () => {
    const doc = '<comment id="c1" author="user" text="Clarify">World<reply id="r1" author="agent" text="Done"/></comment>'
    const { parent, view } = mountCommentEditor({ doc, onCommentAction: () => ({ ok: true }) })
    const block = parent.getElementsByClassName('cm-comment-block')[0]
    const toggle = buttonByAction(parent, 'collapse')

    toggle.click()
    expect(block.classList.contains('is-collapsed')).toBe(true)
    expect(parent.getElementsByClassName('cm-comment-block-summary')[0].textContent)
      .toContain('1 reply')
    expect(view.state.doc.toString()).toBe(doc)

    toggle.click()
    expect(block.classList.contains('is-collapsed')).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })

  it('preserves resolved status and offers reopen instead of deleting the thread', async () => {
    const actions = []
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="Done" status="resolved">World</comment>',
      onCommentAction: action => {
        actions.push(action)
        return { ok: true }
      },
    })
    const block = parent.getElementsByClassName('cm-comment-block')[0]
    expect(block.classList.contains('is-resolved')).toBe(true)
    expect(block.classList.contains('is-collapsed')).toBe(true)

    buttonByAction(parent, 'reopen').click()
    await Promise.resolve()
    expect(actions).toEqual([{ type: 'reopen', id: 'c1', text: '' }])
    expect(view.state.doc.toString()).toContain('status="resolved"')
    view.destroy()
  })
})
