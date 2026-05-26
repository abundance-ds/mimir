import { StateEffect, StateField, Prec, EditorState, Annotation } from '@codemirror/state'
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { parseCommentTags, stripCommentTags } from '../../services/comments/parser.js'

// --- Effects & Annotations ---

export const setActiveComment = StateEffect.define()
export const commentMutation = Annotation.define()

// --- StateField ---

export const commentTagField = StateField.define({
  create(state) {
    const { comments } = parseCommentTags(state.doc.toString())
    return { comments, activeId: null }
  },
  update(value, tr) {
    let { comments, activeId } = value

    if (tr.docChanged) {
      const parsed = parseCommentTags(tr.state.doc.toString())
      comments = parsed.comments
    }

    for (const effect of tr.effects) {
      if (effect.is(setActiveComment)) {
        activeId = effect.value
      }
    }

    return { comments, activeId }
  },
})

// --- Decorations ---

const commentDecorations = EditorView.decorations.compute([commentTagField], (state) => {
  const { comments, activeId } = state.field(commentTagField)
  const decos = []
  const docLen = state.doc.length

  for (const c of comments) {
    if (c.tagFrom >= docLen || c.contentFrom > docLen) continue

    if (c.contentFrom > c.tagFrom) {
      decos.push(Decoration.replace({}).range(c.tagFrom, Math.min(c.contentFrom, docLen)))
    }
    if (c.contentTo < c.tagTo) {
      decos.push(Decoration.replace({}).range(Math.min(c.contentTo, docLen), Math.min(c.tagTo, docLen)))
    }

    const safeFrom = Math.min(c.contentFrom, docLen)
    const safeTo = Math.min(c.contentTo, docLen)
    if (safeFrom < safeTo) {
      decos.push(
        Decoration.mark({
          class: c.id === activeId ? 'cm-comment-range cm-comment-range-active' : 'cm-comment-range',
        }).range(safeFrom, safeTo)
      )
    }
  }

  return Decoration.set(decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide))
})

class CommentBlockWidget extends WidgetType {
  constructor(comment, activeId, onCommentClick, onCommentAction, drafts) {
    super()
    this.comment = comment
    this.activeId = activeId
    this.onCommentClick = onCommentClick
    this.onCommentAction = onCommentAction
    this.drafts = drafts
  }

  eq(other) {
    return other.comment.id === this.comment.id &&
      other.comment.text === this.comment.text &&
      other.activeId === this.activeId &&
      other.onCommentClick === this.onCommentClick &&
      other.onCommentAction === this.onCommentAction &&
      JSON.stringify(other.comment.replies || []) === JSON.stringify(this.comment.replies || [])
  }

  ignoreEvent() {
    return true
  }

