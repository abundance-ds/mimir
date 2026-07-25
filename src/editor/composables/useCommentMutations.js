import { escapeAttr, stripCommentTags } from '../../services/comments/parser.js'
import { getCommentsFromState, commentMutation } from '../codemirror/comments.js'
import { useCommentsStore } from '../../stores/comments.js'

export function useCommentMutations(editorSurfaceRef) {
  const commentManager = useCommentsStore()

  function ok(extra = {}) {
    return { ok: true, ...extra }
  }

  function fail(error) {
    return { ok: false, error }
  }

  function getView() {
    const view = editorSurfaceRef.value?.getView()
    return view || null
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function addReply(commentId, text, author = 'user') {
    const view = getView()
    if (!view) return fail('No active editor view.')
    if (!text?.trim()) return fail('Reply is empty.')
    const doc = view.state.doc.toString()
    const re = new RegExp(`(<comment\\s[^>]*id="${escapeRegExp(commentId)}"[^>]*>[\\s\\S]*?)(</comment>)`)
    const m = re.exec(doc)
    if (!m) return fail('Comment not found.')
    const replyId = Math.random().toString(36).slice(2, 5)
    const ts = new Date().toISOString()
    const replyTag = `<reply id="${escapeAttr(replyId)}" author="${escapeAttr(author)}" text="${escapeAttr(text)}" ts="${escapeAttr(ts)}"/>`
    const insertAt = m.index + m[1].length
    view.dispatch({ changes: { from: insertAt, insert: replyTag }, annotations: commentMutation.of(true) })
    return ok({ replyId })
  }

  function del(commentId) {
    const view = getView()
    if (!view) return fail('No active editor view.')
    const comments = getCommentsFromState(view.state)
    const c = comments.find(x => x.id === commentId)
    if (!c) return fail('Comment not found.')
    view.dispatch({ changes: { from: c.tagFrom, to: c.tagTo, insert: c.anchorText }, annotations: commentMutation.of(true) })
    if (commentManager.activeCommentId === commentId) commentManager.setActiveComment(null)
    return ok()
  }

  function updateText(commentId, newText) {
    const view = getView()
    if (!view) return fail('No active editor view.')
    const doc = view.state.doc.toString()
    const re = new RegExp(`(<comment\\s[^>]*id="${escapeRegExp(commentId)}"[^>]*?)\\stext="[^"]*"`)
    const m = re.exec(doc)
    if (!m) return fail('Comment not found.')
    const replaceFrom = m.index + m[1].length
    const replaceTo = m.index + m[0].length
    view.dispatch({ changes: { from: replaceFrom, to: replaceTo, insert: ` text="${escapeAttr(newText)}"` }, annotations: commentMutation.of(true) })
    return ok()
  }

  function setStatus(commentId, status) {
    const view = getView()
    if (!view) return fail('No active editor view.')
    if (!['active', 'resolved'].includes(status)) return fail('Invalid comment status.')
    const doc = view.state.doc.toString()
    const re = new RegExp(`<comment\\s[^>]*id="${escapeRegExp(commentId)}"[^>]*>`)
    const match = re.exec(doc)
    if (!match) return fail('Comment not found.')

    const currentTag = match[0]
    const nextTag = /\sstatus="[^"]*"/.test(currentTag)
      ? currentTag.replace(/\sstatus="[^"]*"/, ` status="${status}"`)
      : currentTag.replace(/>$/, ` status="${status}">`)
    view.dispatch({
      changes: {
        from: match.index,
        to: match.index + currentTag.length,
        insert: nextTag,
      },
      annotations: commentMutation.of(true),
    })
    if (status === 'resolved' && commentManager.activeCommentId === commentId) {
      commentManager.setActiveComment(null)
    }
    return ok({ status })
  }

  function updateReply(commentId, replyId, newText) {
    const view = getView()
    if (!view) return fail('No active editor view.')
    const doc = view.state.doc.toString()
    const re = new RegExp(`(<reply\\s[^/]*?id="${escapeRegExp(replyId)}"[^/]*?)\\stext="[^"]*"`)
    const m = re.exec(doc)
    if (!m) return fail('Reply not found.')
    const replaceFrom = m.index + m[1].length
    const replaceTo = m.index + m[0].length
    view.dispatch({ changes: { from: replaceFrom, to: replaceTo, insert: ` text="${escapeAttr(newText)}"` }, annotations: commentMutation.of(true) })
    return ok()
  }

  function deleteReply(commentId, replyId) {
    const view = getView()
    if (!view) return fail('No active editor view.')
    const doc = view.state.doc.toString()
    const re = new RegExp(`<reply\\s[^/]*?id="${escapeRegExp(replyId)}"[^/]*?/>`)
    const m = re.exec(doc)
    if (!m) return fail('Reply not found.')
    view.dispatch({ changes: { from: m.index, to: m.index + m[0].length, insert: '' }, annotations: commentMutation.of(true) })
    return ok()
  }

  function clearAll() {
    const view = getView()
    if (!view) return fail('No active editor view.')
    const doc = view.state.doc.toString()
    const clean = stripCommentTags(doc)
    if (clean !== doc) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: clean }, annotations: commentMutation.of(true) })
      return ok({ changed: true })
    }
    return ok({ changed: false })
  }

  return {
    addReply,
    delete: del,
    resolve: id => setStatus(id, 'resolved'),
    reopen: id => setStatus(id, 'active'),
    updateText,
    updateReply,
    deleteReply,
    clearAll,
  }
}
