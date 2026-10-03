import { EditorView } from '@codemirror/view'
import { ChangeSet } from '@codemirror/state'
import { diff } from '@codemirror/merge'
import { createUnifiedDiffView, createSplitDiffView, createReadOnlyView, getUnifiedChunks, getSplitChunks } from './merge.js'
import { reviewComments } from '../reviewComments.js'
import { reviewCommentMarkers, updateReviewComments } from './reviewComments.js'

// A disposable projection. The caller owns the review and its history.
export function createReviewView({ parent, session, layout = 'unified', mode = 'diff', locked = false, collapse = false, onChange, content, onComment, onSelection, onAddComment }) {
  const split = mode === 'diff' && layout === 'split'
  const readonly = mode !== 'diff'
  let selectedEditor = null
  function selection(editor) {
    const range = editor.state.selection.main
    return { from: range.from, to: range.to, text: editor.state.sliceDoc(range.from, range.to), document: editor.state.doc.toString() }
  }
  function markers(text) {
    return reviewCommentMarkers(reviewComments(session, text).filter(comment => comment.status !== 'resolved' || session.commentUI?.showResolved), onComment,
      locked ? null : editor => onAddComment?.(selection(editor)), editor => {
        if (editor.hasFocus || !selectedEditor) selectedEditor = editor
        onSelection?.(selection(selectedEditor))
      })
  }
  const original = session.references?.original ?? session.original
  const view = readonly
    ? createReadOnlyView({ parent, content: mode === 'original' ? original : content ?? session.result,
        extensions: markers(mode === 'original' ? original : content ?? session.result) })
    : (split ? createSplitDiffView : createUnifiedDiffView)({
        parent,
        originalContent: session.base,
        modifiedContent: content ?? session.result,
        editable: !locked,
        mergeControls: !locked,
        collapse,
        onReviewChange: onChange,
        extensions: markers(session.result),
        originalExtensions: markers(session.base),
        modifiedExtensions: markers(session.result),
      })
  const resultView = split ? view.b : view
  selectedEditor ||= resultView
  const scroll = split ? view.dom : view.scrollDOM
  if (session.position) {
    const position = session.position
    const editor = split && position.side === 'original' ? view.a : resultView
    selectedEditor = editor
    const target = editor.state.doc.toString()
    const changes = ChangeSet.of(diff(position.doc, target, { scanLimit: 5000 }).map(change => ({
      from: change.fromA, to: change.toA, insert: target.slice(change.fromB, change.toB),
    })), position.doc.length)
    const line = editor.state.doc.lineAt(changes.mapPos(position.anchor, 1))
    editor.dispatch({
      selection: {
        anchor: changes.mapPos(position.selection.anchor, 1),
        head: changes.mapPos(position.selection.head, 1),
      },
      effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }),
    })
    if (position.focused) editor.focus()
  }

  function savePosition() {
    const top = Math.max(0, scroll.getBoundingClientRect().top - selectedEditor.documentTop)
    const block = selectedEditor.lineBlockAtHeight(top)
    session.position = {
      doc: selectedEditor.state.doc.toString(),
      side: split && selectedEditor === view.a || mode === 'original' ? 'original' : 'result',
      anchor: Math.min(block.from, selectedEditor.state.doc.length),
      selection: { anchor: selectedEditor.state.selection.main.anchor, head: selectedEditor.state.selection.main.head },
      focused: parent.contains(document.activeElement),
    }
  }

  return {
    view,
    savePosition,
    getSelection() { return selection(selectedEditor) },
    getState() {
      const editor = selectedEditor
      const visible = editor.visibleRanges[0]
      return { kind: 'review', reviewId: session.id, mode, side: editor === view.a || mode === 'original' ? 'original' : 'result',
        content: editor.state.doc.toString(), selection: { from: editor.state.selection.main.from, to: editor.state.selection.main.to, text: editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to) },
        comments: reviewComments(session, editor.state.doc.toString(), { includeRemoved: true }).map(({ status }) => ({ status })),
        visibleRange: visible ? { ...visible, fromLine: editor.state.doc.lineAt(visible.from).number, toLine: editor.state.doc.lineAt(visible.to).number } : null }
    },
    refreshComments() {
      for (const editor of split ? [view.a, view.b] : [view]) {
        editor.dispatch({ effects: updateReviewComments.of(reviewComments(session, editor.state.doc.toString())
          .filter(comment => comment.status !== 'resolved' || session.commentUI?.showResolved)) })
      }
    },
    scrollToChunk(index) {
      if (readonly) return
      const chunk = (split ? getSplitChunks(view) : getUnifiedChunks(view))[index]
      if (!chunk) return
      session.currentChunk = index
      resultView.dispatch({ effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }) })
      if (split) view.a.dispatch({ effects: EditorView.scrollIntoView(chunk.fromA, { y: 'center' }) })
    },
    destroy(save = true) {
      if (save) savePosition()
      view.destroy()
    },
  }
}
