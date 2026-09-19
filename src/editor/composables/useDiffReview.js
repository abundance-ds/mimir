import { singleDiffTargetsFile } from '../workspaceDiffProjection.js'
import { graphSource, saveGraphSource } from '../../services/businessGraph.js'
import { graphDocumentState, isGraphSourceCandidate } from '../../stores/graphDocuments.js'

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

  async function onBatchAllResolved() {
    // Captured references, mutated directly: a proposals-changed broadcast
    // arriving between awaits can deactivate the store and empty its file
    // list, and a path re-lookup would then silently skip the remaining
    // proposal_respond calls, leaving those proposals pending forever.
    const allFiles = [...diffStore.files]
    const sessionId = diffStore.reviewMeta?.sessionId || ''
    const { invoke } = await import('@tauri-apps/api/core')
    let activeEditorChanged = false

    for (const file of allFiles) {
      if (file.status !== 'accepted' || file.applied) continue
      try {
        const openFile = fileManager.openFiles?.find(candidate => candidate.path === file.path)
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
          if (graphFile.content !== file.original && graphFile.content !== file.modified) {
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
          if (currentFile.value.content !== file.original) {
            throw new Error('The active document changed after this review was created. Reopen the proposal against the latest text.')
          }
          fileManager.updateContent(file.modified, currentFile.value)
          activeEditorChanged = true
        } else {
          const currentContent = graph?.content ?? (openFile
            ? openFile.content
            : (await invoke('read_text_file', { path: file.path })).content)
          if (currentContent !== file.original && currentContent !== file.modified) {
            throw new Error('This file changed after the review was created. Refresh the proposal before applying it.')
          }
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
      const status = file.status === 'accepted' ? 'applied' : 'rejected'
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

    diffStore.deactivate()
    reviewTabActive.value = false
    return { ok: true }
  }

  async function onDiffAcceptAll() {
    if (diffStore.isBatchFileFocused) {
      const path = diffStore.focusedFile
      diffStore.acceptFile(path)
      diffStore.clearBatchFocus()
      reviewTabActive.value = true
      if (diffStore.allResolved) await onBatchAllResolved()
      return
    }
    if (diffStore.isBatch) {
      diffStore.acceptAllFiles()
      await onBatchAllResolved()
    } else {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
      const target = targetResult.target
      if (diffStore.reviewMeta?.type === 'history') {
        restoreConfirmMeta.value = diffStore.reviewMeta
      } else if (diffStore.reviewMeta?.type === 'inline-ai') {
        applyDiffResult(diffStore.modifiedContent, target)
        inlineAIState.value = null
      } else {
        // Commit the resolved review text before reporting the decision.
        const modified = diffViewRef.value?.getResolvedContent?.() ?? diffStore.modifiedContent
        return completeReview(target, 'applied', modified)
      }
    }
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
    if (diffStore.isBatchFileFocused) {
      const path = diffStore.focusedFile
      diffStore.rejectFile(path)
      diffStore.clearBatchFocus()
      reviewTabActive.value = true
      if (diffStore.allResolved) await onBatchAllResolved()
      return
    }
    if (diffStore.isBatch) {
      diffStore.rejectAllFiles()
      await onBatchAllResolved()
    } else {
      const targetResult = requireActiveSingleDiffTarget()
      if (!targetResult.ok) return targetResult
      const target = targetResult.target
      if (diffStore.reviewMeta?.type === 'history') {
        diffStore.deactivate()
      } else if (diffStore.reviewMeta?.type === 'inline-ai') {
        diffStore.deactivate()
      } else {
        // Reject dismisses the proposal and retains the document's current text.
        const original = diffStore.originalContent
        return completeReview(target, 'rejected', original)
      }
    }
  }

  async function onDiffChunksResolved(content) {
    if (diffStore.isBatchFileFocused) {
      const path = diffStore.focusedFile
      diffStore.resolveBatchFile(path, content)
      diffStore.clearBatchFocus()
      reviewTabActive.value = true
      if (diffStore.allResolved) await onBatchAllResolved()
      return
    }
    const targetResult = requireActiveSingleDiffTarget()
    if (!targetResult.ok) return targetResult
    const target = targetResult.target
    if (diffStore.reviewMeta?.type === 'inline-ai') inlineAIState.value = null
    else if (proposalIdsFromReviewMeta(diffStore.reviewMeta).length > 0) {
      const status = content === diffStore.originalContent ? 'rejected' : 'applied'
      return completeReview(target, status, content)
    }
    return applyDiffResult(content, target)
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
      if (status === 'applied' && target.content !== original && target.content !== content) {
        const error = 'The document changed after this review was created. Reopen the proposal against the latest text.'
        diffStore.setReviewError(error)
        return { ok: false, error }
      }
      diffStore.decision = {
        targetId: target.id, original, content, status,
        ids: proposalIdsFromReviewMeta(diffStore.reviewMeta),
        sessionId: diffStore.reviewMeta?.sessionId,
        reported: new Set(), pending: false, operation: null, error: '',
      }
      decision = diffStore.decision
      target.reviewDecision = decision
      target.reviewPending = true
      // Commit once, before any asynchronous report. A receipt can never write
      // text back into this document. Reject only dismisses the proposal.
      if (status === 'applied' && target.content !== content) {
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
      if (remaining.length) fileManager.setFileReviews(target, remaining)
      else fileManager.clearFileReviews(target)
      target.reviewDecision = null
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
    reviewTabActive.value = true
  }

  return {
    onDiffAcceptAll,
    onDiffRejectAll,
    onDiffChunksResolved,
    onDiffNavigateChunk,
    onDiffNavigateFile,
    onRestoreConfirm,
    activateDiffForCurrentFile,
    activateBatchDiff,
    onBatchAllResolved,
  }
}
