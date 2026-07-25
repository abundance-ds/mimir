
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

  async function respondToFocusedFile(file, status) {
    if (!file?.proposalId) return
    const sessionId = diffStore.reviewMeta?.sessionId || ''
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('proposal_respond', {
        result: { id: file.proposalId, sessionId, status, detail: `User ${status} the change` },
      })
    } catch {}
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
    const accepted = allFiles.filter(f => f.status === 'accepted')

    diffStore.deactivate()
    reviewTabActive.value = false

    for (const file of accepted) {
      if (currentFile.value?.path === file.path) {
        currentFile.value.content = file.modified
        fileManager.markDirty()
      }
    }
    if (accepted.length > 0) scheduleContentSync()

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await Promise.allSettled(
        allFiles.filter(f => f.proposalId).map(file => {
          const status = file.status === 'accepted' ? 'applied' : 'rejected'
          return invoke('proposal_respond', {
            result: { id: file.proposalId, sessionId, status, detail: `User ${status} the change` },
          })
        })
      )
    } catch {}
  }

  async function onDiffAcceptAll() {
    if (diffStore.isBatchFileFocused) {
      const path = diffStore.focusedFile
      diffStore.acceptFile(path)
      const file = diffStore.files.find(f => f.path === path)
      if (file && currentFile.value?.path === path) {
        currentFile.value.content = file.modified
        fileManager.markDirty()
        scheduleContentSync()
      }
      await respondToFocusedFile(file, 'applied')
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
      const file = diffStore.files.find(f => f.path === path)
      await respondToFocusedFile(file, 'rejected')
      diffStore.clearBatchFocus()
      reviewTabActive.value = true
      if (diffStore.allResolved) await onBatchAllResolved()
      return
    }
    if (diffStore.isBatch) {
      const allFiles = [...diffStore.files]
      const sessionId = diffStore.reviewMeta?.sessionId || ''
      diffStore.rejectAllFiles()
      diffStore.deactivate()
      reviewTabActive.value = false
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await Promise.allSettled(
          allFiles.filter(f => f.proposalId).map(file =>
            invoke('proposal_respond', {
              result: { id: file.proposalId, sessionId, status: 'rejected', detail: 'User rejected the change' },
            })
          )
        )
      } catch {}
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
