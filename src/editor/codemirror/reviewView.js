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
  function selection(editor) {
    const range = editor.state.selection.main
    return { from: range.from, to: range.to, text: editor.state.sliceDoc(range.from, range.to), document: editor.state.doc.toString() }
  }
  function markers(text) {
    return reviewCommentMarkers(reviewComments(session, text).filter(comment => comment.status !== 'resolved' || session.commentUI?.showResolved), onComment,
      locked ? null : editor => onAddComment?.(selection(editor)), editor => onSelection?.(selection(editor)))
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
  const scroll = split ? view.dom : view.scrollDOM
  if (session.position) {
    const position = session.position
    const target = resultView.state.doc.toString()
    const changes = ChangeSet.of(diff(position.doc, target, { scanLimit: 5000 }).map(change => ({
      from: change.fromA, to: change.toA, insert: target.slice(change.fromB, change.toB),
    })), position.doc.length)
    const line = resultView.state.doc.lineAt(changes.mapPos(position.anchor, 1))
    resultView.dispatch({
      selection: {
        anchor: changes.mapPos(position.selection.anchor, 1),
        head: changes.mapPos(position.selection.head, 1),
      },
      effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }),
    })
    if (position.focused) resultView.focus()
  }

  function savePosition() {
    const top = Math.max(0, scroll.getBoundingClientRect().top - resultView.documentTop)
    const block = resultView.lineBlockAtHeight(top)
    session.position = {
      doc: resultView.state.doc.toString(),
      anchor: Math.min(block.from, resultView.state.doc.length),
      selection: { anchor: resultView.state.selection.main.anchor, head: resultView.state.selection.main.head },
      focused: parent.contains(document.activeElement),
    }
  }

  return {
    view,
    savePosition,
    getSelection() { return selection(split && view.a.hasFocus ? view.a : resultView) },
    getState() {
      const editor = split && view.a.hasFocus ? view.a : resultView
      const visible = editor.visibleRanges[0]
      return { kind: 'review', reviewId: session.id, mode, side: editor === view.a || mode === 'original' ? 'original' : 'result',
        content: editor.state.doc.toString(), selection: selection(editor),
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