  toDOM(view) {
    const c = this.comment
    const wrap = document.createElement('div')
    const hasText = Boolean(c.text?.trim())
    wrap.className = `cm-comment-block${c.id === this.activeId ? ' is-active' : ''}${hasText ? '' : ' is-empty'}`
    wrap.dataset.commentId = c.id
    wrap.contentEditable = 'false'

    wrap.addEventListener('mousedown', (event) => event.stopPropagation())
    wrap.addEventListener('keydown', (event) => event.stopPropagation())
    wrap.addEventListener('click', (event) => {
      if (event.target.closest('button, textarea, summary, details')) return
      this.activate(view)
    })

    const header = document.createElement('div')
    header.className = 'cm-comment-block-header'

    const meta = document.createElement('span')
    meta.className = 'cm-comment-block-meta'
    meta.textContent = authorLabel(c.author)
    header.append(meta)

    const actions = document.createElement('div')
    actions.className = 'cm-comment-block-actions'
    const terminalButton = makeButton('Tag', 'terminal-prompt', { title: 'Paste a comment prompt into the terminal' })
    const resolveButton = makeButton('Resolve', 'delete', { title: 'Remove this comment wrapper' })
    const more = makeMoreMenu()
    actions.append(terminalButton, resolveButton, more)
    header.append(actions)
    wrap.append(header)

    if (hasText) {
      const body = document.createElement('div')
      body.className = 'cm-comment-block-body'
      body.textContent = c.text
      wrap.append(body)
    }

    if (c.replies?.length) {
      const replies = document.createElement('div')
      replies.className = 'cm-comment-replies'
      for (const reply of c.replies) {
        const item = document.createElement('div')
        item.className = 'cm-comment-reply'
        const who = document.createElement('span')
        who.className = 'cm-comment-reply-author'
        who.textContent = reply.author || 'agent'
        const text = document.createElement('span')
        text.textContent = reply.text || ''
        item.append(who, text)
        replies.append(item)
      }
      wrap.append(replies)
    }

    const draft = ensureDraft(this.drafts, c.id, !hasText)
    const replyTrigger = document.createElement('button')
    replyTrigger.type = 'button'
    replyTrigger.className = 'cm-comment-reply-trigger'
    replyTrigger.textContent = 'Reply...'
    replyTrigger.hidden = !hasText || draft.open || Boolean(draft.text)

    const inputRow = document.createElement('div')
    inputRow.className = 'cm-comment-compose'
    inputRow.hidden = hasText && !draft.open && !draft.text
    const input = document.createElement('textarea')
    input.className = 'cm-comment-input'
    input.dataset.commentInput = 'true'
    input.rows = 1
    input.value = draft.text
    input.spellcheck = false
    input.autocomplete = 'off'
    input.autocorrect = 'off'
    input.autocapitalize = 'off'
    input.placeholder = hasText ? 'Reply' : 'Comment'
    const saveAction = hasText ? 'reply' : 'save-text'
    const saveButton = makeButton(hasText ? 'Reply' : 'Save', saveAction, { primary: true })

    const error = document.createElement('div')
    error.className = 'cm-comment-error'

    const syncDraft = () => {
      draft.text = input.value
      saveButton.disabled = !input.value.trim()
      resizeTextarea(input)
    }

    const closeReplyComposer = () => {
      if (!hasText) return
      draft.open = false
      draft.text = ''
      input.value = ''
      inputRow.hidden = true
      replyTrigger.hidden = false
      syncDraft()
    }

    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        saveButton.click()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeReplyComposer()
      }
    })
    input.addEventListener('input', syncDraft)
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('mousedown', (event) => event.stopPropagation())

    wireWidgetButton(terminalButton, {
      view,
      widget: this,
      wrap,
      action: 'terminal-prompt',
      error,
    })
    wireWidgetButton(resolveButton, {
      view,
      widget: this,
      wrap,
      action: 'delete',
      error,
    })
    wireWidgetButton(more.copyButton, {
      view,
      widget: this,
      wrap,
      action: 'copy-prompt',
      error,
      onOk: () => { more.open = false },
    })
    wireWidgetButton(more.stripButton, {
      view,
      widget: this,
      wrap,
      action: 'strip-all',
      error,
      onOk: () => { more.open = false },
    })
    wireWidgetButton(saveButton, {
      view,
      widget: this,
      wrap,
      action: saveAction,
      text: () => input.value.trim(),
      error,
      onBefore: () => {
        if (!input.value.trim()) {
          input.focus()
          return false
        }
        return true
      },
      onBeforeAction: () => {
        const previous = { text: draft.text, open: draft.open }
        draft.text = ''
        if (saveAction === 'reply') draft.open = false
        return () => {
          draft.text = previous.text
          draft.open = previous.open
        }
      },
      onOk: () => {
        draft.text = ''
        input.value = ''
        if (saveAction === 'reply') closeReplyComposer()
        syncDraft()
      },
    })

    replyTrigger.addEventListener('mousedown', stopWidgetMouse)
    replyTrigger.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      draft.open = true
      inputRow.hidden = false
      replyTrigger.hidden = true
      requestAnimationFrame(() => input.focus())
    })

    inputRow.append(input, saveButton)
    wrap.append(replyTrigger)
    wrap.append(inputRow)
    wrap.append(error)
    syncDraft()

    if (!hasText) {
      requestAnimationFrame(() => input.focus())
    }

    return wrap
  }

  activate(view) {
    view.dispatch({ effects: setActiveComment.of(this.comment.id) })
    this.onCommentClick?.(this.comment.id)
  }
}

