import { singleDiffTargetsFile } from '../workspaceDiffProjection.js'

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
    diffStore.deactivate()
    if (content != null) {
      target.content = content
      fileManager.markDirty(target)
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
        const active = currentFile.value?.path === file.path
        if (active) {
          if (currentFile.value.content !== file.original) {
            throw new Error('The active document changed after this review was created. Reopen the proposal against the latest text.')
          }
          currentFile.value.content = file.modified
          fileManager.markDirty()
          activeEditorChanged = true
        } else {
          const openFile = fileManager.openFiles?.find(candidate => candidate.path === file.path)
          const currentContent = openFile
            ? openFile.content
            : (await invoke('read_text_file', { path: file.path })).content
          if (currentContent !== file.original && currentContent !== file.modified) {
            throw new Error('This file changed after the review was created. Refresh the proposal before applying it.')
          }
          if (currentContent !== file.modified) {
            await invoke('write_text_file', { path: file.path, content: file.modified })
          }
          if (openFile) {
            openFile.content = file.modified
            openFile.dirty = false
            openFile.saveState = 'saved'
            openFile.saveError = null
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
        const lifecycle = await respondToDiffReview('applied')
        if (!lifecycle.ok) return lifecycle
        fileManager.clearFileReviews(target)
        return applyDiffResult(modified, target)
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
        const lifecycle = await respondToDiffReview('rejected')
        if (!lifecycle.ok) return lifecycle
        fileManager.clearFileReviews(target)
        return applyDiffResult(original, target)
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
      const lifecycle = await respondToDiffReview(status)
      if (!lifecycle.ok) return lifecycle
      fileManager.clearFileReviews(target)
    }
    return applyDiffResult(content, target)
  }

  function onDiffNavigateChunk(index) {
    diffViewRef.value?.scrollToChunk(index)
  }

  function onDiffNavigateFile(path) {
    batchDiffViewRef.value?.scrollToFile(path)
  }

  function activateDiffForCurrentFile(original, modified, opts) {
    const file = currentFile.value
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

  function activateBatchDiff(fileList, meta) {
    flushEditorContent({ bridge: 'flush' })
    diffStore.activateBatch({ fileList, sessionId: meta?.sessionId })
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
