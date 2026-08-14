import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useDiffStore } from '../../stores/diff.js'
import { proposalIdsFromReviewMeta, useDiffReview } from './useDiffReview.js'

function makeReviewHarness() {
  const diffStore = useDiffStore()
  const currentFile = ref({
    id: 7,
    path: '/doc.md',
    content: 'old text',
    reviews: [{ proposalId: 'p1' }],
  })
  const fileManager = {
    openFiles: [currentFile.value],
    markDirty: vi.fn(),
    clearFileReviews: vi.fn((file) => { if (file) file.reviews = null }),
  }
  const review = useDiffReview({
    diffStore,
    fileManager,
    currentFile,
    reviewTabActive: ref(false),
    inlineAIState: ref(null),
    restoreConfirmMeta: ref(null),
    diffViewRef: ref(null),
    batchDiffViewRef: ref(null),
    scheduleContentSync: vi.fn(),
    flushEditorContent: vi.fn(),
  })
  return { diffStore, currentFile, fileManager, review }
}

describe('useDiffReview proposal responses', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
  })

  it('normalizes single-id and multi-id review metadata', () => {
    expect(proposalIdsFromReviewMeta({ id: 'p1' })).toEqual(['p1'])
    expect(proposalIdsFromReviewMeta({ ids: ['p1', '', 'p2'] })).toEqual(['p1', 'p2'])
    expect(proposalIdsFromReviewMeta(null)).toEqual([])
  })

  it('binds a new single-file review to the active tab id', () => {
    const { diffStore, review } = makeReviewHarness()

    review.activateDiffForCurrentFile('old text', 'new text')

    expect(diffStore.fileId).toBe(7)
    expect(diffStore.filePath).toBe('/doc.md')
  })

  it('does not resolve a single-file review against another active tab', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    const target = currentFile.value
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      fileId: target.id,
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })
    currentFile.value = { id: 8, path: '/other.md', content: 'other text' }
    fileManager.openFiles.push(currentFile.value)

    const result = await review.onDiffAcceptAll()

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('another file'),
    })
    expect(target.content).toBe('old text')
    expect(currentFile.value.content).toBe('other text')
    expect(invoke).not.toHaveBeenCalled()
    expect(diffStore.active).toBe(true)
  })

  it('reports single editor accept back to the proposal lifecycle', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })

    await review.onDiffAcceptAll()

    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: {
        id: 'p1',
        sessionId: 's1',
        status: 'applied',
        detail: 'User accepted the change',
      },
    })
    expect(currentFile.value.content).toBe('new text')
    expect(fileManager.clearFileReviews).toHaveBeenCalledWith(currentFile.value)
  })

  it('reports CodeMirror chunk resolution for proposal diffs', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { ids: ['p1', 'p2'], sessionId: 's1', path: '/doc.md' },
    })

    await review.onDiffChunksResolved('new text')

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: {
        id: 'p1',
        sessionId: 's1',
        status: 'applied',
        detail: 'User accepted the change',
      },
    })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: {
        id: 'p2',
        sessionId: 's1',
        status: 'applied',
        detail: 'User accepted the change',
      },
    })
    expect(currentFile.value.reviews).toBeNull()
  })

  it('keeps a single-file review open and exposes a retryable lifecycle error', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })
    invoke.mockRejectedValue(new Error('registry offline'))

    const result = await review.onDiffRejectAll()

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('registry offline'),
    })
    expect(diffStore.active).toBe(true)
    expect(diffStore.reviewError).toContain('registry offline')
    expect(fileManager.clearFileReviews).not.toHaveBeenCalled()
    expect(currentFile.value.content).toBe('old text')
  })

  it('durably writes every accepted non-active batch file before resolving proposals', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    currentFile.value.path = '/work/active.md'
    currentFile.value.content = 'active old'
    fileManager.openFiles = [currentFile.value]
    diffStore.activateBatch({
      fileList: [
        {
          path: '/work/active.md',
          original: 'active old',
          modified: 'active new',
          proposalId: 'p-active',
        },
        {
          path: '/work/other.md',
          original: 'other old',
          modified: 'other new',
          proposalId: 'p-other',
        },
      ],
      sessionId: 's-batch',
    })
    diffStore.acceptAllFiles()
    invoke.mockImplementation(async (command, input) => {
      if (command === 'read_text_file') return { content: 'other old' }
      return undefined
    })

    const result = await review.onBatchAllResolved()

    expect(result).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('read_text_file', { path: '/work/other.md' })
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: '/work/other.md',
      content: 'other new',
    })
    const writeOrder = invoke.mock.invocationCallOrder[
      invoke.mock.calls.findIndex(call => call[0] === 'write_text_file')
    ]
    const resolveOrder = invoke.mock.invocationCallOrder[
      invoke.mock.calls.findIndex(call => call[0] === 'proposal_respond')
    ]
    expect(writeOrder).toBeLessThan(resolveOrder)
    expect(currentFile.value.content).toBe('active new')
    expect(fileManager.markDirty).toHaveBeenCalled()
    expect(diffStore.active).toBe(false)
  })

  it('keeps stale/failed batch files reviewable and never reports them applied', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    currentFile.value.path = '/work/active.md'
    fileManager.openFiles = [currentFile.value]
    diffStore.activateBatch({
      fileList: [
        {
          path: '/work/good.md',
          original: 'good old',
          modified: 'good new',
          proposalId: 'p-good',
        },
        {
          path: '/work/stale.md',
          original: 'stale old',
          modified: 'stale new',
          proposalId: 'p-stale',
        },
      ],
      sessionId: 's-batch',
    })
    diffStore.acceptAllFiles()
    invoke.mockImplementation(async (command, input) => {
      if (command === 'read_text_file') {
        return { content: input.path.endsWith('good.md') ? 'good old' : 'changed elsewhere' }
      }
      return undefined
    })

    const result = await review.onBatchAllResolved()

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([
      expect.objectContaining({
        path: '/work/stale.md',
        error: expect.stringContaining('changed after the review'),
      }),
    ])
    expect(invoke).toHaveBeenCalledWith('write_text_file', {
      path: '/work/good.md',
      content: 'good new',
    })
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      path: '/work/stale.md',
    }))
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p-good', status: 'applied' }),
    })
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p-stale', status: 'applied' }),
    })
    expect(diffStore.active).toBe(true)
    expect(diffStore.files.find(file => file.path === '/work/good.md').applied).toBe(true)
    expect(diffStore.files.find(file => file.path === '/work/stale.md').status).toBe('pending')
  })

  it('keeps an applied file retryable when only proposal lifecycle reporting fails', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    currentFile.value.path = '/work/active.md'
    fileManager.openFiles = [currentFile.value]
    diffStore.activateBatch({
      fileList: [{
        path: '/work/other.md',
        original: 'old',
        modified: 'new',
        proposalId: 'p-other',
      }],
      sessionId: 's-batch',
    })
    diffStore.acceptAllFiles()
    invoke.mockImplementation(async command => {
      if (command === 'read_text_file') return { content: 'old' }
      if (command === 'proposal_respond') throw new Error('registry unavailable')
      return undefined
    })

    const result = await review.onBatchAllResolved()
    const file = diffStore.files[0]

    expect(result.ok).toBe(false)
    expect(file.applied).toBe(true)
    expect(file.status).toBe('pending')
    expect(file.error).toContain('status could not be updated')
    expect(diffStore.active).toBe(true)

    invoke.mockClear()
    invoke.mockResolvedValue(undefined)
    diffStore.acceptFile('/work/other.md')
    await review.onBatchAllResolved()

    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p-other', status: 'applied' }),
    })
    expect(diffStore.active).toBe(false)
  })
})