function authorLabel(author) {
  if (author === 'ai' || author === 'agent' || author === 'assistant') return 'Agent'
  return 'You'
}

function ensureDraft(drafts, id, open = false) {
  if (!drafts.has(id)) drafts.set(id, { text: '', open })
  return drafts.get(id)
}

function makeButton(label, action, { primary = false, title = '' } = {}) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = primary ? 'cm-comment-btn cm-comment-btn-primary' : 'cm-comment-btn'
  button.dataset.commentAction = action
  button.textContent = label
  if (title) button.title = title
  return button
}

function makeMoreMenu() {
  const details = document.createElement('details')
  details.className = 'cm-comment-more'
  const summary = document.createElement('summary')
  summary.className = 'cm-comment-more-trigger'
  summary.textContent = '...'
  summary.title = 'More comment actions'

  const menu = document.createElement('div')
  menu.className = 'cm-comment-menu'
  const copyButton = makeButton('Copy prompt', 'copy-prompt')
  const stripButton = makeButton('Remove all comments', 'strip-all')
  menu.append(
    copyButton,
    stripButton,
  )
  details.append(summary, menu)
  details.copyButton = copyButton
  details.stripButton = stripButton
  details.addEventListener('mousedown', (event) => event.stopPropagation())
  details.addEventListener('click', (event) => event.stopPropagation())
  return details
}

function stopWidgetMouse(event) {
  event.preventDefault()
  event.stopPropagation()
}

function resizeTextarea(input) {
  input.style.height = ''
  input.style.height = `${Math.min(input.scrollHeight || 24, 96)}px`
}

function wireWidgetButton(button, opts) {
  if (!button) return
  button.addEventListener('mousedown', stopWidgetMouse)
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (opts.onBefore && opts.onBefore() === false) return
    runWidgetAction({
      ...opts,
      button,
      text: typeof opts.text === 'function' ? opts.text() : opts.text,
    })
  })
}

function runWidgetAction({ view, widget, wrap, action, text = '', button, error, onBeforeAction, onOk }) {
  wrap.classList.remove('has-error')
  error.textContent = ''
  if (button) button.disabled = true
  let rollback = null
  if (onBeforeAction) rollback = onBeforeAction()
  widget.onCommentClick?.(widget.comment.id)

  Promise.resolve(widget.onCommentAction?.({ type: action, id: widget.comment.id, text }))
    .then((result) => {
      if (result?.ok === false) {
        rollback?.()
        wrap.classList.add('has-error')
        error.textContent = result.error || 'Comment action failed.'
        return
      }
      onOk?.()
    })
    .catch((err) => {
      rollback?.()
      wrap.classList.add('has-error')
      error.textContent = err?.message || 'Comment action failed.'
    })
    .finally(() => {
      if (button) button.disabled = false
    })
}

function createInlineCommentBlocks(onCommentClick, onCommentAction) {
  const drafts = new Map()
  return EditorView.decorations.compute([commentTagField], (state) => {
    const { comments, activeId } = state.field(commentTagField)
    const decos = []
    const docLen = state.doc.length

    for (const c of comments) {
      if (c.contentFrom > docLen) continue
      const anchorPos = Math.min(c.contentTo, docLen)
      const line = state.doc.lineAt(anchorPos)
      decos.push(
        Decoration.widget({
          widget: new CommentBlockWidget(c, activeId, onCommentClick, onCommentAction, drafts),
          block: true,
          side: 1,
        }).range(line.to),
      )
    }

    return Decoration.set(decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide))
  })
}

const inlineCommentBlocks = createInlineCommentBlocks()

