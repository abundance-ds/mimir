import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Window } from 'happy-dom'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  commentsExtension,
  commentMutation,
  getCommentsFromState,
  changesMayAffectComments,
  setResolvedCommentsVisible,
} from './comments.js'
import { parseCommentTags } from '../../services/comments/parser.js'

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

  it('removes resolved discussions from the document flow until history is shown', async () => {
    const actions = []
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="Done" status="resolved">World</comment>',
      onCommentAction: action => {
        actions.push(action)
        return { ok: true }
      },
    })

    expect(parent.getElementsByClassName('cm-comment-block')).toHaveLength(0)
    expect(parent.getElementsByClassName('cm-comment-range-resolved')).toHaveLength(0)

    view.dispatch({ effects: setResolvedCommentsVisible.of(true) })
    const block = parent.getElementsByClassName('cm-comment-block')[0]
    expect(block.classList.contains('is-resolved')).toBe(true)
    expect(block.classList.contains('is-collapsed')).toBe(true)
    expect(parent.getElementsByClassName('cm-comment-range-resolved')).toHaveLength(1)

    buttonByAction(parent, 'reopen').click()
    await Promise.resolve()
    expect(actions).toEqual([{ type: 'reopen', id: 'c1', text: '' }])
    expect(view.state.doc.toString()).toContain('status="resolved"')
    view.destroy()
  })

  it('hides an active discussion as soon as its stored status becomes resolved', () => {
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="Done" status="active">World</comment>',
      onCommentAction: () => ({ ok: true }),
    })
    expect(parent.getElementsByClassName('cm-comment-block')).toHaveLength(1)

    const doc = view.state.doc.toString()
    const from = doc.indexOf('status="active"')
    view.dispatch({
      changes: { from, to: from + 'status="active"'.length, insert: 'status="resolved"' },
      annotations: commentMutation.of(true),
    })

    expect(parent.getElementsByClassName('cm-comment-block')).toHaveLength(0)
    expect(parent.getElementsByClassName('cm-comment-range-resolved')).toHaveLength(0)
    expect(view.state.doc.toString()).toContain('status="resolved"')

    view.dispatch({ effects: setResolvedCommentsVisible.of(true) })
    expect(parent.getElementsByClassName('cm-comment-block')[0].classList.contains('is-collapsed')).toBe(true)

    const resolvedDoc = view.state.doc.toString()
    const resolvedFrom = resolvedDoc.indexOf('status="resolved"')
    view.dispatch({
      changes: {
        from: resolvedFrom,
        to: resolvedFrom + 'status="resolved"'.length,
        insert: 'status="active"',
      },
      annotations: commentMutation.of(true),
    })
    expect(parent.getElementsByClassName('cm-comment-block')[0].classList.contains('is-collapsed')).toBe(false)
    view.destroy()
  })

  it('labels the prompt handoff as Agent and emits the terminal action', async () => {
    const actions = []
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="Clarify">World</comment>',
      onCommentAction: action => {
        actions.push(action)
        return { ok: true }
      },
    })

    const button = buttonByAction(parent, 'terminal-prompt')
    expect(button.textContent).toBe('Agent')
    expect(button.getAttribute('aria-label')).toContain('active agent terminal')
    button.click()
    await Promise.resolve()
    expect(actions).toEqual([{ type: 'terminal-prompt', id: 'c1', text: '' }])
    view.destroy()
  })

  it('edits and deletes replies through explicit structured actions', async () => {
    const actions = []
    const { parent, view } = mountCommentEditor({
      doc: '<comment id="c1" author="user" text="Clarify">World<reply id="r1" author="agent" text="Old"/></comment>',
      onCommentAction: action => {
        actions.push(action)
        return { ok: true }
      },
    })

    buttonByAction(parent, 'edit-reply').click()
    const input = parent.getElementsByClassName('cm-comment-reply-editor')[0]
      .getElementsByTagName('textarea')[0]
    writeInput(input, 'Revised')
    buttonByAction(parent, 'update-reply').click()
    await Promise.resolve()
    expect(actions[0]).toEqual({
      type: 'update-reply',
      id: 'c1',
      replyId: 'r1',
      text: 'Revised',
    })

    buttonByAction(parent, 'delete-reply').click()
    await Promise.resolve()
    expect(actions[1]).toEqual({
      type: 'delete-reply',
      id: 'c1',
      replyId: 'r1',
      text: '',
    })
    view.destroy()
  })
})

// --- Incremental tag parsing ---

