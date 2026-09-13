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

  it('refuses a single-file response while Graph Details is active', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    diffStore.activate({ original: 'old text', modified: 'new text', path: '/doc.md', review: { id: 'p1' } })
    currentFile.value.kind = 'graph'
    expect(() => review.activateDiffForCurrentFile('old text', 'new text')).toThrow('Open Source')
    await expect(review.onDiffAcceptAll()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Open Source') })
    expect(currentFile.value.content).toBe('old text')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('saves an unopened Graph batch source through its native revision gate', async () => {
    const { diffStore, review } = makeReviewHarness()
    diffStore.activateBatch({ fileList: [{ path: '/graph/item.md', original: 'old', modified: 'new', proposalId: 'p1' }] })
    diffStore.acceptAllFiles()
    invoke.mockImplementation(async command => command === 'graph_source'
      ? { content: 'old', sourceRevision: 'revision-1' }
      : undefined)

    await expect(review.onBatchAllResolved()).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('graph_source_save', {
      request: { path: '/graph/item.md', content: 'new', expectedRevision: 'revision-1' },
    })
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
  })

  it('retains native Graph identity from review creation when the source is later unmounted', async () => {
    const { diffStore, review } = makeReviewHarness()
    invoke.mockImplementation(async command => command === 'graph_source'
      ? { content: 'old', sourceRevision: 'revision-1' }
      : undefined)
    await review.activateBatchDiff([{ path: '/graph/item.md', original: 'old', modified: 'new', proposalId: 'p1' }])
    expect(diffStore.files[0].graphSourceRevision).toBe('revision-1')
    invoke.mockReset().mockResolvedValue(null)
    diffStore.acceptAllFiles()

    await expect(review.onBatchAllResolved()).resolves.toMatchObject({ ok: false })
    expect(diffStore.files[0].error).toContain('unavailable')
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', expect.anything())
  })

  it('guards Graph close throughout a pending single review decision and buffer update', async () => {
    const { diffStore, currentFile, fileManager, review } = makeReviewHarness()
    const file = currentFile.value
    file.kind = 'text'
    file.graph = { sourceRevision: 'r1' }
    diffStore.activate({ original: 'old text', modified: 'new text', path: file.path, review: { id: 'p1' } })
    let finish
    invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    fileManager.markDirty.mockImplementation(target => {
      expect(target.reviewPending).toBe(true)
      target.dirty = true
    })
    const decision = review.onDiffAcceptAll()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(file.reviewPending).toBe(true)
    finish()
    await expect(decision).resolves.toEqual({ ok: true })
    expect(file).toMatchObject({ content: 'new text', dirty: true, reviewPending: false })
  })

  it('releases the Graph close guard when reporting fails', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    currentFile.value.graph = { sourceRevision: 'r1' }
    diffStore.activate({ original: 'old text', modified: 'new text', path: '/doc.md', review: { id: 'p1' } })
    invoke.mockRejectedValue(new Error('Registry offline'))
    await expect(review.onDiffAcceptAll()).resolves.toMatchObject({ ok: false })
    expect(currentFile.value.reviewPending).toBe(false)
    expect(currentFile.value.content).toBe('old text')
  })

  it('keeps a conflicting unopened Graph batch source pending without a generic write fallback', async () => {
    const { diffStore, review } = makeReviewHarness()
    diffStore.activateBatch({ fileList: [{ path: '/graph/item.md', original: 'old', modified: 'new', proposalId: 'p1' }] })
    diffStore.acceptAllFiles()
    invoke.mockImplementation(async command => {
      if (command === 'graph_source') return { content: 'old', sourceRevision: 'revision-1' }
      if (command === 'graph_source_save') throw new Error('Graph source changed on disk')
    })

    await expect(review.onBatchAllResolved()).resolves.toMatchObject({ ok: false })
    expect(diffStore.files[0]).toMatchObject({ status: 'pending', error: 'Graph source changed on disk' })
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('proposal_respond', expect.anything())
  })

  it.each([
    { kind: 'graph', dirty: true, unavailable: false },
    { kind: 'text', dirty: false, unavailable: true },
  ])('protects an open Graph draft or unavailable source: %j', async state => {
    const { diffStore, fileManager, review } = makeReviewHarness()
    const target = { id: 8, path: '/graph/item.md', content: 'old', ...state, graph: { sourceRevision: 'old', unavailable: state.unavailable } }
    fileManager.openFiles.push(target)
    fileManager.save = vi.fn()
    fileManager.setGraphView = vi.fn()
    diffStore.activateBatch({ fileList: [{ path: target.path, original: 'old', modified: 'new', proposalId: 'p1' }] })
    diffStore.acceptAllFiles()

    await expect(review.onBatchAllResolved()).resolves.toMatchObject({ ok: false })
    expect(target.content).toBe('old')
    expect(fileManager.save).not.toHaveBeenCalled()
    expect(fileManager.setGraphView).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses the open Graph save queue and preserves edits made during its write', async () => {
    const { diffStore, fileManager, review } = makeReviewHarness()
    const target = { id: 8, path: '/graph/item.md', kind: 'text', content: 'old', dirty: false, graph: { sourceRevision: 'old' } }
    fileManager.openFiles.push(target)
    fileManager.markDirty.mockImplementation(file => { file.dirty = true })
    fileManager.save = vi.fn(async file => {
      expect(file.content).toBe('new')
      file.content = 'edit during save'
      file.graph.sourceRevision = 'new revision'
      return false
    })
    diffStore.activateBatch({ fileList: [{ path: target.path, original: 'old', modified: 'new', proposalId: 'p1' }] })
    diffStore.acceptAllFiles()

    await expect(review.onBatchAllResolved()).resolves.toEqual({ ok: true })
    expect(fileManager.save).toHaveBeenCalledWith(target)
    expect(target).toMatchObject({ content: 'edit during save', dirty: true, graph: { sourceRevision: 'new revision' } })
    expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
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

  it('applies the snapshotted content when the store deactivates during accept', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })
    // The proposals-changed broadcast follows proposal_respond and can clear
    // the diff store before the invoke promise resolves. The applied content
    // must come from the pre-await snapshot, never from the reset store.
    invoke.mockImplementation(async (command) => {
      if (command === 'proposal_respond') diffStore.deactivate()
      return undefined
    })

    const result = await review.onDiffAcceptAll()

    expect(result).toEqual({ ok: true })
    expect(currentFile.value.content).toBe('new text')
  })

  it('restores the snapshotted original when the store deactivates during reject', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    currentFile.value.content = 'edited text'
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })
    invoke.mockImplementation(async (command) => {
      if (command === 'proposal_respond') diffStore.deactivate()
      return undefined
    })

    const result = await review.onDiffRejectAll()

    expect(result).toEqual({ ok: true })
    expect(currentFile.value.content).toBe('old text')
  })

  it('resolves proposal chunk decisions and applies the resolved content', async () => {
    const { diffStore, currentFile, review } = makeReviewHarness()
    diffStore.activate({
      original: 'old text',
      modified: 'new text',
      path: '/doc.md',
      review: { id: 'p1', sessionId: 's1', path: '/doc.md' },
    })
    invoke.mockImplementation(async (command) => {
      if (command === 'proposal_respond') diffStore.deactivate()
      return undefined
    })

    const result = await review.onDiffChunksResolved('partially resolved text')

    expect(result).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p1', status: 'applied' }),
    })
    expect(currentFile.value.content).toBe('partially resolved text')
  })

  it('reports every batch proposal even when the store deactivates mid-loop', async () => {
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
    // The first proposal_respond triggers the proposals-changed broadcast,
    // which can deactivate the store and empty its file list mid-loop. The
    // second proposal must still receive its lifecycle report.
    invoke.mockImplementation(async (command) => {
      if (command === 'read_text_file') return { content: 'other old' }
      if (command === 'proposal_respond') diffStore.deactivate()
      return undefined
    })

    const result = await review.onBatchAllResolved()

    expect(result).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p-active', status: 'applied' }),
    })
    expect(invoke).toHaveBeenCalledWith('proposal_respond', {
      result: expect.objectContaining({ id: 'p-other', status: 'applied' }),
    })
    expect(currentFile.value.content).toBe('active new')
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