// --- Atomic ranges: make hidden tags behave as indivisible units for cursor/deletion ---

const commentAtomicRanges = EditorView.atomicRanges.of((view) => {
  const { comments } = view.state.field(commentTagField)
  const ranges = []
  const docLen = view.state.doc.length

  for (const c of comments) {
    // Opening tag: <comment ...>
    if (c.contentFrom > c.tagFrom && c.tagFrom < docLen) {
      ranges.push(Decoration.mark({}).range(c.tagFrom, Math.min(c.contentFrom, docLen)))
    }
    // Closing tag + replies: </comment>
    if (c.tagTo > c.contentTo && c.contentTo < docLen) {
      ranges.push(Decoration.mark({}).range(Math.min(c.contentTo, docLen), Math.min(c.tagTo, docLen)))
    }
  }

  return Decoration.set(ranges.sort((a, b) => a.from - b.from || a.startSide - b.startSide))
})

// --- Layer 3: changeFilter — protect tag ranges from any modification ---
//
// This is the CM6-recommended primitive for readonly ranges (per Marijn Haverbeke).
// Returns an array of [from, to, ...] pairs where changes should be suppressed.
// Any edit touching these ranges is silently dropped.

const commentChangeFilter = EditorState.changeFilter.of((tr) => {
  if (tr.annotation(commentMutation)) return true

  const { comments } = tr.startState.field(commentTagField)
  if (comments.length === 0) return true

  const protectedRanges = []
  for (const c of comments) {
    protectedRanges.push(c.tagFrom, c.contentFrom)
    protectedRanges.push(c.contentTo, c.tagTo)
  }
  return protectedRanges
})

// --- Layer 4: keymap — redirect backspace/delete at tag boundaries ---
//
// Without this, backspace/delete at a tag boundary would be silently blocked
// by changeFilter (because atomicRanges makes CM6 target the tag range).
// These handlers detect that situation and redirect to the correct visible char.

function isInsideTag(pos, comments) {
  for (const c of comments) {
    if (pos > c.tagFrom && pos < c.contentFrom) return c
    if (pos > c.contentTo && pos < c.tagTo) return c
  }
  return null
}

const commentKeyHandlers = Prec.high(keymap.of([
  { key: 'Backspace', run: handleBackspace },
  { key: 'Delete', run: handleDelete },
]))

function handleBackspace(view) {
  const { head, empty } = view.state.selection.main
  if (!empty) return false
  const { comments } = view.state.field(commentTagField)

  for (const c of comments) {
    // Cursor right after closing tag — delete last annotated char instead
    if (head === c.tagTo && c.contentTo > c.contentFrom) {
      view.dispatch({
        changes: { from: c.contentTo - 1, to: c.contentTo },
        annotations: commentMutation.of(true),
      })
      return true
    }
    // Cursor at contentFrom (start of annotated text, right after opening tag)
    // — delete char before the entire comment
    if (head === c.contentFrom && c.tagFrom > 0) {
      view.dispatch({
        changes: { from: c.tagFrom - 1, to: c.tagFrom },
      })
      return true
    }
  }
  return false
}

function handleDelete(view) {
  const { head, empty } = view.state.selection.main
  if (!empty) return false
  const { comments } = view.state.field(commentTagField)

  for (const c of comments) {
    // Cursor right before opening tag — delete first annotated char instead
    if (head === c.tagFrom && c.contentFrom < c.contentTo) {
      view.dispatch({
        changes: { from: c.contentFrom, to: c.contentFrom + 1 },
        annotations: commentMutation.of(true),
      })
      return true
    }
    // Cursor at contentTo (end of annotated text, right before closing tag)
    // — delete char after the entire comment
    if (head === c.contentTo && c.tagTo < view.state.doc.length) {
      view.dispatch({
        changes: { from: c.tagTo, to: c.tagTo + 1 },
      })
      return true
    }
  }
  return false
}

// --- Empty-comment cleanup: auto-remove comments with no anchor text ---

