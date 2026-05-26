import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDiffStore } from './diff.js'

describe('diff store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts inactive with default state', () => {
    const store = useDiffStore()

    expect(store.active).toBe(false)
    expect(store.originalContent).toBe('')
    expect(store.modifiedContent).toBe('')
    expect(store.filePath).toBe('')
    expect(store.proposalIds).toEqual([])
    expect(store.batchId).toBeNull()
    expect(store.viewMode).toBe('diff')
    expect(store.layout).toBe('unified')
    expect(store.chunkCount).toBe(0)
    expect(store.currentChunk).toBe(0)
    expect(store.hasChunks).toBe(false)
  })

  it('activate sets all fields and marks active', () => {
    const store = useDiffStore()

    store.activate({
      original: 'before',
      modified: 'after',
      path: '/test.md',
      proposals: ['p1', 'p2'],
      batch: 'b1',
    })

    expect(store.active).toBe(true)
    expect(store.originalContent).toBe('before')
    expect(store.modifiedContent).toBe('after')
    expect(store.filePath).toBe('/test.md')
    expect(store.proposalIds).toEqual(['p1', 'p2'])
    expect(store.batchId).toBe('b1')
    expect(store.viewMode).toBe('diff')
    expect(store.layout).toBe('unified')
  })

  it('activate resets viewMode and chunks', () => {
    const store = useDiffStore()

    store.activate({ original: 'a', modified: 'b' })
    store.setViewMode('result')
    store.setChunkCount(5)
    store.nextChunk()

    store.activate({ original: 'x', modified: 'y' })
    expect(store.viewMode).toBe('diff')
    expect(store.chunkCount).toBe(0)
    expect(store.currentChunk).toBe(0)
  })

  it('deactivate clears everything', () => {
    const store = useDiffStore()

    store.activate({
      original: 'before',
      modified: 'after',
      path: '/test.md',
      proposals: ['p1'],
      batch: 'b1',
    })
    store.setChunkCount(3)
    store.nextChunk()

    store.deactivate()

    expect(store.active).toBe(false)
    expect(store.originalContent).toBe('')
    expect(store.modifiedContent).toBe('')
    expect(store.filePath).toBe('')
    expect(store.proposalIds).toEqual([])
    expect(store.batchId).toBeNull()
    expect(store.chunkCount).toBe(0)
    expect(store.currentChunk).toBe(0)
  })

  it('setViewMode accepts valid modes', () => {
    const store = useDiffStore()

    store.setViewMode('original')
    expect(store.viewMode).toBe('original')

    store.setViewMode('diff')
    expect(store.viewMode).toBe('diff')

    store.setViewMode('result')
    expect(store.viewMode).toBe('result')
  })

  it('setViewMode rejects invalid modes', () => {
    const store = useDiffStore()

    store.setViewMode('bogus')
    expect(store.viewMode).toBe('diff')
  })

  it('setLayout accepts valid layouts', () => {
    const store = useDiffStore()

    store.setLayout('split')
    expect(store.layout).toBe('split')

    store.setLayout('unified')
    expect(store.layout).toBe('unified')
  })

  it('setLayout rejects invalid layouts', () => {
    const store = useDiffStore()

    store.setLayout('side-by-side')
    expect(store.layout).toBe('unified')
  })

  it('chunk navigation cycles around', () => {
    const store = useDiffStore()

    store.setChunkCount(4)
    expect(store.chunkCount).toBe(4)
    expect(store.hasChunks).toBe(true)

    store.nextChunk()
    expect(store.currentChunk).toBe(1)

    store.nextChunk()
    store.nextChunk()
    expect(store.currentChunk).toBe(3)

    store.nextChunk()
    expect(store.currentChunk).toBe(0)

    store.prevChunk()
    expect(store.currentChunk).toBe(3)
  })

  it('setChunkCount clamps currentChunk if out of range', () => {
    const store = useDiffStore()

    store.setChunkCount(5)
    store.nextChunk()
    store.nextChunk()
    store.nextChunk()
    expect(store.currentChunk).toBe(3)

    store.setChunkCount(2)
    expect(store.currentChunk).toBe(1)
  })

  it('setChunkCount to 0 resets currentChunk', () => {
    const store = useDiffStore()

    store.setChunkCount(3)
    store.nextChunk()
    expect(store.currentChunk).toBe(1)

    store.setChunkCount(0)
    expect(store.currentChunk).toBe(0)
    expect(store.hasChunks).toBe(false)
  })

  it('activate with minimal args uses defaults', () => {
    const store = useDiffStore()

    store.activate({ original: 'a', modified: 'b' })

    expect(store.active).toBe(true)
    expect(store.filePath).toBe('')
    expect(store.proposalIds).toEqual([])
    expect(store.batchId).toBeNull()
  })

  // ── Batch mode ──

  it('activateBatch sets batch mode with files', () => {
    const store = useDiffStore()

    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old-a', modified: 'new-a', proposalId: 'p1' },
        { path: 'b.js', original: 'old-b', modified: 'new-b', proposalId: 'p2' },
      ],
      batch: 'batch-1',
    })

    expect(store.active).toBe(true)
    expect(store.mode).toBe('batch')
    expect(store.isBatch).toBe(true)
    expect(store.files).toHaveLength(2)
    expect(store.files[0].path).toBe('a.md')
    expect(store.files[0].status).toBe('pending')
    expect(store.batchId).toBe('batch-1')
  })

  it('acceptFile marks a file as accepted', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
      ],
    })

    store.acceptFile('a.md')
    expect(store.files[0].status).toBe('accepted')
    expect(store.files[1].status).toBe('pending')
  })

  it('rejectFile marks a file as rejected', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [{ path: 'a.md', original: '', modified: '' }],
    })

    store.rejectFile('a.md')
    expect(store.files[0].status).toBe('rejected')
  })

  it('acceptAllFiles marks all files as accepted', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
      ],
    })

    store.acceptAllFiles()
    expect(store.files.every(f => f.status === 'accepted')).toBe(true)
  })

  it('rejectAllFiles marks all files as rejected', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
      ],
    })

    store.rejectAllFiles()
    expect(store.files.every(f => f.status === 'rejected')).toBe(true)
  })

  it('pendingFiles returns only pending files', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
        { path: 'c.ts', original: '', modified: '' },
      ],
    })

    store.acceptFile('a.md')
    store.rejectFile('b.js')
    expect(store.pendingFiles).toHaveLength(1)
    expect(store.pendingFiles[0].path).toBe('c.ts')
  })

  it('allResolved is true when no pending files remain', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
      ],
    })

    expect(store.allResolved).toBe(false)

    store.acceptFile('a.md')
    expect(store.allResolved).toBe(false)

    store.rejectFile('b.js')
    expect(store.allResolved).toBe(true)
  })

  it('resolvedCount tracks accepted + rejected', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: '', modified: '' },
        { path: 'b.js', original: '', modified: '' },
        { path: 'c.ts', original: '', modified: '' },
      ],
    })

    expect(store.resolvedCount).toBe(0)
    store.acceptFile('a.md')
    expect(store.resolvedCount).toBe(1)
    store.rejectFile('c.ts')
    expect(store.resolvedCount).toBe(2)
  })

  it('deactivate clears batch state', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [{ path: 'a.md', original: '', modified: '' }],
    })

    store.deactivate()
    expect(store.mode).toBe('single')
    expect(store.files).toEqual([])
    expect(store.isBatch).toBe(false)
  })

  // ── activateBatch with sessionId (proposal_respond) ──

  it('activateBatch sets reviewMeta with sessionId when provided', () => {
    const store = useDiffStore()

    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old', modified: 'new', proposalId: 'p1' },
      ],
      batch: 'b1',
      sessionId: 'sess-42',
    })

    expect(store.reviewMeta).toEqual({ sessionId: 'sess-42' })
  })

  it('activateBatch sets reviewMeta to null when no sessionId', () => {
    const store = useDiffStore()

    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old', modified: 'new', proposalId: 'p1' },
      ],
      batch: 'b1',
    })

    expect(store.reviewMeta).toBeNull()
  })

  it('activateBatch preserves proposalId on each file', () => {
    const store = useDiffStore()

    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old-a', modified: 'new-a', proposalId: 'p1' },
        { path: 'b.js', original: 'old-b', modified: 'new-b', proposalId: 'p2' },
        { path: 'c.ts', original: 'old-c', modified: 'new-c' },
      ],
      sessionId: 'sess-99',
    })

    expect(store.files[0].proposalId).toBe('p1')
    expect(store.files[1].proposalId).toBe('p2')
    expect(store.files[2].proposalId).toBeNull()
  })

  // ── Batch file focus ──

  it('focusBatchFile populates single-file fields from batch data', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old-a', modified: 'new-a', proposalId: 'p1' },
        { path: 'b.js', original: 'old-b', modified: 'new-b', proposalId: 'p2' },
      ],
    })

    const found = store.focusBatchFile('b.js')
    expect(found).toBe(true)
    expect(store.originalContent).toBe('old-b')
    expect(store.modifiedContent).toBe('new-b')
    expect(store.filePath).toBe('b.js')
    expect(store.focusedFile).toBe('b.js')
    expect(store.isBatchFileFocused).toBe(true)
    expect(store.isBatch).toBe(true)
  })

  it('focusBatchFile returns false and clears for non-batch file', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [{ path: 'a.md', original: 'old', modified: 'new' }],
    })

    const found = store.focusBatchFile('unknown.ts')
    expect(found).toBe(false)
    expect(store.originalContent).toBe('')
    expect(store.modifiedContent).toBe('')
    expect(store.focusedFile).toBeNull()
    expect(store.isBatchFileFocused).toBe(false)
  })

  it('clearBatchFocus resets single-file fields but keeps batch active', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [{ path: 'a.md', original: 'old', modified: 'new' }],
    })
    store.focusBatchFile('a.md')

    store.clearBatchFocus()
    expect(store.focusedFile).toBeNull()
    expect(store.isBatchFileFocused).toBe(false)
    expect(store.originalContent).toBe('')
    expect(store.modifiedContent).toBe('')
    expect(store.active).toBe(true)
    expect(store.isBatch).toBe(true)
  })

  it('isBatchFileFocused is false in single mode', () => {
    const store = useDiffStore()
    store.activate({ original: 'a', modified: 'b', path: '/test.md' })
    expect(store.isBatchFileFocused).toBe(false)
  })

  it('deactivate clears focusedFile', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [{ path: 'a.md', original: 'old', modified: 'new' }],
    })
    store.focusBatchFile('a.md')

    store.deactivate()
    expect(store.focusedFile).toBeNull()
    expect(store.isBatchFileFocused).toBe(false)
  })

  it('focusBatchFile resets viewMode and chunks', () => {
    const store = useDiffStore()
    store.activateBatch({
      fileList: [
        { path: 'a.md', original: 'old-a', modified: 'new-a' },
        { path: 'b.js', original: 'old-b', modified: 'new-b' },
      ],
    })
    store.focusBatchFile('a.md')
    store.setViewMode('result')
    store.setChunkCount(3)
    store.nextChunk()

    store.focusBatchFile('b.js')
    expect(store.viewMode).toBe('diff')
    expect(store.chunkCount).toBe(0)
    expect(store.currentChunk).toBe(0)
  })
})
