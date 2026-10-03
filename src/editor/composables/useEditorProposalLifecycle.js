import { nextTick, watch } from 'vue'
import { loadReview, reviewKey, scheduleReviewSave } from '../reviewPersistence.js'
import {
  computeCompoundDiff,
  computeDiffFromReview,
  useProposalBridge,
} from './useProposalBridge.js'

export function useEditorProposalLifecycle({
  fileManager,
  diffStore,
  openFiles,
  activeFileIndex,
  currentEditorContent,
  flushEditorContent,
  editorSurfaceRef,
  activateDiff,
  activateBatchDiff,
}) {
  const windowLabel = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('window') || ''
    : ''
  const unlisteners = []
  let registerTimer = null
  let disposed = false
  const sourceRequired = 'Open Source before applying a Markdown proposal to this Graph entry.'

  function canApply() {
    return fileManager.currentFile?.kind !== 'graph' && Boolean(editorSurfaceRef.value)
  }

  const bridge = useProposalBridge({
    getDocContent: () => currentEditorContent(),
    canApply,
    applyChange: (from, to, text) => {
      if (!canApply()) throw new Error(sourceRequired)
      editorSurfaceRef.value.replaceRange(from, to, text)
    },
    getDocPath: () => fileManager.currentFile?.path ?? '',
    activateDiff: (original, modified, options) => {
      if (!canApply()) throw new Error(sourceRequired)
      return activateDiff(original, modified, options)
    },
    activateBatchDiff: (fileList, meta) => activateBatchDiff(fileList, meta),
    openFileForDiff: async (path, content) => {
      const file = await fileManager.openFile(path, content)
      if (file?.kind === 'graph' && !await fileManager.setGraphView(file, 'source')) {
        throw new Error('Save the Graph draft before opening Source.')
      }
      await nextTick()
      if (file && fileManager.currentFile !== file) throw new Error('The active document changed. Open the proposal again.')
      return file
    },
    stashFileReviews: review => (
      fileManager.setFileReviews(fileManager.currentFile, [review])
    ),
  })

  const stopActiveFileWatch = watch(
    () => [fileManager.activeFileIndex, fileManager.currentFile?.kind],
    async (_value, _previous, onCleanup) => {
      const file = fileManager.currentFile
      let cancelled = false
      onCleanup(() => { cancelled = true })
      // Source may still show the preceding document during this Vue update.
      // Wait for the surface before flushing its buffer into a pending review.
      await nextTick()
      if (cancelled || disposed || fileManager.currentFile !== file) return
      if (file?.reviews || file?.reviewDecision || file?.reviewSession) {
        if (!activateDiffFromReviews(file)) diffStore.deactivate()
      } else if (diffStore.active && diffStore.reviewMeta?.ids) {
        diffStore.deactivate()
      }
      void checkProposalsForFile(file)
    },
  )

  const stopRegistrationWatch = watch(
    () => [
      activeFileIndex.value,
      ...openFiles.value.map(file => `${file.path || ''}:${file.dirty ? '1' : '0'}`),
    ].join('|'),
    scheduleRegistration,
    { immediate: true },
  )

  void bindNativeEvents()

  function scheduleRegistration() {
    if (!hasTauriRuntime() || disposed) return
    clearTimeout(registerTimer)
    registerTimer = setTimeout(() => {
      void registerDocuments()
    }, 50)
  }

  async function registerDocuments() {
    if (disposed) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('proposal_register_editor', {
        windowLabel,
        documents: openFiles.value.map((file, index) => ({
          path: file.path || '',
          dirty: Boolean(file.dirty),
          active: index === activeFileIndex.value,
        })),
      })
    } catch {}
  }

  function unregisterDocuments() {
    if (!hasTauriRuntime()) return
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('proposal_register_editor', {
        windowLabel,
        documents: [],
      }))
      .catch(() => {})
  }

  async function bindNativeEvents() {
    if (!hasTauriRuntime()) return
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const registrations = await Promise.all([
        listen('mimir://proposals-changed', onProposalsChanged),
      ])
      if (disposed) {
        registrations.forEach(stop => stop())
      } else {
        unlisteners.push(...registrations)
      }
    } catch {}
  }

  function onProposalsChanged(event) {
    const proposals = event.payload || []
    const file = fileManager.currentFile
    if (!file?.path) return
    flushEditorContent()

    const matches = proposals.filter(
      proposal => proposal.path === file.path || proposal.absolutePath === file.path,
    )
    if (!file.reviews) {
      if (matches.length === 0) return
      fileManager.setFileReviews(file, matches.map(proposalToReview))
      activateDiffFromReviews(file)
      return
    }

    // Reconcile by proposal id, not by "any match for this path": a review is
    // stale only when its id left the global pending set, and a new pending
    // proposal for this file joins the existing reviews instead of being lost.
    const pendingIds = new Set(proposals.map(proposal => proposal.id))
    const kept = file.reviews.filter(review => pendingIds.has(review.proposalId))
    const keptIds = new Set(kept.map(review => review.proposalId))
    const added = matches.filter(proposal => !keptIds.has(proposal.id)).map(proposalToReview)
    if (added.length === 0 && kept.length === file.reviews.length) return
    const next = [...kept, ...added]
    if (next.length === 0) {
      fileManager.clearFileReviews(file)
      if (!file.reviewDecision && !diffStore.finishing) diffStore.deactivate()
    } else {
      fileManager.setFileReviews(file, next)
      activateDiffFromReviews(file)
    }
  }

  function activateDiffFromReviews(file) {
    if (diffStore.finishing) return true
    if (file?.reviewDecision) {
      const decision = file.reviewDecision
      diffStore.activate({
        original: decision.original, modified: decision.content,
        path: file.path || '', fileId: file.id,
        review: { ids: decision.ids, sessionId: decision.sessionId, path: file.path },
      })
      diffStore.decision = decision
      diffStore.setReviewError(decision.error)
      return true
    }
    if (!file || file.kind === 'graph') return false
    if (!file.reviews?.length && file.reviewSession && !file.reviewSession.completed) {
      const session = file.reviewSession
      diffStore.activate({ original: session.original, modified: session.proposed,
        path: file.path || '', fileId: file.id, session, review: session.meta })
      return true
    }
    if (!file.reviews?.length) return false
    const proposalKey = file.reviews.map(review => review.proposalId).slice().sort().join('\n')
    const session = file.reviewSession?.proposalKey === proposalKey ? file.reviewSession : null
    if (session) {
      diffStore.activate({
        original: session.original, modified: session.proposed,
        path: file.path || '', fileId: file.id, session,
        review: { ids: file.reviews.map(review => review.proposalId), sessionId: file.reviews[0].sessionId, path: file.path },
      })
      return true
    }
    if (fileManager.currentFile === file) flushEditorContent()
    const content = file.content || ''
    const diff = file.reviews.length === 1
      ? computeDiffFromReview(file.reviews[0], content)
      : computeCompoundDiff(file.reviews, content)
    if (!diff) {
      // A failed compute is transient (content still hydrating, buffer
      // edited): keep the reviews so a later activation can re-offer them.
      // Only the native coordinator or an explicit user action ends a
      // proposal.
      return false
    }
    const first = file.reviews[0]
    diffStore.activate({
      original: diff.original,
      modified: diff.modified,
      path: file.path || '',
      fileId: file.id,
      review: {
        ids: file.reviews.map(review => review.proposalId),
        sessionId: first.sessionId,
        path: first.path,
      },
    })
    file.reviewSession = diffStore.reviewSession
    file.reviewSession.key = reviewKey(file)
    file.reviewSession.proposalKey = proposalKey
    scheduleReviewSave(file.reviewSession)
    return true
  }

  async function checkProposalsForFile(file) {
    if (!file?.path || file.reviews || !hasTauriRuntime()) return
    const path = file.path
    try {
      if (!file.reviewSession) {
        const saved = await loadReview(reviewKey(file))
        if (disposed || file.path !== path || !fileManager.openFiles.includes(file)) return
        if (saved && !saved.completed) file.reviewSession = saved
      }
      const { invoke } = await import('@tauri-apps/api/core')
      const proposals = await invoke('get_proposals_for_path', { path })
      if (disposed || file.path !== path || !fileManager.openFiles.includes(file)) return
      if (!proposals.length) {
        if (file.reviewSession && fileManager.currentFile === file) activateDiffFromReviews(file)
        return
      }
      fileManager.setFileReviews(file, proposals.map(proposalToReview))
      // Only activate the diff if this file is still current; a tab switch
      // during the await must not leave a stale diff active.
      if (fileManager.currentFile === file) activateDiffFromReviews(file)
    } catch {}
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stopActiveFileWatch()
    stopRegistrationWatch()
    clearTimeout(registerTimer)
    unlisteners.splice(0).forEach(stop => stop())
    bridge.cleanup()
    unregisterDocuments()
  }

  return {
    activateDiffFromReviews,
    bridge,
    checkProposalsForFile,
    dispose,
    onProposalsChanged,
    scheduleRegistration,
  }
}

function proposalToReview(proposal) {
  return {
    proposalId: proposal.id,
    sessionId: proposal.threadId || proposal.sessionId || '',
    targetText: proposal.targetText || '',
    replacement: proposal.replacement || '',
    path: proposal.absolutePath || proposal.path,
    type: proposal.type || 'edit',
  }
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}