const TAG = '<comment id="c1" author="user" text="Note">World</comment>'
// Long bracket-free padding on both sides so plain edits in it are provably
// outside the tag-context window around the comment.
const PREFIX = 'a'.repeat(40) + ' '
const SUFFIX = ' ' + 'z'.repeat(40)

function stateWithDoc(doc) {
  return EditorState.create({ doc, extensions: [commentsExtension()] })
}

// Change-set builder without any comment extensions, so filters cannot
// interfere when unit-testing the guard itself.
function bareChanges(doc, changes) {
  const state = EditorState.create({ doc })
  return { changes: state.update({ changes }).changes, startDoc: state.doc }
}

describe('commentTagField incremental updates', () => {
  it('maps positions without reparsing when typing outside all comments', () => {
    const state = stateWithDoc(PREFIX + TAG + SUFFIX)
    const [before] = getCommentsFromState(state)

    // The guard itself must classify this edit as unaffected (fast path).
    expect(changesMayAffectComments(
      state.update({ changes: { from: 5, insert: 'xy' } }).changes,
      state.doc,
      getCommentsFromState(state),
    )).toBe(false)

    // Typing before the comment shifts every position by the insert length.
    const afterInsert = state.update({ changes: { from: 5, insert: 'xy' } }).state
    const [shifted] = getCommentsFromState(afterInsert)
    expect(shifted.tagFrom).toBe(before.tagFrom + 2)
    expect(shifted.contentFrom).toBe(before.contentFrom + 2)
    expect(shifted.contentTo).toBe(before.contentTo + 2)
    expect(shifted.tagTo).toBe(before.tagTo + 2)
    expect(shifted.anchorText).toBe('World')
    expect(shifted.id).toBe('c1')

    // Typing after the comment leaves every position untouched.
    const end = state.doc.length
    const afterAppend = state.update({ changes: { from: end, insert: 'xy' } }).state
    const [same] = getCommentsFromState(afterAppend)
    expect(same.tagFrom).toBe(before.tagFrom)
    expect(same.contentFrom).toBe(before.contentFrom)
    expect(same.contentTo).toBe(before.contentTo)
    expect(same.tagTo).toBe(before.tagTo)

    // Deleting outside the comment shifts positions back.
    const afterDelete = state.update({ changes: { from: 4, to: 7 } }).state
    const [pulled] = getCommentsFromState(afterDelete)
    expect(pulled.tagFrom).toBe(before.tagFrom - 3)
    expect(pulled.tagTo).toBe(before.tagTo - 3)
  })

  it('reparses when typing inside a comment anchor', () => {
    const state = stateWithDoc(PREFIX + TAG + SUFFIX)
    const [before] = getCommentsFromState(state)

    const tr = state.update({ changes: { from: before.contentFrom + 2, insert: 'XY' } })
    expect(changesMayAffectComments(tr.changes, state.doc, [before])).toBe(true)

    const [after] = getCommentsFromState(tr.state)
    expect(after.tagFrom).toBe(before.tagFrom)
    expect(after.contentFrom).toBe(before.contentFrom)
    expect(after.contentTo).toBe(before.contentTo + 2)
    expect(after.tagTo).toBe(before.tagTo + 2)
    // Only a reparse can refresh anchorText — mapping never touches it.
    expect(after.anchorText).toBe('WoXYrld')
  })

  it('drops the comment when its opening bracket is deleted', () => {
    const state = stateWithDoc(PREFIX + TAG + SUFFIX)
    const [before] = getCommentsFromState(state)

    const tr = state.update({
      changes: { from: before.tagFrom, to: before.tagFrom + 1 },
      annotations: commentMutation.of(true),
    })
    expect(changesMayAffectComments(tr.changes, state.doc, [before])).toBe(true)
    expect(getCommentsFromState(tr.state)).toEqual([])
  })

  it('parses a pasted full comment tag', () => {
    const state = stateWithDoc(PREFIX + TAG + SUFFIX)
    const pasted = '<comment id="c2" author="user" text="Second">Pasted</comment>'
    const end = state.doc.length

    const tr = state.update({ changes: { from: end, insert: pasted } })
    expect(changesMayAffectComments(tr.changes, state.doc, getCommentsFromState(state))).toBe(true)

    const comments = getCommentsFromState(tr.state)
    expect(comments.map(c => c.id)).toEqual(['c1', 'c2'])
    const c2 = comments[1]
    expect(c2.anchorText).toBe('Pasted')
    expect(c2.tagFrom).toBe(end)
    expect(c2.tagTo).toBe(end + pasted.length)
    expect(tr.state.doc.sliceString(c2.contentFrom, c2.contentTo)).toBe('Pasted')
  })

  it('reparses an edit spanning a tag boundary', () => {
    const state = stateWithDoc(PREFIX + TAG + SUFFIX)
    const [before] = getCommentsFromState(state)

    // Deletion starting outside the tag and ending inside the anchor text.
    const tr = state.update({
      changes: { from: before.tagFrom - 2, to: before.contentFrom + 2 },
      annotations: commentMutation.of(true),
    })
    expect(changesMayAffectComments(tr.changes, state.doc, [before])).toBe(true)
    // The opening tag is destroyed, so no comment must survive.
    expect(getCommentsFromState(tr.state)).toEqual([])
    expect(tr.state.doc.toString()).toContain('rld</comment>')
  })

  it('still sweeps lingering empty comments on the next plain edit', () => {
    const state = stateWithDoc(PREFIX + '<comment id="c1" author="user" text="Note">W</comment>' + SUFFIX)
    const [before] = getCommentsFromState(state)

    // Annotated mutations skip the cleanup filter (this mirrors the
    // handleBackspace path), leaving an empty comment behind.
    const emptied = state.update({
      changes: { from: before.contentFrom, to: before.contentTo },
      annotations: commentMutation.of(true),
    }).state
    const [empty] = getCommentsFromState(emptied)
    expect(empty.contentFrom).toBe(empty.contentTo)

    // A later plain edit far away must still trigger the cleanup sweep.
    const swept = emptied.update({ changes: { from: 3, insert: 'Q' } }).state
    expect(getCommentsFromState(swept)).toEqual([])
    expect(swept.doc.toString()).not.toContain('<comment')
    expect(swept.doc.toString()).toContain('aaaQ')
  })
})

