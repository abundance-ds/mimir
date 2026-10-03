import { singleDiffTargetsFile } from '../workspaceDiffProjection.js'
import { nextTick } from 'vue'
import { graphSource, saveGraphSource } from '../../services/businessGraph.js'
import { graphDocumentState, isGraphSourceCandidate } from '../../stores/graphDocuments.js'
import { reviewStatus } from '../reviewSession.js'
import { reviewContent, syncReviewComments } from '../reviewComments.js'
import { stripCommentTags } from '../../services/comments/parser.js'
import { persistReview, reviewKey, scheduleReviewSave } from '../reviewPersistence.js'

const SOURCE_REQUIRED = 'Open Source before applying a Markdown review to this Graph entry.'

export function proposalIdsFromReviewMeta(meta) {
  if (!meta) return []
  if (Array.isArray(meta.ids)) return meta.ids.filter(Boolean)
  if (meta.id) return [meta.id]
  return []
}

export function useDiffReview({
  diffStore,
  fileManager,
  currentFile,
  reviewTabActive,
  inlineAIState,
  restoreConfirmMeta,
  diffViewRef,
  batchDiffViewRef,
  scheduleContentSync,
  flushEditorContent,
}) {
  function resolveSingleDiffTarget() {
    const files = fileManager.openFiles || []
    if (diffStore.fileId != null) {
      return files.find(file => file.id === diffStore.fileId) || null
    }
    if (diffStore.filePath) {
      return files.find(file => file.path === diffStore.filePath) || null
    }
    return currentFile.value && !currentFile.value.path ? currentFile.value : null
  }

  function requireActiveSingleDiffTarget() {
    const target = resolveSingleDiffTarget()
    if (target && singleDiffTargetsFile(diffStore, currentFile.value)) {
      if (target.kind === 'graph') {
        diffStore.setReviewError?.(SOURCE_REQUIRED)
        return { ok: false, error: SOURCE_REQUIRED }
      }
      return { ok: true, target }
    }
    const error = 'This review belongs to another file. Open its tab before you respond.'
    diffStore.setReviewError?.(error)
    return { ok: false, error }
  }

  function applyDiffResult(content, target = resolveSingleDiffTarget()) {
    if (!target || !(fileManager.openFiles || []).includes(target)) {
      const error = 'The review target is no longer open. Reopen the proposal before you respond.'
      diffStore.setReviewError?.(error)
      return { ok: false, error }
    }
    if (target.kind === 'graph') {
      diffStore.setReviewError?.(SOURCE_REQUIRED)
      return { ok: false, error: SOURCE_REQUIRED }
    }
    diffStore.deactivate()
    if (content != null) {
      fileManager.updateContent(content, target)
      if (currentFile.value === target) scheduleContentSync()
    }
    return { ok: true }
  }

  async function respondToDiffReview(decision) {
    const ids = decision.ids.filter(id => !decision.reported.has(id))
    if (ids.length === 0) return { ok: true }
    const { status, sessionId } = decision
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const results = await Promise.allSettled(
        ids.map(async id => {
          await invoke('proposal_respond', {
            result: { id, sessionId, status, detail: status === 'applied' ? 'User accepted the change' : 'User rejected the change' },
          })
          decision.reported.add(id)
        }),
      )
      const failure = results.find(result => result.status === 'rejected')
      if (failure) {
        const error = `The edit decision could not be reported: ${failure.reason?.message || failure.reason}`
        return { ok: false, error }
      }
      return { ok: true }
    } catch (cause) {
      const error = `The edit decision could not be reported: ${cause?.message || cause}`
      return { ok: false, error }
    }
  }

  async function finishBatchReview() {
    // Captured references, mutated directly: a proposals-changed broadcast
    // arriving between awaits can deactivate the store and empty its file
    // list, and a path re-lookup would then silently skip the remaining
    // proposal_respond calls, leaving those proposals pending forever.
    const allFiles = [...diffStore.files]
    const sessionId = diffStore.reviewMeta?.sessionId || ''
    const { invoke } = await import('@tauri-apps/api/core')
    let activeEditorChanged = false

    for (const file of allFiles) {
      if (file.status === 'pending' || file.applied) continue
      if (file.status === 'rejected' && file.modified === file.original) continue
      try {
        const openFile = fileManager.openFiles?.find(candidate => candidate.path === file.path)
        if (openFile) {
          syncReviewComments(file.review, openFile.content)
          file.modified = reviewContent(file.review)
        }
        const graph = openFile?.graph ? null : await graphSource(file.path)
        if (file.graphSourceRevision != null && !openFile?.graph && !graph) {
          throw new Error('This Graph source is unavailable. Reopen the proposal after its scope is mounted.')
        }
        if (openFile && graph) {
          if (openFile.dirty || openFile.content !== graph.content) {
            throw new Error('This Graph source changed. Save or reload its tab before applying the proposal.')
          }
          openFile.graph = graphDocumentState(graph)
        }
        const graphFile = openFile?.graph ? openFile : null
        if (graphFile) {
          if (graphFile.graph.unavailable) throw new Error('This Graph source is unavailable. Its draft is kept.')
          if (graphFile.kind === 'graph') {
            if (graphFile.dirty || !await fileManager.setGraphView(graphFile, 'source')) throw new Error(SOURCE_REQUIRED)
          }
          await fileManager.waitForFile?.(graphFile)
          if (!fileManager.openFiles.includes(graphFile) || graphFile.path !== file.path || graphFile.kind === 'graph') {
            throw new Error('This Graph tab changed. Open the proposal again.')
          }
          if (stripCommentTags(graphFile.content) !== stripCommentTags(file.original) && graphFile.content !== file.modified) {
            throw new Error('This file changed after the review was created. Refresh the proposal before applying it.')
          }
          if (graphFile.content !== file.modified) {
            fileManager.updateContent(file.modified, graphFile)
          }
          if (graphFile.dirty) await fileManager.save(graphFile)
          // save() owns revision and dirty state, including edits made while
          // its write was pending. Never mark this tab clean here.
          file.applied = true
          file.error = null
          continue
        }
        const active = currentFile.value?.path === file.path
        if (active) {
          if (stripCommentTags(currentFile.value.content) !== stripCommentTags(file.original) && currentFile.value.content !== file.modified) {
            throw new Error('The active document changed after this review was created. Reopen the proposal against the latest text.')
          }
          if (currentFile.value.content !== file.modified) {
            fileManager.updateContent(file.modified, currentFile.value)
            activeEditorChanged = true
          }
        } else {
          const currentContent = graph?.content ?? (openFile
            ? openFile.content
            : (await invoke('read_text_file', { path: file.path })).content)
          if (stripCommentTags(currentContent) !== stripCommentTags(file.original) && currentContent !== file.modified) {
            throw new Error('This file changed after the review was created. Refresh the proposal before applying it.')
          }
          syncReviewComments(file.review, currentContent)
          file.modified = reviewContent(file.review)
          if (openFile) {
            if (currentContent !== file.modified) fileManager.updateContent(file.modified, openFile)
            if (openFile.dirty) await fileManager.save(openFile)
          } else if (currentContent !== file.modified) {
            if (graph) await saveGraphSource({ path: file.path, content: file.modified, expectedRevision: file.graphSourceRevision ?? graph.sourceRevision })
            else await invoke('write_text_file', { path: file.path, content: file.modified })
          }
        }
        file.applied = true
        file.error = null
      } catch (error) {
        file.status = 'pending'
        file.error = String(error?.message || error || 'Could not apply this file.')
      }
    }
    if (activeEditorChanged) scheduleContentSync()

    for (const file of allFiles) {
      if (file.status === 'pending' || file.lifecycleResolved) continue
      if (file.status === 'accepted' && !file.applied) continue
      if (!file.proposalId) {
        file.lifecycleResolved = true
        file.error = null
        continue
      }
      const status = reviewStatus(file.review) === 'accepted' ? 'applied' : 'rejected'
      try {
        await invoke('proposal_respond', {
          result: {
            id: file.proposalId,
            sessionId,
            status,
            detail: `User ${status} the change`,
          },
        })
        file.lifecycleResolved = true
        file.review.completed = true
        await persistReview(file.review)
        const openFile = fileManager.openFiles?.find(candidate => candidate.path === file.path)
        if (openFile?.reviewSession === file.review) openFile.reviewSession = null
        file.error = null
      } catch (error) {
        file.status = 'pending'
        file.error = `The file decision was saved, but its proposal status could not be updated: ${error?.message || error}`
      }
    }

    const pendingLeft = allFiles.filter(file => file.status === 'pending')
    if (pendingLeft.length > 0) {
      return {
        ok: false,
        failures: pendingLeft.map(file => ({ path: file.path, error: file.error })),
      }
    }

    if (diffStore.isBatch && allFiles.every(file => diffStore.files.includes(file))) {
      diffStore.deactivate()
      reviewTabActive.value = false
    }
    return { ok: true }
  }

  async function onDiffAcceptAll() {
    if (diffStore.decision) return onDiffFinish()
    if (!diffStore.isBatch) {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
    }
    if (diffStore.reviewMeta?.type === 'history') restoreConfirmMeta.value = diffStore.reviewMeta
    else diffStore.decideRemainingChanges('accept')
    return { ok: true }
  }

  function onRestoreConfirm(action) {
    if (action === 'restore') {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
      applyDiffResult(diffStore.originalContent, targetResult.target)
    }
    restoreConfirmMeta.value = null
  }

  async function onDiffRejectAll() {
    if (diffStore.decision) return onDiffFinish()
    if (!diffStore.isBatch) {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
    }
    if (diffStore.reviewMeta?.type === 'history') diffStore.deactivate()
    else diffStore.decideRemainingChanges('reject')
    return { ok: true }
  }

  async function onDiffFinish() {
    if (diffStore.decision) {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
      return completeReview(targetResult.target, diffStore.decision.status, diffStore.decision.content)
    }
    if (!diffStore.canFinish) return { ok: false, error: 'Decide the remaining changes before finishing review.' }
    if (diffStore.isBatch) {
      diffStore.finishing = true
      diffStore.setReviewError('')
      const rows = diffStore.files
      try {
        for (const file of rows) {
          if (file.lifecycleResolved) continue
          file.modified = reviewContent(file.review)
          file.status = file.applied ? 'accepted' : reviewStatus(file.review)
        }
        const result = await finishBatchReview()
        if (!result.ok && diffStore.files === rows) {
          diffStore.setReviewError('Some files could not be applied. Check the file errors, then retry.')
        }
        return result
      } catch (error) {
        if (diffStore.files === rows) diffStore.setReviewError(error?.message || error)
        return { ok: false, error: String(error?.message || error) }
      } finally {
        // A newer review can arrive while the native operation is pending.
        if (diffStore.files === rows) diffStore.finishing = false
      }
    }
    const targetResult = requireActiveSingleDiffTarget()
    if (!targetResult.ok) return targetResult
    const session = diffStore.currentReview
    syncReviewComments(session, targetResult.target.content)
    try { await persistReview(session) } catch (error) {
      diffStore.setReviewError(error?.message || String(error))
      return { ok: false, error: diffStore.reviewError }
    }
    // Posting a discussion and accepting prose are separate Undo steps.
    // Keep the discussion on its original quotation before applying the text.
    if (stripCommentTags(targetResult.target.content) === session.references?.original) {
      const withDiscussions = reviewContent(session, session.references.original)
      if (withDiscussions !== targetResult.target.content && session.comments?.some(record => record.discussion || Object.keys(record.live).length)) {
        fileManager.updateContent(withDiscussions, targetResult.target)
        scheduleContentSync()
        await nextTick()
      }
    }
    if (diffStore.reviewMeta?.type === 'inline-ai') inlineAIState.value = null
    return completeReview(targetResult.target, reviewStatus(session) === 'rejected' ? 'rejected' : 'applied', reviewContent(session))
  }

  function completeReview(target, status, content) {
    let decision = target.reviewDecision
    if (decision && decision !== diffStore.decision) {
      return { ok: false, error: 'Finish the previous review decision before reviewing another change.' }
    }
    if (decision && decision.status !== status) {
      return { ok: false, error: 'This decision is already applied. Retry its status update.' }
    }
    if (!decision) {
      const original = diffStore.originalContent
      if (status === 'applied' && stripCommentTags(target.content) !== stripCommentTags(original) && target.content !== content) {
        const error = 'The document changed after this review was created. Reopen the proposal against the latest text.'
        diffStore.setReviewError(error)
        return { ok: false, error }
      }
      diffStore.decision = {
        targetId: target.id, original, content, status,
        reviewSession: diffStore.reviewSession,
        ids: proposalIdsFromReviewMeta(diffStore.reviewMeta),
        sessionId: diffStore.reviewMeta?.sessionId,
        reported: new Set(), pending: false, operation: null, error: '',
      }
      decision = diffStore.decision
      target.reviewDecision = decision
      target.reviewPending = true
      // Commit once, before any asynchronous report. A receipt can never write
      // text back into this document. Reject only dismisses the proposal.
      if ((status === 'applied' || stripCommentTags(target.content) === stripCommentTags(original)) && target.content !== content) {
        fileManager.updateContent(content, target)
        if (currentFile.value === target) scheduleContentSync()
      }
    }
    if (decision.operation) return decision.operation
    decision.pending = true
    decision.error = ''
    target.reviewPending = true
    decision.operation = (async () => {
      const lifecycle = await respondToDiffReview(decision)
      if (!lifecycle.ok) {
        decision.error = lifecycle.error
        if (diffStore.decision === decision) diffStore.setReviewError(lifecycle.error)
        return lifecycle
      }
      const remaining = (target.reviews || []).filter(review => !decision.ids.includes(review.proposalId))
      if (decision.reviewSession) {
        decision.reviewSession.completed = true
        try { await persistReview(decision.reviewSession) } catch (error) {
          decision.error = error?.message || String(error)
          if (diffStore.decision === decision) diffStore.setReviewError(decision.error)
          return { ok: false, error: decision.error }
        }
      }
      if (remaining.length) fileManager.setFileReviews(target, remaining)
      else fileManager.clearFileReviews(target)
      target.reviewDecision = null
      if (target.reviewSession === decision.reviewSession) target.reviewSession = null
      if (diffStore.decision === decision) diffStore.deactivate()
      return { ok: true }
    })().finally(() => {
      decision.pending = false
      decision.operation = null
      target.reviewPending = false
    })
    return decision.operation
  }

  function onDiffNavigateChunk(index) {
    diffViewRef.value?.scrollToChunk(index)
  }

  function onDiffNavigateFile(path) {
    batchDiffViewRef.value?.scrollToFile(path)
  }

  function activateDiffForCurrentFile(original, modified, opts) {
    const file = currentFile.value
    if (file?.kind === 'graph') throw new Error(SOURCE_REQUIRED)
    const path = file?.path || ''
    flushEditorContent({ bridge: 'flush' })
    diffStore.activate({
      original,
      modified,
      path,
      fileId: file?.id ?? null,
      review: opts?.review || null,
    })
    if (file && opts?.review?.type !== 'history') {
      file.reviewSession = diffStore.reviewSession
      file.reviewSession.key = reviewKey(file)
      file.reviewSession.proposalKey = proposalIdsFromReviewMeta(opts?.review).slice().sort().join('\n')
      if (opts?.review?.type !== 'history') scheduleReviewSave(file.reviewSession)
    }
  }

  async function activateBatchDiff(fileList, meta) {
    flushEditorContent({ bridge: 'flush' })
    const rows = await Promise.all(fileList.map(async file => {
      const open = fileManager.openFiles?.find(candidate => candidate.path === file.path)
      if (open?.graph) return { ...file, graphSourceRevision: open.graph.sourceRevision }
      const graph = isGraphSourceCandidate(file.path) ? await graphSource(file.path) : null
      return { ...file, graphSourceRevision: graph?.sourceRevision ?? null }
    }))
    diffStore.activateBatch({ fileList: rows, sessionId: meta?.sessionId })
    for (const row of diffStore.files) {
      const file = fileManager.openFiles?.find(candidate => candidate.path === row.path)
      if (file) file.reviewSession = row.review
    }
    reviewTabActive.value = true
  }

  return {
    onDiffAcceptAll,
    onDiffRejectAll,
    onDiffFinish,
    onDiffNavigateChunk,
    onDiffNavigateFile,
    onRestoreConfirm,
    activateDiffForCurrentFile,
    activateBatchDiff,
  }
}
