import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { createReviewSession, recordReview, decideRemaining, decideCommentChange, moveReviewHistory, reviewStatus } from '../editor/reviewSession.js'
import { mutateReviewComment, reviewContent } from '../editor/reviewComments.js'
import { persistReview, scheduleReviewSave } from '../editor/reviewPersistence.js'

export const useDiffStore = defineStore('diff', () => {
  const active = ref(false)
  const mode = ref('single') // 'single' | 'batch'

  // Single-file state
  const originalContent = ref('')
  const modifiedContent = ref('')
  const filePath = ref('')
  const fileId = ref(null)
  const proposalIds = ref([])
  const batchId = ref(null)
  const reviewMeta = ref(null)
  const reviewError = ref('')
  const decision = ref(null)
  const reviewSession = ref(null)
  const finishing = ref(false)
  const reviewHistory = ref([])
  const reviewFuture = ref([])

  // Batch state
  const files = ref([]) // { path, original, modified, proposalId, status: 'pending'|'accepted'|'rejected' }

  // View state (single-file)
  const viewMode = ref('diff')
  const layout = ref('unified')
  const chunkCount = ref(0)
  const currentChunk = ref(0)

  const hasChunks = computed(() => chunkCount.value > 0)
  const isBatch = computed(() => mode.value === 'batch')
  const focusedFile = ref(null)
  const isBatchFileFocused = computed(() => isBatch.value && focusedFile.value !== null)
  const currentReview = computed(() => isBatch.value
    ? files.value.find(file => file.path === focusedFile.value)?.review || null
    : reviewSession.value)
  const pendingChanges = computed(() => isBatch.value && !isBatchFileFocused.value
    ? files.value.reduce((total, file) => total + file.review.pending, 0)
    : currentReview.value?.pending || 0)
  const canFinish = computed(() => active.value && !decision.value && !finishing.value && (isBatch.value
    ? files.value.length > 0 && files.value.every(file => file.review.pending === 0)
    : currentReview.value?.pending === 0))
  const hasDiscussionDrafts = computed(() => (isBatch.value ? files.value.map(file => file.review) : [currentReview.value])
    .some(session => session?.commentUI?.compose?.body?.trim() || Object.values(session?.commentUI?.drafts || {}).some(text => text?.trim())))
  const canUndo = computed(() => !decision.value && !finishing.value && reviewHistory.value.some(group => group.some(editableSession)))
  const canRedo = computed(() => !decision.value && !finishing.value && reviewFuture.value.some(group => group.some(editableSession)))

  const pendingFiles = computed(() => files.value.filter(f => f.status === 'pending'))
  const resolvedCount = computed(() => files.value.filter(f => f.status !== 'pending').length)
  const allResolved = computed(() => files.value.length > 0 && pendingFiles.value.length === 0)

  function activate({ original, modified, path = '', fileId: targetFileId = null, proposals = [], batch = null, review = null, session = null }) {
    mode.value = 'single'
    originalContent.value = original
    modifiedContent.value = modified
    filePath.value = path
    fileId.value = targetFileId
    proposalIds.value = proposals
    batchId.value = batch
    reviewMeta.value = review || null
    reviewError.value = ''
    decision.value = null
    finishing.value = false
    reviewSession.value = session || createReviewSession(original, modified)
    reviewSession.value.key ||= path || null
    reviewSession.value.meta = review || null
    reviewHistory.value = reviewSession.value.past.map(() => [reviewSession.value])
    reviewFuture.value = reviewSession.value.future.map(() => [reviewSession.value])
    files.value = []
    viewMode.value = 'diff'
    chunkCount.value = reviewSession.value.pending
    currentChunk.value = reviewSession.value.currentChunk
    active.value = true
    if (review?.type !== 'history') scheduleReviewSave(reviewSession.value)
  }

  function activateBatch({ fileList, batch = null, sessionId = null }) {
    decision.value = null
    finishing.value = false
    reviewSession.value = null
    reviewHistory.value = []
    reviewFuture.value = []
    mode.value = 'batch'
    files.value = fileList.map(f => ({
      path: f.path,
      original: f.original,
      modified: f.modified,
      proposed: f.modified,
      review: f.review || createReviewSession(f.original, f.modified),
      proposalId: f.proposalId || null,
      ...(f.graphSourceRevision != null ? { graphSourceRevision: f.graphSourceRevision } : {}),
      status: 'pending',
      applied: false,
      lifecycleResolved: false,
      error: null,
    }))
    for (const file of files.value) {
      file.status = reviewStatus(file.review)
      file.modified = reviewContent(file.review)
      file.review.key = file.path
      file.review.meta = { ids: [file.proposalId].filter(Boolean), sessionId, path: file.path }
      file.review.proposalKey = file.proposalId || ''
      scheduleReviewSave(file.review)
    }
    batchId.value = batch
    reviewMeta.value = sessionId ? { sessionId } : null
    reviewError.value = ''
    originalContent.value = ''
    modifiedContent.value = ''
    filePath.value = ''
    fileId.value = null
    proposalIds.value = []
    focusedFile.value = null
    viewMode.value = 'diff'
    layout.value = 'unified'
    chunkCount.value = 0
    currentChunk.value = 0
    active.value = true
  }

  function deactivate() {
    decision.value = null
    reviewSession.value = null
    reviewHistory.value = []
    reviewFuture.value = []
    finishing.value = false
    active.value = false
    mode.value = 'single'
    originalContent.value = ''
    modifiedContent.value = ''
    filePath.value = ''
    fileId.value = null
    proposalIds.value = []
    batchId.value = null
    reviewMeta.value = null
    reviewError.value = ''
    focusedFile.value = null
    files.value = []
    chunkCount.value = 0
    currentChunk.value = 0
  }

  function syncReview(session) {
    reviewError.value = ''
    const file = files.value.find(file => file.review === session)
    if (file) {
      file.modified = reviewContent(session)
      file.status = reviewStatus(session)
      file.error = null
    }
    if (currentReview.value === session) setChunkCount(session.pending)
    scheduleReviewSave(session)
  }

  async function comment(session, action, input, selection) {
    if (!editableSession(session) || finishing.value || decision.value || reviewMeta.value?.type === 'history') throw new Error('This review is read only.')
    const result = mutateReviewComment(session, action, input, 'user', selection)
    syncReview(session)
    // A failed save keeps the discussion in memory and exposes Retry save.
    // It must not roll back a reply after another action has already seen it.
    try { return { ...result, saved: await persistReview(session) } }
    catch { return { ...result, saved: false } }
  }

  function decideComment(session, id, action) {
    if (!editableSession(session) || finishing.value || decision.value) return
    if (!decideCommentChange(session, id, action)) return
    reviewHistory.value.push([session])
    reviewFuture.value = []
    syncReview(session)
  }

  function recordReviewChange(session, base, result, action) {
    if (!session || decision.value || finishing.value || !editableSession(session)) return
    if (!recordReview(session, base, result, action)) return
    reviewHistory.value.push([session])
    reviewFuture.value = []
    syncReview(session)
  }

  function decideRemainingChanges(action, path = null) {
    if (decision.value || finishing.value) return
    const sessions = isBatch.value
      ? files.value.filter(file => !file.applied && !file.lifecycleResolved
        && (!(path || focusedFile.value) || file.path === (path || focusedFile.value))).map(file => file.review)
      : [reviewSession.value].filter(Boolean)
    const changed = sessions.filter(session => decideRemaining(session, action))
    if (changed.length) {
      reviewHistory.value.push(changed)
      reviewFuture.value = []
      changed.forEach(syncReview)
    }
  }

  function undoReview() { return replayReview('undo') }
  function redoReview() { return replayReview('redo') }
  function editableSession(session) {
    const file = files.value.find(file => file.review === session)
    return isBatch.value ? Boolean(file && !file.applied && !file.lifecycleResolved) : session === reviewSession.value
  }
  function replayReview(direction) {
    if (decision.value || finishing.value) return false
    const from = direction === 'undo' ? reviewHistory.value : reviewFuture.value
    const to = direction === 'undo' ? reviewFuture.value : reviewHistory.value
    while (from.length) {
      const changed = from.pop().filter(session => editableSession(session) && moveReviewHistory(session, direction))
      if (!changed.length) continue
      changed.forEach(syncReview)
      to.push(changed)
      return true
    }
    return false
  }

  function focusBatchFile(path) {
    const file = files.value.find(f => f.path === path)
    if (file) {
      originalContent.value = file.original
      modifiedContent.value = file.modified
      filePath.value = file.path
      focusedFile.value = file.path
      viewMode.value = 'diff'
      chunkCount.value = file.review.pending
      currentChunk.value = file.review.currentChunk
      return true
    }
    clearBatchFocus()
    return false
  }

  function clearBatchFocus() {
    originalContent.value = ''
    modifiedContent.value = ''
    filePath.value = ''
    focusedFile.value = null
    chunkCount.value = 0
    currentChunk.value = 0
  }

  function setViewMode(m) {
    if (['original', 'diff', 'result'].includes(m)) {
      viewMode.value = m
    }
  }

  function setLayout(l) {
    if (['unified', 'split'].includes(l)) {
      layout.value = l
    }
  }

  function setReviewError(error = '') {
    reviewError.value = String(error || '')
  }

  function setChunkCount(count) {
    chunkCount.value = count
    if (currentChunk.value >= count) {
      currentChunk.value = Math.max(0, count - 1)
    }
  }

  function nextChunk() {
    if (chunkCount.value === 0) return
    currentChunk.value = (currentChunk.value + 1) % chunkCount.value
    if (currentReview.value) currentReview.value.currentChunk = currentChunk.value
  }

  function prevChunk() {
    if (chunkCount.value === 0) return
    currentChunk.value = (currentChunk.value - 1 + chunkCount.value) % chunkCount.value
    if (currentReview.value) currentReview.value.currentChunk = currentChunk.value
  }

  return {
    active, mode, isBatch,
    originalContent, modifiedContent, filePath, fileId,
    proposalIds, batchId, reviewMeta, reviewError, decision,
    reviewSession, currentReview, pendingChanges, canFinish, hasDiscussionDrafts, canUndo, canRedo, finishing,
    recordReviewChange, decideRemainingChanges, undoReview, redoReview, comment, decideComment,
    focusedFile, isBatchFileFocused,
    files, pendingFiles, resolvedCount, allResolved,
    viewMode, layout, chunkCount, currentChunk, hasChunks,
    activate, activateBatch, deactivate,
    focusBatchFile, clearBatchFocus,
    setViewMode, setLayout, setReviewError,
    setChunkCount, nextChunk, prevChunk,
  }
})
