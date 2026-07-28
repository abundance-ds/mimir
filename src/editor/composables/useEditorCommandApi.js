import { nextTick } from 'vue'
import { readFile } from '../../services/fileSystem.js'
import { inspectWorkspaceEntry } from '../../services/workspaceFileOperations.js'
import { basename } from '../../shared/utils/path.js'
import { getCommentsFromState } from '../codemirror/comments.js'
import { computeDiffFromReview } from './useProposalBridge.js'

export function useEditorCommandApi({
  fileManager,
  currentFile,
  openFiles,
  activeFileIndex,
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
}) {
  async function mimirOpen(path, { preview = false, entry = null } = {}) {
    if (!path) throw new Error('path is required')
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
    inspected ||= fallbackOpenEntry(path)
    const kind = inspected.openBehavior || (
      inspected.textReadable === false ? 'external' : 'text'
    )
    const content = kind === 'text' ? await readFile(path) : ''
    await fileManager.openFile(path, content, {
      kind,
      preview,
      meta: inspected,
    })
    await nextTick()
    if (kind === 'text') editorSurfaceRef.value?.scrollToPos(0)
    emitNavigate({ path })
    if (kind === 'text') restoreEditorFocus()
    return mimirActive()
  }

  function mimirActive({ includeContent = false } = {}) {
    flushEditorContent({ bridge: 'flush' })
    const file = currentFile.value
    if (!file) return null
    const content = editorSurfaceRef.value?.getContent?.() ?? file.content ?? ''
    return {
      path: file.path || null,
      name: editorTabs.value[activeFileIndex.value]?.name || basename(file.path),
      dirty: Boolean(file.dirty),
      kind: file.kind || 'text',
      preview: Boolean(file.preview),
      index: activeFileIndex.value,
      cursor: editorSurfaceRef.value?.getCursor?.() || null,
      content: includeContent ? content : undefined,
    }
  }

  function mimirTabs() {
    flushEditorContent({ bridge: 'flush' })
    return openFiles.value.map((file, index) => ({
      index,
      path: file.path || null,
      name: editorTabs.value[index]?.name || basename(file.path),
      dirty: Boolean(file.dirty),
      active: index === activeFileIndex.value,
    }))
  }

  function mimirState({ includeContent = false } = {}) {
    const active = mimirActive({ includeContent })
    const tabs = mimirTabs()
    const selection = mimirSelection()
    const view = editorSurfaceRef.value?.getView?.()
    const comments = view ? getCommentsFromState(view.state) : []
    const visible = view?.visibleRanges?.[0]
    return {
      active,
      tabs,
      selection,
      visibleRange: visible
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
    return editorSurfaceRef.value?.getSelection?.() || null
  }

  function mimirComments() {
    const view = editorSurfaceRef.value?.getView()
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
      prompt: commentPrompt(comments[0]?.id),
    }
  }

  function mimirCommentAction(action, commentId, text = '') {
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
    if (!currentFile.value) throw new Error('No document is open.')
    const current = editorSurfaceRef.value?.getContent?.() || ''
    editorSurfaceRef.value?.replaceRange(0, current.length, content)
    return mimirActive()
  }

  function mimirReviewProposal(proposal) {
    if (!proposal?.id || !proposal?.targetText) {
      throw new Error('A review proposal needs an id and targetText.')
    }
    const file = currentFile.value
    if (!file) throw new Error('No document is open.')
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
    fileManager.setFileReviews(file, [review])
    const diff = computeDiffFromReview(review, file.content || '')
    if (!diff) {
      throw new Error('The proposal target is no longer present in the active document.')
    }
    activateDiff(diff.original, diff.modified, {
      review: {
        ids: [review.proposalId],
        sessionId: review.sessionId,
        path: review.path,
      },
    })
    return { proposalId: review.proposalId, status: 'pending_review' }
  }

  async function mimirReveal({ path, line, offset } = {}) {
    if (path) {
      const index = openFiles.value.findIndex(file => file.path === path)
      if (index >= 0) {
        flushEditorContent({ bridge: 'flush' })
        fileManager.setActiveTab(index)
        emitNavigate({ path })
      } else {
        await mimirOpen(path)
      }
    }
    await nextTick()
    const view = editorSurfaceRef.value?.getView?.()
    let position = Number.isFinite(offset) ? offset : 0
    if (view && Number.isFinite(line) && line > 0) {
      position = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
    }
    editorSurfaceRef.value?.scrollToPos(position)
    restoreEditorFocus()
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
    const length = openFiles.value.length
    if (length < 2) return false
    const next = (activeFileIndex.value + direction + length) % length
    fileManager.setActiveTab(next)
    return true
  }

  async function mimirCloseActiveTab() {
    if (await dismissEditorSurface()) return true
    return closeEditorTab(activeFileIndex.value)
  }

  function mimirOpenSettings(section = 'appearance') {
    openSettings(section)
  }

  return {
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

function fallbackOpenEntry(path) {
  const name = basename(path)
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const openBehavior = extension === 'pdf'
    ? 'pdf'
    : FALLBACK_EXTERNAL_EXTENSIONS.has(extension) ? 'external' : 'text'
  return {
    path,
    name,
    isDirectory: false,
    textReadable: openBehavior === 'text',
    openBehavior,
  }
}

const FALLBACK_EXTERNAL_EXTENSIONS = new Set([
  '7z', 'avi', 'bmp', 'db', 'dll', 'dylib', 'eot', 'exe', 'gif', 'gz', 'ico',
  'jar', 'jpeg', 'jpg', 'mkv', 'mov', 'mp3', 'mp4', 'otf', 'png', 'rar', 'so',
  'sqlite', 'sqlite3', 'tar', 'tiff', 'ttf', 'wav', 'wasm', 'webp', 'woff',
  'woff2', 'zip',
])
