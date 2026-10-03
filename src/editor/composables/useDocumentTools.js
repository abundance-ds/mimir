import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { graphSource, saveGraphSource } from '../../services/businessGraph.js'
import { resolveScratchpad, saveScratchpad } from '../../services/scratchpad.js'
import { documentComments, mutateComment } from '../../services/comments/mutations.js'
import { cloneGraphDocument, isGraphSourceCandidate } from '../../stores/graphDocuments.js'
import { reviewComments, reviewContent, mutateReviewComment, syncReviewComments } from '../reviewComments.js'
import { loadReview, persistReview, reviewKey } from '../reviewPersistence.js'
import { stripCommentTags } from '../../services/comments/parser.js'

function conflict() {
  return Object.assign(new Error('Document conflict: the document changed. Read it again.'), { code: 'handler', data: { reason: 'document_conflict' } })
}

function checkSignal(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Tool call was cancelled.'), { code: 'cancelled' })
}

async function revision(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify([snapshot.documentId, snapshot.path, snapshot.content, snapshot.graphDraft, snapshot.reviewContent]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

// FileStore owns all open documents, including tabs hidden by workspace changes.
// A tool captures that owner once. Selection is never used as a write target.
export function useDocumentTools({ fileManager, currentFile, onChanged = () => {}, getReviewState = () => null }) {
  const files = () => fileManager.openFiles
  const openSet = () => JSON.stringify(files().map(file => [file.id, file.path]))

  function captureFile(file) {
    if (!['text', 'graph'].includes(file.kind || 'text')) throw new Error('This document is not text.')
    const review = file.reviewSession && !file.reviewSession.completed && file.reviewSession.meta?.type !== 'history' ? file.reviewSession : null
    if (review) syncReviewComments(review, file.content || '')
    return {
      file, documentId: `document:${file.id}`, path: file.path || null,
      name: file.path?.split('/').pop() || 'Untitled', kind: file.kind || 'text',
      content: file.content || '', dirty: Boolean(file.dirty),
      contentSource: file.kind === 'graph' ? 'saved' : 'buffer',
      ...(file.kind === 'graph' ? { graphDraft: cloneGraphDocument(file.graph?.draft || {}) } : {}),
      graphVersion: file.graph?.version,
      ...(review ? { review, reviewContent: reviewContent(review), reviewRevision: review.revision, commentRevision: review.commentRevision } : {}),
    }
  }

  async function capture(target = '@editor', signal, retries = 2) {
    checkSignal(signal)
    if (target === '@editor') {
      const view = getReviewState()
      if (view?.kind === 'batch-review') throw new Error('Specify a file path for a batch review.')
      if (view?.kind === 'history' && typeof (view.historyContent ?? view.content) !== 'string') throw new Error('History is still loading. Read it again when it is ready.')
      if (view?.kind === 'history') return {
        documentId: `history:${view.reviewId}`, path: view.path || null, name: view.path?.split('/').pop() || 'History',
        kind: 'text', content: view.historyContent ?? view.content ?? '', contentSource: 'history', readOnly: true, dirty: false,
      }
    }
    const file = target === '@editor' ? currentFile.value
      : files().find(file => file.path === target || `document:${file.id}` === target)
    if (file) {
      const captured = captureFile(file)
      if (!file.reviewSession && file.kind !== 'graph') {
        const saved = await loadReview(captured.path || reviewKey(file))
        checkSignal(signal)
        assertCurrent(captured)
        if (saved && !saved.completed) file.reviewSession = saved
        return captureFile(file)
      }
      return captured
    }
    if (target === '@editor' || target.startsWith('document:')) throw new Error('The document is no longer open.')
    const before = openSet()
    const disk = await invoke('document_file_read', { path: target, openPaths: files().map(file => file.path).filter(Boolean) })
    checkSignal(signal)
    if (before !== openSet()) {
      if (files().some(file => file.path === target || file.path === disk.path || disk.openPaths.includes(file.path))) throw conflict()
      if (retries > 0) return capture(target, signal, retries - 1)
      throw conflict()
    }
    const matches = files().filter(file => file.path === disk.path || disk.openPaths.includes(file.path))
    if (matches.length > 1) throw new Error('This file has more than one open document. Use its document ID.')
    if (matches.length) return captureFile(matches[0])
    const saved = await loadReview(disk.path)
    const review = saved && !saved.completed ? saved : null
    if (review) syncReviewComments(review, disk.content)
    return { documentId: disk.path, path: disk.path, name: disk.path.split('/').pop(), kind: 'text', content: disk.content, dirty: false, contentSource: 'saved', openSet: before,
      ...(review ? { review, reviewContent: reviewContent(review), reviewRevision: review.revision, commentRevision: review.commentRevision } : {}) }
  }

  async function describe(snapshot, includeContent = false) {
    return {
      documentId: snapshot.documentId, path: snapshot.path, name: snapshot.name,
      kind: snapshot.kind, revision: await revision(snapshot), dirty: snapshot.dirty,
      ...(snapshot.readOnly ? { readOnly: true } : {}),
      saved: snapshot.review ? !snapshot.review.saveError && snapshot.review.savedCommentRevision === snapshot.review.commentRevision : !snapshot.dirty, contentSource: snapshot.review ? 'review' : snapshot.contentSource,
      ...(includeContent ? { content: snapshot.reviewContent ?? snapshot.content } : {}),
      ...(snapshot.review ? { review: { id: snapshot.review.id, pendingChanges: snapshot.review.pending,
        ...(includeContent ? { original: snapshot.review.original } : {}) } } : {}),
      ...(snapshot.graphDraft ? { graphDraft: snapshot.graphDraft } : {}),
    }
  }

  async function state(target, includeContent = false, signal) {
    const snapshot = await capture(target, signal)
    const document = await describe(snapshot, includeContent)
    checkSignal(signal)
    return document
  }

  async function comments(target, signal) {
    const snapshot = await capture(target, signal)
    const result = { ...await describe(snapshot), comments: snapshot.review ? reviewComments(snapshot.review, snapshot.review.result, { includeRemoved: true }).map(comment => ({
      id: comment.id, author: comment.author, text: comment.text, status: comment.status, created: comment.created || null,
      anchorText: comment.anchorText || comment.quote, attachment: comment.detached || 'attached',
      ...(comment.change ? { change: comment.change, decision: comment.decision } : {}),
      replies: comment.replies.map(reply => ({ id: reply.id, author: reply.author, text: reply.text, timestamp: reply.ts || null })),
    })) : documentComments(snapshot.content) }
    checkSignal(signal)
    return result
  }

  function assertCurrent(snapshot) {
    if (snapshot.review && (snapshot.review.completed || snapshot.review.revision !== snapshot.reviewRevision
      || snapshot.review.commentRevision !== snapshot.commentRevision || reviewContent(snapshot.review) !== snapshot.reviewContent)) throw conflict()
    const file = snapshot.file
    if (file) {
      if (!files().includes(file) || file.path !== snapshot.path || file.content !== snapshot.content
        || file.kind !== snapshot.kind || file.graph?.version !== snapshot.graphVersion
        || (snapshot.review && file.reviewSession !== snapshot.review)) throw conflict()
    } else if (openSet() !== snapshot.openSet) throw conflict()
  }

  async function mutate(action, input, signal) {
    const snapshot = await capture(input.target || '@editor', signal)
    if (snapshot.readOnly) throw new Error('History is read only. Use the working file path to change its comments.')
    if (snapshot.kind === 'graph') throw new Error('Open Source before editing the Markdown text. The Graph draft is unchanged.')
    if (snapshot.file?.reviewPending || snapshot.review?.applying || (snapshot.file?.reviews?.length && !snapshot.review)) throw new Error('The review is being applied. Read the document again when it is complete.')
    if (input.expected_revision && input.expected_revision !== await revision(snapshot)) throw conflict()
    if (snapshot.review) {
      if (stripCommentTags(snapshot.content).replace(/\r\n?/g, '\n') !== snapshot.review.references.original) {
        throw new Error('The document text changed after this review began. Reject this review, then request a new proposal.')
      }
      if (!snapshot.file) {
        const latest = await invoke('document_file_read', { path: snapshot.path, openPaths: files().map(file => file.path).filter(Boolean) })
        if (latest.content !== snapshot.content || latest.path !== snapshot.path) throw conflict()
      }
      checkSignal(signal)
      assertCurrent(snapshot)
      const result = mutateReviewComment(snapshot.review, action, input)
      let saved = true
      try { saved = await persistReview(snapshot.review) } catch { saved = false }
      const next = { ...snapshot, reviewContent: reviewContent(snapshot.review) }
      return { ...result, ...await describe(next), saved,
        ...(saved ? {} : { saveError: snapshot.review.saveError }) }
    }
    const change = mutateComment(snapshot.content, action, input)
    checkSignal(signal)
    if (snapshot.file) {
      assertCurrent(snapshot)
      fileManager.updateContent(change.content, snapshot.file)
      onChanged(snapshot.file)
      return { ...change.result, ...await describe(captureFile(snapshot.file)) }
    }

    // Typed document writers retain their own revision and history contracts.
    let graph = null
    let scratchpad = null
    if (isGraphSourceCandidate(snapshot.path)) {
      graph = await graphSource(snapshot.path)
      if (!graph) throw new Error('This Graph source is not mounted. Open its workspace before changing it.')
      if (graph.content !== snapshot.content) throw conflict()
    } else if (snapshot.path.endsWith('/scratchpad.md')) {
      scratchpad = await resolveScratchpad(snapshot.path)
    }
    if (openSet() !== snapshot.openSet) {
      const latest = await capture(snapshot.path, signal)
      if (latest.file || latest.content !== snapshot.content || latest.path !== snapshot.path) throw conflict()
      snapshot.openSet = latest.openSet
    }
    await fileManager.writeClosedDocument(async () => {
      checkSignal(signal)
      assertCurrent(snapshot)
      if (graph) await saveGraphSource({ path: snapshot.path, content: change.content, expectedRevision: graph.sourceRevision })
      else if (scratchpad) await saveScratchpad(change.content, snapshot.content)
      else await invoke('document_file_write', { path: snapshot.path, content: change.content, expectedContent: snapshot.content })
    })
    // Notification failure must not turn a completed write into a failed call.
    try { await emit('mimir://file-updated', { path: snapshot.path, content: change.content }) } catch { /* The write is complete. */ }
    return { ...change.result, ...await describe({ ...snapshot, content: change.content }) }
  }

  return { state, comments, mutate }
}
