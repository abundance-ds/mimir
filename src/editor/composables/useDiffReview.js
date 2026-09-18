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

  async function respondToDiffReview(status) {
    const meta = diffStore.reviewMeta
    const ids = proposalIdsFromReviewMeta(meta)
    if (ids.length === 0) return { ok: true }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const results = await Promise.allSettled(
        ids.map(id =>
          invoke('proposal_respond', {
            result: { id, sessionId: meta.sessionId, status, detail: status === 'applied' ? 'User accepted the change' : 'User rejected the change' },
          })
        )
      )
      const failure = results.find(result => result.status === 'rejected')
      if (failure) {
        const error = `The edit decision could not be reported: ${failure.reason?.message || failure.reason}`
        diffStore.setReviewError?.(error)
        return { ok: false, error }
      }
      diffStore.setReviewError?.('')
      return { ok: true }
    } catch (cause) {
      const error = `The edit decision could not be reported: ${cause?.message || cause}`
      diffStore.setReviewError?.(error)
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
        // Snapshot before the await: the proposals-changed broadcast that
        // follows proposal_respond can deactivate the diff store mid-flight,
        // and a post-await read would then apply reset ('') content.
        const modified = diffStore.modifiedContent
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
        // Same pre-await snapshot rule as accept: see onDiffAcceptAll.
        const original = diffStore.originalContent
        return completeReview(target, 'rejected', original)
      }
    }
  }

  async function onDiffChunksResolved(content) {
    if (diffStore.isBatchFileFocused) {
      const path = diffStore.focusedFile
      const file = diffStore.files.find(candidate => candidate.path === path)
      if (file) file.modified = content
      diffStore.acceptFile(path)
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

  async function completeReview(target, status, content) {
    if (target.graph) target.reviewPending = true
    try {
      const lifecycle = await respondToDiffReview(status)
      if (!lifecycle.ok) return lifecycle
      fileManager.clearFileReviews(target)
      return applyDiffResult(content, target)
    } finally {
      if (target.graph) target.reviewPending = false
    }
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
