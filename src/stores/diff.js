import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

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

  const pendingFiles = computed(() => files.value.filter(f => f.status === 'pending'))
  const resolvedCount = computed(() => files.value.filter(f => f.status !== 'pending').length)
  const allResolved = computed(() => files.value.length > 0 && pendingFiles.value.length === 0)

  function activate({ original, modified, path = '', fileId: targetFileId = null, proposals = [], batch = null, review = null }) {
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
    files.value = []
    viewMode.value = 'diff'
    chunkCount.value = 0
    currentChunk.value = 0
    active.value = true
  }

  function activateBatch({ fileList, batch = null, sessionId = null }) {
    decision.value = null
    mode.value = 'batch'
    files.value = fileList.map(f => ({
      path: f.path,
      original: f.original,
      modified: f.modified,
      proposed: f.modified,
      proposalId: f.proposalId || null,
      ...(f.graphSourceRevision != null ? { graphSourceRevision: f.graphSourceRevision } : {}),
      status: 'pending',
      applied: false,
      lifecycleResolved: false,
      error: null,
    }))
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

  function acceptFile(path) {
    const f = files.value.find(x => x.path === path)
    if (f) {
      f.status = f.modified === f.original && f.modified !== f.proposed ? 'rejected' : 'accepted'
      f.error = null
    }
  }

  function rejectFile(path) {
    const f = files.value.find(x => x.path === path)
    if (f && !f.applied && !f.lifecycleResolved) {
      f.status = 'rejected'
      f.error = null
    }
  }

  function acceptAllFiles() {
    pendingFiles.value.forEach(f => {
      acceptFile(f.path)
    })
  }

  function rejectAllFiles() {
    pendingFiles.value.forEach(f => {
      if (f.applied) acceptFile(f.path)
      else rejectFile(f.path)
    })
  }

  function resetFile(path) {
    const f = files.value.find(x => x.path === path)
    if (f && !f.applied && !f.lifecycleResolved) {
      f.status = 'pending'
      f.modified = f.proposed
      f.error = null
    }
  }

  function updateBatchContent(path, content) {
    const file = files.value.find(file => file.path === path)
    if (file?.status === 'pending' && !file.applied) file.modified = content
  }

  function resolveBatchFile(path, content) {
    const file = files.value.find(file => file.path === path)
    if (!file || file.status !== 'pending' || file.applied) return false
    updateBatchContent(path, content)
    if (content === file.original) rejectFile(path)
    else acceptFile(path)
    return true
  }

  function markFileApplied(path) {
    const f = files.value.find(x => x.path === path)
    if (f) {
      f.applied = true
      f.error = null
    }
  }

  function markFileLifecycleResolved(path) {
    const f = files.value.find(x => x.path === path)
    if (f) {
      f.lifecycleResolved = true
      f.error = null
    }
  }

  function markFileFailed(path, error) {
    const f = files.value.find(x => x.path === path)
    if (f) {
      f.status = 'pending'
      f.error = String(error || 'Could not apply this file.')
    }
  }

  function focusBatchFile(path) {
    const file = files.value.find(f => f.path === path)
    if (file) {
      originalContent.value = file.original
      modifiedContent.value = file.modified
      filePath.value = file.path
      focusedFile.value = file.path
      viewMode.value = 'diff'
      chunkCount.value = 0
      currentChunk.value = 0
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
  }

  function prevChunk() {
    if (chunkCount.value === 0) return
    currentChunk.value = (currentChunk.value - 1 + chunkCount.value) % chunkCount.value
  }

  return {
    active, mode, isBatch,
    originalContent, modifiedContent, filePath, fileId,
    proposalIds, batchId, reviewMeta, reviewError, decision,
    focusedFile, isBatchFileFocused,
    files, pendingFiles, resolvedCount, allResolved,
    viewMode, layout, chunkCount, currentChunk, hasChunks,
    activate, activateBatch, deactivate,
    acceptFile, rejectFile, acceptAllFiles, rejectAllFiles, resetFile,
    updateBatchContent, resolveBatchFile,
    markFileApplied, markFileLifecycleResolved, markFileFailed,
    focusBatchFile, clearBatchFocus,
    setViewMode, setLayout, setReviewError,
    setChunkCount, nextChunk, prevChunk,
  }
})
