import { singleDiffTargetsFile } from '../workspaceDiffProjection.js'
import { nextTick } from 'vue'
import { graphSource, saveGraphSource } from '../../services/businessGraph.js'
import { graphDocumentState, isGraphSourceCandidate } from '../../stores/graphDocuments.js'
import { reviewStatus } from '../reviewSession.js'
import { reviewContent, syncReviewComments } from '../reviewComments.js'
import { stripCommentTags } from '../../services/comments/parser.js'
import { resolveScratchpad, saveScratchpad } from '../../services/scratchpad.js'
import { loadReview, persistReview, reviewKey, scheduleReviewSave } from '../reviewPersistence.js'

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
  persistDocuments = async () => {},
}) {
  const singleFinishes = new Map()
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
    const updateResult = (file, content) => {
      syncReviewComments(file.review, content)
      file.modified = reviewContent(file.review, file.status === 'rejected' ? stripCommentTags(content) : file.review.result)
    }
    const matchesReview = (file, content) => stripCommentTags(content) === stripCommentTags(file.original)
      || content === file.modified || (file.status === 'rejected' && stripCommentTags(content) === stripCommentTags(file.modified))

    for (const file of allFiles) {
      if (file.status === 'pending' || file.applied) continue
      if (file.status === 'rejected' && file.modified === file.original) continue
      try {
        const openFile = fileManager.openFiles?.find(candidate => candidate.path === file.path)
        if (openFile) updateResult(file, openFile.content)
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
          updateResult(file, graphFile.content)
          if (!matchesReview(file, graphFile.content)) {
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
          updateResult(file, currentFile.value.content)
          if (!matchesReview(file, currentFile.value.content)) {
            throw new Error('The active document changed after this review was created. Reject this review, then request a new proposal.')
          }
          if (currentFile.value.content !== file.modified) {
            fileManager.updateContent(file.modified, currentFile.value)
            activeEditorChanged = true
          }
        } else {
          const currentContent = graph?.content ?? (openFile
            ? openFile.content
            : (await invoke('read_text_file', { path: file.path })).content)
          updateResult(file, currentContent)
          if (!matchesReview(file, currentContent)) {
            throw new Error('This file changed after the review was created. Refresh the proposal before applying it.')
          }
          if (openFile) {
            if (currentContent !== file.modified) fileManager.updateContent(file.modified, openFile)
            if (openFile.dirty) await fileManager.save(openFile)
          } else if (currentContent !== file.modified) {
            if (graph) await saveGraphSource({ path: file.path, content: file.modified, expectedRevision: file.graphSourceRevision ?? graph.sourceRevision })
            else {
              const scratchpad = file.path.endsWith('/scratchpad.md') ? await resolveScratchpad(file.path) : null
              await fileManager.writeClosedDocument(async () => {
                if (fileManager.openFiles?.some(candidate => candidate.path === file.path)) throw new Error('This file was opened during review. Retry the decision.')
                if (scratchpad) await saveScratchpad(file.modified, currentContent)
                else await invoke('document_file_write', { path: file.path, content: file.modified, expectedContent: currentContent })
              })
            }
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
    await persistDocuments()

    for (const file of allFiles) {
      if (file.status === 'pending' || file.lifecycleResolved) continue
      if (file.status === 'accepted' && !file.applied) continue
      const status = reviewStatus(file.review) === 'accepted' ? 'applied' : 'rejected'
      try {
        if (file.proposalId && !file.reported) await invoke('proposal_respond', {
          result: {
            id: file.proposalId,
            sessionId,
            status,
            detail: `User ${status} the change`,
          },
        })
        file.reported = true
        file.review.completed = true
        await persistReview(file.review)
        file.lifecycleResolved = true
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
    const pending = singleFinishes.get(diffStore.currentReview?.id)
    if (pending) return pending
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
      for (const file of rows) file.review.applying = true
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
        for (const file of rows) file.review.applying = false
        // A newer review can arrive while the native operation is pending.
        if (diffStore.files === rows) diffStore.finishing = false
      }
    }
    const targetResult = requireActiveSingleDiffTarget()
    if (!targetResult.ok) return targetResult
    const session = diffStore.currentReview
    const target = targetResult.target
    const path = target.path
    const context = { session, original: session.original, meta: diffStore.reviewMeta }
    diffStore.finishing = true
    session.applying = true
    target.reviewPending = true
    const operation = (async () => {
      syncReviewComments(session, targetResult.target.content)
      await persistReview(session)
      // Posting a discussion and accepting prose are separate Undo steps.
      // Keep the discussion on its original quotation before applying the text.
      if (!(fileManager.openFiles || []).includes(target) || target.path !== path) {
        throw new Error('The review document changed. Open the review again.')
      }
      if (stripCommentTags(targetResult.target.content).replace(/\r\n?/g, '\n') === session.references?.original) {
        const withDiscussions = reviewContent(session, session.references.original)
        if (withDiscussions !== targetResult.target.content && session.comments?.some(record => record.discussion || Object.keys(record.live).length)) {
          fileManager.updateContent(withDiscussions, targetResult.target)
          scheduleContentSync()
          await nextTick()
        }
      }
      if (context.meta?.type === 'inline-ai' && diffStore.currentReview === session) inlineAIState.value = null
      const rejected = reviewStatus(session) === 'rejected'
      const content = rejected ? reviewContent(session, stripCommentTags(target.content)) : reviewContent(session)
      return completeReview(targetResult.target, rejected ? 'rejected' : 'applied', content, context)
    })().catch(error => {
      const message = error?.message || String(error)
      if (diffStore.currentReview === session) diffStore.setReviewError(message)
      return { ok: false, error: message }
    }).finally(() => {
      session.applying = false
      target.reviewPending = false
      if (diffStore.currentReview === session) diffStore.finishing = false
      singleFinishes.delete(session.id)
    })
    singleFinishes.set(session.id, operation)
    return operation
  }

  function completeReview(target, status, content, context) {
    let decision = target.reviewDecision
    if (decision && decision !== diffStore.decision) {
      return { ok: false, error: 'Finish the previous review decision before reviewing another change.' }
    }
    if (decision && decision.status !== status) {
      return { ok: false, error: 'This decision is already applied. Retry its status update.' }
    }
    if (!decision) {
      const original = context?.original ?? diffStore.originalContent
      if (status === 'applied' && stripCommentTags(target.content) !== stripCommentTags(original) && target.content !== content) {
        const error = 'The document changed after this review was created. Reject this review, then request a new proposal.'
        diffStore.setReviewError(error)
        return { ok: false, error }
      }
      decision = {
        targetId: target.id, original, content, status,
        reviewSession: context?.session ?? diffStore.reviewSession,
        ids: proposalIdsFromReviewMeta(context?.meta ?? diffStore.reviewMeta),
        sessionId: (context?.meta ?? diffStore.reviewMeta)?.sessionId,
        reported: new Set(), pending: false, operation: null, error: '',
      }
      if (!context || diffStore.currentReview === context.session) diffStore.decision = decision
      target.reviewDecision = decision
      decision = target.reviewDecision
      target.reviewPending = true
      // Commit once, before any asynchronous report. A receipt can never write
      // text back into this document. Reject only dismisses the proposal.
      if ((status === 'applied' || stripCommentTags(target.content) === stripCommentTags(content)) && target.content !== content) {
        fileManager.updateContent(content, target)
        if (currentFile.value === target) scheduleContentSync()
      }
    }
    if (decision.operation) return decision.operation
    decision.pending = true
    decision.error = ''
    target.reviewPending = true
    decision.operation = (async () => {
      try { await persistDocuments() } catch (error) {
        decision.error = `The document draft could not be saved: ${error?.message || error}`
        if (diffStore.decision === decision) diffStore.setReviewError(decision.error)
        return { ok: false, error: decision.error }
      }
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
    const existing = file?.reviewSession
    if (existing && !existing.completed && opts?.review?.type !== 'history') {
      diffStore.activate({ original: existing.original, modified: existing.proposed, path, fileId: file.id,
        session: existing, review: existing.meta })
      return
    }
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
      const saved = open?.reviewSession || await loadReview(file.path)
      const review = saved && !saved.completed ? saved : null
      if (review && review.proposalKey !== (file.proposalId || '')) {
        throw new Error(`Finish the current review of ${file.path.split('/').pop()} before opening another review.`)
      }
      if (open?.graph) return { ...file, review, graphSourceRevision: open.graph.sourceRevision }
      const graph = isGraphSourceCandidate(file.path) ? await graphSource(file.path) : null
      return { ...file, review, graphSourceRevision: graph?.sourceRevision ?? null }
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
