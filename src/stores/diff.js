import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export const useDiffStore = defineStore('diff', () => {
  const active = ref(false)
  const mode = ref('single') // 'single' | 'batch'

  // Single-file state
  const originalContent = ref('')
  const modifiedContent = ref('')
  const filePath = ref('')
  const proposalIds = ref([])
  const batchId = ref(null)
  const reviewMeta = ref(null)
  const reviewError = ref('')

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

  function activate({ original, modified, path = '', proposals = [], batch = null, review = null }) {
    mode.value = 'single'
    originalContent.value = original
    modifiedContent.value = modified
    filePath.value = path
    proposalIds.value = proposals
    batchId.value = batch
    reviewMeta.value = review || null
    reviewError.value = ''
    files.value = []
    viewMode.value = 'diff'
    chunkCount.value = 0
    currentChunk.value = 0
    active.value = true
  }

  function activateBatch({ fileList, batch = null, sessionId = null }) {
    mode.value = 'batch'
    files.value = fileList.map(f => ({
      path: f.path,
      original: f.original,
      modified: f.modified,
      proposalId: f.proposalId || null,
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
    proposalIds.value = []
    focusedFile.value = null
    viewMode.value = 'diff'
    layout.value = 'unified'
    chunkCount.value = 0
    currentChunk.value = 0
    active.value = true
  }

  function deactivate() {
    active.value = false
    mode.value = 'single'
    originalContent.value = ''
    modifiedContent.value = ''
    filePath.value = ''
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
      f.status = 'accepted'
      f.error = null
    }
  }

  function rejectFile(path) {
    const f = files.value.find(x => x.path === path)
    if (f) {
      f.status = 'rejected'
      f.error = null
    }
  }

  function acceptAllFiles() {
    files.value.forEach(f => {
      f.status = 'accepted'
      f.error = null
    })
  }

  function rejectAllFiles() {
    files.value.forEach(f => {
      f.status = 'rejected'
      f.error = null
    })
  }

  function resetFile(path) {
    const f = files.value.find(x => x.path === path)
    if (f && !f.applied && !f.lifecycleResolved) {
      f.status = 'pending'
      f.error = null
    }
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
    originalContent, modifiedContent, filePath,
    proposalIds, batchId, reviewMeta, reviewError,
    focusedFile, isBatchFileFocused,
    files, pendingFiles, resolvedCount, allResolved,
    viewMode, layout, chunkCount, currentChunk, hasChunks,
    activate, activateBatch, deactivate,
    acceptFile, rejectFile, acceptAllFiles, rejectAllFiles, resetFile,
    markFileApplied, markFileLifecycleResolved, markFileFailed,
    focusBatchFile, clearBatchFocus,
    setViewMode, setLayout, setReviewError,
    setChunkCount, nextChunk, prevChunk,
  }
})