describe('changesMayAffectComments', () => {
  const doc = PREFIX + TAG + SUFFIX
  const comments = parseCommentTags(doc).comments

  it('flags inserted text containing angle brackets anywhere', () => {
    const { changes, startDoc } = bareChanges(doc, { from: 2, insert: 'a < b' })
    expect(changesMayAffectComments(changes, startDoc, comments)).toBe(true)
  })

  it('flags deletions whose removed slice contains angle brackets', () => {
    const [c] = comments
    const { changes, startDoc } = bareChanges(doc, { from: c.tagFrom, to: c.tagFrom + 1 })
    expect(changesMayAffectComments(changes, startDoc, comments)).toBe(true)
  })

  it('flags bracket-free edits near an existing bracket (conservative window)', () => {
    const [c] = comments
    // Plain insert 3 chars before the opening `<` — could complete a partial tag.
    const { changes, startDoc } = bareChanges(doc, { from: c.tagFrom - 3, insert: 'x' })
    expect(changesMayAffectComments(changes, startDoc, comments)).toBe(true)
  })

  it('flags bracket-free edits inside a long attribute run', () => {
    const longDoc = PREFIX
      + `<comment id="c1" author="user" text="${'m'.repeat(60)}">World</comment>`
      + SUFFIX
    const parsed = parseCommentTags(longDoc).comments
    // Edit in the middle of the attribute, more than 16 chars from any bracket.
    const mid = parsed[0].tagFrom + 45
    const { changes, startDoc } = bareChanges(longDoc, { from: mid, insert: 'x' })
    expect(changesMayAffectComments(changes, startDoc, parsed)).toBe(true)
  })

  it('flags edits adjacent to a comment span', () => {
    const [c] = comments
    for (const pos of [c.tagFrom, c.tagTo]) {
      const { changes, startDoc } = bareChanges(doc, { from: pos, insert: 'x' })
      expect(changesMayAffectComments(changes, startDoc, comments)).toBe(true)
    }
  })

  it('passes plain edits far from brackets and comments', () => {
    for (const spec of [
      { from: 5, insert: 'hello' },
      { from: 4, to: 9 },
      { from: doc.length - 5, insert: 'tail' },
    ]) {
      const { changes, startDoc } = bareChanges(doc, spec)
      expect(changesMayAffectComments(changes, startDoc, comments)).toBe(false)
    }
  })

  it('passes plain edits in a document with no comments and no brackets', () => {
    const plain = 'just some ordinary prose with nothing special in it'
    const { changes, startDoc } = bareChanges(plain, { from: 10, insert: 'X' })
    expect(changesMayAffectComments(changes, startDoc, [])).toBe(false)
  })
})
