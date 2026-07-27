import { watch } from 'vue'
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

  const bridge = useProposalBridge({
    getDocContent: () => currentEditorContent(),
    applyChange: (from, to, text) => editorSurfaceRef.value?.replaceRange(from, to, text),
    getDocPath: () => fileManager.currentFile?.path ?? '',
    activateDiff: (original, modified, options) => (
      activateDiff(original, modified, options)
    ),
    activateBatchDiff: (fileList, meta) => activateBatchDiff(fileList, meta),
    openFileForDiff: (path, content) => fileManager.openFile(path, content),
    stashFileReviews: review => (
      fileManager.setFileReviews(fileManager.currentFile, [review])
    ),
  })

  const stopActiveFileWatch = watch(
    () => fileManager.activeFileIndex,
    () => {
      const file = fileManager.currentFile
      if (file?.reviews) {
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
        listen('mim://proposals-changed', onProposalsChanged),
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
    if (matches.length > 0 && !file.reviews) {
      fileManager.setFileReviews(file, matches.map(proposalToReview))
      activateDiffFromReviews(file)
    } else if (matches.length === 0 && file.reviews) {
      fileManager.clearFileReviews(file)
      diffStore.deactivate()
    }
  }

  function activateDiffFromReviews(file) {
    if (!file?.reviews?.length) return false
    if (fileManager.currentFile === file) flushEditorContent()
    const content = file.content || ''
    const diff = file.reviews.length === 1
      ? computeDiffFromReview(file.reviews[0], content)
      : computeCompoundDiff(file.reviews, content)
    if (!diff) {
      fileManager.clearFileReviews(file)
      return false
    }
    const first = file.reviews[0]
    diffStore.activate({
      original: diff.original,
      modified: diff.modified,
      path: file.path || '',
      review: {
        ids: file.reviews.map(review => review.proposalId),
        sessionId: first.sessionId,
        path: first.path,
      },
    })
    return true
  }

  async function checkProposalsForFile(file) {
    if (!file?.path || file.reviews || !hasTauriRuntime()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const proposals = await invoke('get_proposals_for_path', { path: file.path })
      if (!proposals.length || disposed) return
      fileManager.setFileReviews(file, proposals.map(proposalToReview))
      activateDiffFromReviews(file)
    } catch {}
  }

  function dispose() {
    if (disposed) return
    disposed = true
    stopActiveFileWatch()
    stopRegistrationWatch()
    clearTimeout(registerTimer)
    unlisteners.splice(0).forEach(stop => stop())
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
