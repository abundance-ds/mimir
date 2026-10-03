import { nextTick } from 'vue'
import { fallbackOpenEntry, isSvgPath } from '../../shared/utils/filePreview.js'
import { readFile } from '../../services/fileSystem.js'
import { resolveScratchpad } from '../../services/scratchpad.js'
import { inspectWorkspaceEntry } from '../../services/workspaceFileOperations.js'
import { basename } from '../../shared/utils/path.js'
import { getCommentsFromState } from '../codemirror/comments.js'
import { computeDiffFromReview } from './useProposalBridge.js'
import { cloneGraphDocument } from '../../stores/graphDocuments.js'
import { createNavigationGuard } from '../navigationGuard.js'
import { useDocumentTools } from './useDocumentTools.js'

export function useEditorCommandApi({
  fileManager,
  currentFile,
  openFiles,
  visibleOpenFiles = openFiles,
  activeFileIndex,
  activeVisibleFileIndex = activeFileIndex,
  editorTabs,
  editorSurfaceRef,
  editorShellRef,
  commentMutations,
  flushEditorContent,
  emitNavigate,
  restoreEditorFocus,
  activateDiff,
  saveCurrentFile,
  dismissEditorSurface,
  closeEditorTab,
  openSettings,
  commentPrompt,
  onDocumentChanged,
  getReviewState = () => null,
  navigation = createNavigationGuard(),
}) {
  const documents = useDocumentTools({ fileManager, currentFile, onChanged: onDocumentChanged, getReviewState })
  async function mimirOpen(path, options = {}) {
    return openDocument(path, options, navigation.begin())
  }

  async function openDocument(path, { preview = false, entry = null, focus = true, source = false }, isCurrent) {
    try {
      if (!path) throw new Error('path is required')
      if (path.endsWith('/scratchpad.md') && window.__TAURI_INTERNALS__) {
        const canonical = await resolveScratchpad(path)
        if (canonical) { path = canonical; preview = false; entry = { openBehavior: 'text', scratchpad: true } }
      }
      if (!isCurrent()) return null
      flushEditorContent({ bridge: 'flush' })
      let inspected = entry?.openBehavior ? entry : null
      if (!inspected) {
        try {
          inspected = await inspectWorkspaceEntry(path)
        } catch {
          // Trusted editor routes such as Settings definitions can be outside
          // the active workspace. Their fallback remains text-oriented without
          // weakening the workspace-scoped Files inspector.
        }
      }
      if (!isCurrent()) return null
      inspected ||= fallbackOpenEntry(path)
      const kind = inspected.openBehavior || (
        inspected.textReadable === false ? 'external' : 'text'
      )
      const readVersion = fileManager.documentReadVersion?.()
      const content = kind === 'text' ? await readFile(path) : ''
      if (!isCurrent()) return null
      const file = await fileManager.openFile(path, content, {
        kind,
        preview,
        meta: inspected,
        isCurrent,
        readVersion,
      })
      if (!file || !isCurrent()) return null
      if (source && file?.graph) await openSource(file)
      await nextTick()
      if (!isCurrent()) return null
      if (source && currentFile.value !== file) throw new Error('The active document changed. Open Source again.')
      // Background reveals (including Scratchpad updates) retain the reading position.
      if (focus && file?.kind !== 'graph' && kind === 'text') editorSurfaceRef.value?.scrollToPos(0)
      if (focus) emitNavigate({ path })
      if (!isCurrent()) return null
      if (focus) restoreEditorFocus()
      return mimirActive()
    } catch (error) {
      if (!isCurrent()) return null
      throw error
    }
  }

  function requireSource() {
    if (currentFile.value?.kind === 'graph') throw new Error('Open Source before editing the Markdown text.')
  }

  async function openSource(file) {
    if (file.kind !== 'graph') return
    if (!await fileManager.setGraphView(file, 'source')) {
      throw new Error('Save the Graph draft before opening Source.')
    }
    if (currentFile.value !== file) throw new Error('The active document changed. Open Source again.')
  }

  function mimirActive({ includeContent = false } = {}) {
    flushEditorContent({ bridge: 'flush' })
    const review = getReviewState()
    if (review?.kind === 'batch-review') return null
    if (review?.kind === 'history') {
      const content = review.historyContent ?? review.content
      if (typeof content !== 'string') return null
      return { documentId: `history:${review.reviewId}`, path: review.path || null, name: basename(review.path) || 'History',
        kind: 'text', readOnly: true, contentSource: 'history', dirty: false, cursor: null,
        ...(includeContent ? { content } : {}) }
    }
    const file = currentFile.value
    if (!file) return null
    const details = file.kind === 'graph'
    const reviewing = Boolean(review)
    const content = file.content || ''
    return {
      path: file.path || null,
      name: editorTabs.value[activeVisibleFileIndex.value]?.name || basename(file.path),
      dirty: Boolean(file.dirty),
      kind: file.kind || 'text',
      preview: Boolean(file.preview),
      index: activeVisibleFileIndex.value,
      cursor: details || reviewing ? null : editorSurfaceRef.value?.getCursor?.() || null,
      content: includeContent ? content : undefined,
      ...(details && includeContent ? {
        contentSource: 'saved',
        graphDraft: cloneGraphDocument(file.graph?.draft || {}),
      } : {}),
    }
  }

  function mimirTabs() {
    flushEditorContent({ bridge: 'flush' })
    return visibleOpenFiles.value.map((file, index) => ({
      index,
      path: file.path || null,
      name: editorTabs.value[index]?.name || basename(file.path),
      dirty: Boolean(file.dirty),
      active: index === activeVisibleFileIndex.value,
    }))
  }

  function mimirState({ includeContent = false } = {}) {
    const active = mimirActive({ includeContent })
    const tabs = mimirTabs()
    const selection = mimirSelection()
    const review = getReviewState()
    const view = review || currentFile.value?.kind === 'graph' ? null : editorSurfaceRef.value?.getView?.()
    const comments = review?.comments || (view ? getCommentsFromState(view.state) : [])
    const visible = view?.visibleRanges?.[0]
    return {
      active,
      tabs,
      selection,
      ...(review ? { view: { kind: review.kind, reviewId: review.reviewId, mode: review.mode, side: review.side,
        ...(review.readOnly ? { readOnly: true } : {}), ...(review.path ? { path: review.path } : {}),
        ...(review.documents ? { documents: review.documents } : {}),
        selection, visibleRange: review.visibleRange, ...(includeContent ? { content: review.content } : {}) } } : {}),
      visibleRange: review ? review.visibleRange : visible
        ? {
            from: visible.from,
            to: visible.to,
            fromLine: view.state.doc.lineAt(visible.from).number,
            toLine: view.state.doc.lineAt(visible.to).number,
          }
        : null,
      comments: {
        total: comments.length,
        unresolved: comments.filter(comment => comment.status !== 'resolved').length,
        resolved: comments.filter(comment => comment.status === 'resolved').length,
      },
    }
  }

  function mimirSelection() {
    const review = getReviewState()
    if (review) {
      const selection = review.selection
      return selection ? { from: selection.from, to: selection.to, text: selection.text, contentSource: 'review', side: review.side } : null
    }
    if (currentFile.value?.kind === 'graph') return null
    return editorSurfaceRef.value?.getSelection?.() || null
  }

  function mimirComments() {
    const view = currentFile.value?.kind === 'graph' ? null : editorSurfaceRef.value?.getView()
    const comments = view ? getCommentsFromState(view.state) : []
    return {
      ...mimirActive(),
      comments: comments.map((comment) => {
        const line = view
          ? view.state.doc.lineAt(Math.min(comment.contentFrom, view.state.doc.length))
          : null
        return {
          id: comment.id,
          author: comment.author || 'user',
          text: comment.text || '',
          status: comment.status || 'active',
          created: comment.created || null,
          anchorText: comment.anchorText || '',
          line: line?.number || null,
          column: line ? comment.contentFrom - line.from + 1 : null,
          replies: (comment.replies || []).map(reply => ({
            id: reply.id || null,
            author: reply.author || 'agent',
            text: reply.text || '',
            timestamp: reply.ts || null,
          })),
          prompt: commentPrompt(comment.id),
          actions: [
            { id: 'reply', label: 'Reply', requiresText: true },
            comment.status === 'resolved'
              ? { id: 'reopen', label: 'Reopen', requiresText: false }
              : { id: 'resolve', label: 'Resolve', requiresText: false },
            { id: 'delete', label: 'Delete', requiresText: false },
          ],
        }
      }),
      prompt: view ? commentPrompt(comments[0]?.id) : '',
    }
  }

  function mimirCommentAction(action, commentId, text = '') {
    requireSource()
    const handlers = {
      reply: id => commentMutations.addReply(id, text),
      resolve: commentMutations.resolve,
      reopen: commentMutations.reopen,
      delete: commentMutations.delete,
    }
    const handler = handlers[action]
    if (!handler) return { ok: false, error: `Unknown comment action: ${action}` }
    return handler(commentId)
  }

  function mimirReplaceSelection(text = '') {
    requireSource()
    const selection = editorSurfaceRef.value?.getSelection?.()
    if (!selection) throw new Error('No active selection')
    editorSurfaceRef.value?.replaceRange(selection.from, selection.to, text)
    return {
      from: selection.from,
      to: selection.from + text.length,
      replaced: selection.to - selection.from,
    }
  }

  function mimirSetContent(content = '') {
    requireSource()
    if (!currentFile.value) throw new Error('No document is open.')
    const view = editorSurfaceRef.value?.getView?.()
    if (!view) throw new Error('The editor is not ready.')
    editorSurfaceRef.value.replaceRange(0, view.state.doc.length, content)
    return mimirActive()
  }

  function mimirReviewProposal(proposal) {
    requireSource()
    if (!proposal?.id || !proposal?.targetText) {
      throw new Error('A review proposal needs an id and targetText.')
    }
    const file = currentFile.value
    if (!file) throw new Error('No document is open.')
    const targetPath = proposal.absolutePath || proposal.path
    if (targetPath && targetPath !== file.path) {
      throw new Error('This proposal belongs to another document. Open its Source tab before reviewing it.')
    }
    flushEditorContent({ bridge: 'flush' })
    const review = {
      proposalId: proposal.id,
      sessionId: proposal.sessionId || proposal.threadId || 'mcp',
      targetText: proposal.targetText,
      replacement: proposal.replacement || '',
      path: proposal.absolutePath || proposal.path || file.path || '',
      type: proposal.type || 'edit',
      original: proposal.original,
      modified: proposal.modified,
    }
    const diff = computeDiffFromReview(review, file.content || '')
    if (!diff) {
      // Do not stash: the caller receives this error before proposal_create
      // runs, so no native proposal exists to back a stashed review.
      throw new Error('The proposal target is no longer present in the active document.')
    }
    fileManager.setFileReviews(file, [...(file.reviews || []).filter(item => item.proposalId !== review.proposalId), review])
    activateDiff(diff.original, diff.modified, {
      review: {
        ids: [review.proposalId],
        sessionId: review.sessionId,
        path: review.path,
      },
    })
    return { proposalId: review.proposalId, status: 'pending_review' }
  }

  async function mimirReveal({ path, line, column, offset, preview, entry, focus = true } = {}) {
    const isCurrent = navigation.begin()
    if (path) {
      const index = openFiles.value.findIndex(file => file.path === path)
      if (typeof preview === 'boolean') {
        if (!await openDocument(path, { preview, entry, focus }, isCurrent)) return null
      } else if (index >= 0) {
        flushEditorContent({ bridge: 'flush' })
        fileManager.setActiveTab(index)
        if (focus) emitNavigate({ path })
      } else {
        if (!await openDocument(path, { focus }, isCurrent)) return null
      }
    }
    if (!isCurrent()) return null
    const file = currentFile.value
    if (file?.graph && [line, column, offset].some(Number.isFinite)) await openSource(file)
    if (!isCurrent()) return null
    if (file?.kind === 'text' && isSvgPath(file.path)
      && [line, column, offset].some(Number.isFinite)) {
      file.previewView = { ...file.previewView, sourceMode: true }
    }
    await nextTick()
    if (!isCurrent()) return null
    if (file && currentFile.value !== file) throw new Error('The active document changed. Reveal the location again.')
    if (file?.kind === 'graph') {
      if (focus) restoreEditorFocus()
      return mimirActive()
    }
    const view = editorSurfaceRef.value?.getView?.()
    let position = Number.isFinite(offset) ? offset : 0
    if (view && Number.isFinite(line) && line > 0) {
      const documentLine = view.state.doc.line(Math.min(line, view.state.doc.lines))
      position = documentLine.from
      if (Number.isFinite(column) && column > 0) {
        position = Math.min(documentLine.to, documentLine.from + column - 1)
      }
    }
    editorSurfaceRef.value?.scrollToPos(position, { select: [line, column, offset].some(Number.isFinite) })
    if (focus) restoreEditorFocus()
    return mimirActive()
  }

  async function mimirSave() {
    flushEditorContent({ bridge: 'flush' })
    const saved = await saveCurrentFile({ source: 'mimir' })
    return { saved, active: mimirActive() }
  }

  function mimirOwnsFocus() {
    return Boolean(editorShellRef.value?.contains(document.activeElement))
  }

  function mimirCycleTab(direction = 1) {
    const length = visibleOpenFiles.value.length
    if (length < 2) return false
    navigation.cancel()
    const next = (activeVisibleFileIndex.value + direction + length) % length
    fileManager.setActiveVisibleTab(next)
    return true
  }

  async function mimirCloseActiveTab() {
    if (await dismissEditorSurface()) return true
    return closeEditorTab(activeVisibleFileIndex.value)
  }

  function mimirOpenSettings(section = 'appearance') {
    openSettings(section)
  }

  return {
    mimirDocumentState: documents.state,
    mimirDocumentComments: documents.comments,
    mimirDocumentComment: documents.mutate,
    mimirActive,
    mimirCloseActiveTab,
    mimirCommentAction,
    mimirComments,
    mimirCycleTab,
    mimirOpen,
    mimirOpenSettings,
    mimirOwnsFocus,
    mimirReplaceSelection,
    mimirReveal,
    mimirReviewProposal,
    mimirSave,
    mimirSelection,
    mimirSetContent,
    mimirState,
    mimirTabs,
  }
}