const commentEmptyCleanup = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  if (tr.annotation(commentMutation)) return tr

  const newDoc = tr.newDoc.toString()
  const newComments = parseCommentTags(newDoc).comments
  const empties = newComments.filter(c => c.contentFrom === c.contentTo)
  if (empties.length === 0) return tr

  let text = newDoc
  for (const c of empties.sort((a, b) => b.tagFrom - a.tagFrom)) {
    text = text.slice(0, c.tagFrom) + text.slice(c.tagTo)
  }
  return { changes: { from: 0, to: tr.startState.doc.length, insert: text } }
})

// --- Click handler ---

function createClickHandler(onCommentClick) {
  return EditorView.domEventHandlers({
    click(event, view) {
      const block = event.target.closest?.('.cm-comment-block')
      if (block) {
        return false
      }

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const { comments } = view.state.field(commentTagField)
      for (const c of comments) {
        if (pos >= c.contentFrom && pos <= c.contentTo) {
          view.dispatch({ effects: setActiveComment.of(c.id) })
          if (onCommentClick) onCommentClick(c.id)
          return false
        }
      }
      if (onCommentClick) onCommentClick(null)
      return false
    },
  })
}

// --- Copy/cut handler: strip tags from clipboard ---

function createClipboardHandler() {
  return EditorView.domEventHandlers({
    copy(event, view) {
      const sel = view.state.selection.main
      if (sel.from === sel.to) return false
      const raw = view.state.sliceDoc(sel.from, sel.to)
      const clean = stripCommentTags(raw)
      if (clean !== raw) {
        event.preventDefault()
        event.clipboardData.setData('text/plain', clean)
        return true
      }
      return false
    },
    cut(event, view) {
      const sel = view.state.selection.main
      if (sel.from === sel.to) return false
      const raw = view.state.sliceDoc(sel.from, sel.to)
      const clean = stripCommentTags(raw)
      if (clean !== raw) {
        event.preventDefault()
        event.clipboardData.setData('text/plain', clean)
      }
      return false
    },
  })
}

// --- Scroll plugin ---

function createScrollPlugin(onScroll, onGeometryChange) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view
      this.onScroll = onScroll
      this.onGeometryChange = onGeometryChange
      this.handler = () => {
        const dom = this.view.scrollDOM
        this.onScroll({ scrollTop: dom.scrollTop, scrollHeight: dom.scrollHeight, clientHeight: dom.clientHeight })
      }
      view.scrollDOM.addEventListener('scroll', this.handler)
    }

    update(update) {
      if (update.docChanged || update.geometryChanged) {
        const dom = this.view.scrollDOM
        this.onScroll({ scrollTop: dom.scrollTop, scrollHeight: dom.scrollHeight, clientHeight: dom.clientHeight })
      }
      if (update.geometryChanged && this.onGeometryChange) {
        this.onGeometryChange()
      }
    }

    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.handler)
    }
  })
}

// --- Public API ---

export function getCommentsFromState(state) {
  return state.field(commentTagField).comments
}

export function commentsExtension({ onCommentClick, onCommentAction, onScroll, onGeometryChange, onCommentCreate } = {}) {
  const ext = [
    commentTagField,
    commentDecorations,
    onCommentAction || onCommentClick
      ? createInlineCommentBlocks(onCommentClick, onCommentAction)
      : inlineCommentBlocks,
    commentAtomicRanges,
    commentChangeFilter,
    commentKeyHandlers,
    commentEmptyCleanup,
    createClickHandler(onCommentClick),
    createClipboardHandler(),
  ]
  if (onCommentCreate) {
    ext.push(Prec.high(keymap.of([{
      key: 'Mod-Shift-m',
      run(view) {
        const sel = view.state.selection.main
        if (sel.from === sel.to) return false
        onCommentCreate({ from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) })
        return true
      },
    }])))
  }
  if (onScroll) {
    ext.push(createScrollPlugin(onScroll, onGeometryChange))
  }
  return ext
}
