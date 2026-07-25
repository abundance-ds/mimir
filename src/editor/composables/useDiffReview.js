
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
  function applyDiffResult(content) {
    diffStore.deactivate()
    if (content != null && currentFile.value) {
      currentFile.value.content = content
      fileManager.markDirty()
      scheduleContentSync()
    }
  }

  async function respondToDiffReview(status) {
    const meta = diffStore.reviewMeta
    const ids = proposalIdsFromReviewMeta(meta)
    if (ids.length === 0) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await Promise.allSettled(
        ids.map(id =>
          invoke('proposal_respond', {
            result: { id, sessionId: meta.sessionId, status, detail: status === 'applied' ? 'User accepted the change' : 'User rejected the change' },
          })
        )
      )
    } catch {}
  }

  async function onBatchAllResolved() {
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
        diffStore.markFileApplied(file.path)
      } catch (error) {
        diffStore.markFileFailed(file.path, error?.message || error)
      }
    }
    if (activeEditorChanged) scheduleContentSync()

    for (const file of allFiles) {
      const liveFile = diffStore.files.find(candidate => candidate.path === file.path)
      if (!liveFile || liveFile.status === 'pending' || liveFile.lifecycleResolved) continue
      if (liveFile.status === 'accepted' && !liveFile.applied) continue
      if (!liveFile.proposalId) {
        diffStore.markFileLifecycleResolved(file.path)
        continue
      }
      const status = liveFile.status === 'accepted' ? 'applied' : 'rejected'
      try {
        await invoke('proposal_respond', {
          result: {
            id: liveFile.proposalId,
            sessionId,
            status,
            detail: `User ${status} the change`,
          },
        })
        diffStore.markFileLifecycleResolved(file.path)
      } catch (error) {
        diffStore.markFileFailed(
          file.path,
          `The file decision was saved, but its proposal status could not be updated: ${error?.message || error}`,
        )
      }
    }

    if (diffStore.pendingFiles.length > 0) {
      return {
        ok: false,
        failures: diffStore.pendingFiles.map(file => ({ path: file.path, error: file.error })),
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
    } else if (diffStore.reviewMeta?.type === 'history') {
      restoreConfirmMeta.value = diffStore.reviewMeta
    } else if (diffStore.reviewMeta?.type === 'inline-ai') {
      applyDiffResult(diffStore.modifiedContent)
      inlineAIState.value = null
    } else {
      await respondToDiffReview('applied')
      fileManager.clearFileReviews(currentFile.value)
      applyDiffResult(diffStore.modifiedContent)
    }
  }

  function onRestoreConfirm(action) {
    if (action === 'restore') {
      applyDiffResult(diffStore.originalContent)
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
    } else if (diffStore.reviewMeta?.type === 'history') {
      diffStore.deactivate()
    } else if (diffStore.reviewMeta?.type === 'inline-ai') {
      diffStore.deactivate()
    } else {
      await respondToDiffReview('rejected')
      fileManager.clearFileReviews(currentFile.value)
      applyDiffResult(diffStore.originalContent)
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
    if (diffStore.reviewMeta?.type === 'inline-ai') inlineAIState.value = null
    else if (proposalIdsFromReviewMeta(diffStore.reviewMeta).length > 0) {
      const status = content === diffStore.originalContent ? 'rejected' : 'applied'
      await respondToDiffReview(status)
      fileManager.clearFileReviews(currentFile.value)
    }
    applyDiffResult(content)
  }

  function onDiffNavigateChunk(index) {
    diffViewRef.value?.scrollToChunk(index)
  }

  function onDiffNavigateFile(path) {
    batchDiffViewRef.value?.scrollToFile(path)
  }

  function activateDiffForCurrentFile(original, modified, opts) {
    const path = currentFile.value?.path || ''
    flushEditorContent({ bridge: 'flush' })
    diffStore.activate({ original, modified, path, review: opts?.review || null })
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
