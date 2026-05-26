import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useDiffStore } from '../../stores/diff.js'
import { proposalIdsFromReviewMeta, useDiffReview } from './useDiffReview.js'

function makeReviewHarness() {
  const diffStore = useDiffStore()
  const currentFile = ref({
    path: '/doc.md',
    content: 'old text',
    reviews: [{ proposalId: 'p1' }],
  })
  const fileManager = {
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
})
