import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { createSessionPersist, createSessionSnapshot } from './sessionPersist.js'

describe('sessionPersist', () => {
  let save

  beforeEach(() => {
    vi.useFakeTimers()
    save = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeState(overrides = {}) {
    return {
      openFiles: ref([
        { path: '/a.md', content: 'a' },
        { path: null, content: 'untitled', draftId: 'draft-1' },
        { path: '/b.md', content: 'b' },
      ]),
      recentFiles: ref(['/a.md', '/old.md']),
      activeFileIndex: ref(0),
      zoomLevel: ref(100),
      ...overrides,
    }
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  it('saves after debounce when state changes', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await flushMicrotasks()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid changes into one save', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(500)

    state.zoomLevel.value = 110
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('snapshot includes saved files as paths and untitled files with content', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 2
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    const snapshot = save.mock.calls[0][0]
    expect(snapshot.openFiles).toEqual([
      { path: '/a.md' },
      { path: null, content: 'untitled', draftId: 'draft-1' },
      { path: '/b.md' },
    ])
  })

  it('persists dirty path-backed content for crash-safe manual-save recovery', () => {
    const state = makeState({
      openFiles: ref([
        { path: '/clean.md', content: 'on disk', dirty: false },
        { path: '/dirty.md', content: 'new unsaved text', dirty: true },
      ]),
      activeFileIndex: ref(1),
    })

    expect(createSessionSnapshot(state).openFiles).toEqual([
      { path: '/clean.md' },
      { path: '/dirty.md', content: 'new unsaved text', dirty: true },
    ])
  })

  it('persists project ownership without adding it to global files', () => {
    const state = makeState({
      openFiles: ref([
        { path: '/alpha/a.md', content: 'a', workspacePath: '/alpha' },
        { path: '/tmp/global.md', content: 'global', workspacePath: '' },
      ]),
    })

    expect(createSessionSnapshot(state).openFiles).toEqual([
      { path: '/alpha/a.md', workspacePath: '/alpha' },
      { path: '/tmp/global.md' },
    ])
  })

  it('keeps transient PDF and external previews out of the restored editor session', () => {
    const state = makeState({
      openFiles: ref([
        { path: '/notes.md', content: 'notes', kind: 'text' },
        { path: '/report.pdf', content: '', kind: 'pdf', preview: true },
        { path: '/photo.png', content: '', kind: 'external' },
        { path: '/later.md', content: 'later', kind: 'text' },
      ]),
      activeFileIndex: ref(1),
    })

    expect(createSessionSnapshot(state)).toMatchObject({
      openFiles: [
        { path: '/notes.md' },
        { path: '/later.md' },
      ],
      activeFileIndex: 1,
    })
  })

  it('does not resurrect path-backed or untitled edits explicitly discarded on quit', () => {
    const pathDraft = { path: '/dirty.md', content: 'discard me', dirty: true }
    const untitled = { path: null, content: 'discard draft', dirty: true, draftId: 'draft-x' }
    const state = makeState({
      openFiles: ref([pathDraft, untitled]),
      activeFileIndex: ref(1),
    })

    expect(createSessionSnapshot(state, {
      discardedFiles: [pathDraft, untitled],
    })).toMatchObject({
      openFiles: [{ path: '/dirty.md' }],
      activeFileIndex: 0,
    })
  })

  it('omits untitled files with empty content', async () => {
    const state = makeState({
      openFiles: ref([
        { path: '/a.md', content: 'a' },
        { path: null, content: '', draftId: 'empty' },
        { path: null, content: 'draft', draftId: 'draft-2' },
      ]),
    })
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    const snapshot = save.mock.calls[0][0]
    expect(snapshot.openFiles).toEqual([
      { path: '/a.md' },
      { path: null, content: 'draft', draftId: 'draft-2' },
    ])
    expect(snapshot.activeFileIndex).toBe(1)
  })

  it('remaps the active index when empty drafts are omitted', () => {
    const state = makeState({
      openFiles: ref([
        { path: '/a.md', content: 'a' },
        { path: null, content: '', draftId: 'empty' },
        { path: '/b.md', content: 'b' },
      ]),
      activeFileIndex: ref(1),
    })

    expect(createSessionSnapshot(state).activeFileIndex).toBe(1)
  })

  it('snapshot has correct shape', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.zoomLevel.value = 150
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    const snapshot = save.mock.calls[0][0]
    expect(snapshot).toEqual({
      openFiles: [
        { path: '/a.md' },
        { path: null, content: 'untitled', draftId: 'draft-1' },
        { path: '/b.md' },
      ],
      recentFiles: ['/a.md', '/old.md'],
      activeFileIndex: 0,
      zoomLevel: 150,
    })
  })

  it('does not save on initial setup (no spurious write)', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()
    vi.advanceTimersByTime(2000)

    expect(save).not.toHaveBeenCalled()
  })

  it('stops saving after cleanup is called', async () => {
    const state = makeState()
    const cleanup = createSessionPersist(state, save)
    await nextTick()

    cleanup()

    state.activeFileIndex.value = 2
    await nextTick()
    vi.advanceTimersByTime(1000)

    expect(save).not.toHaveBeenCalled()
  })

  it('flushes the latest pending snapshot during cleanup', async () => {
    const state = makeState()
    const cleanup = createSessionPersist(state, save)
    state.activeFileIndex.value = 2
    await nextTick()

    await cleanup()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].activeFileIndex).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('serializes writes so an older slow snapshot can never overwrite a newer flush', async () => {
    const state = makeState()
    let releaseFirst
    save
      .mockImplementationOnce(() => new Promise(resolve => {
        releaseFirst = resolve
      }))
      .mockResolvedValueOnce(undefined)
    const cleanup = createSessionPersist(state, save)

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()
    expect(save).toHaveBeenCalledTimes(1)

    state.activeFileIndex.value = 2
    await nextTick()
    const flushing = cleanup.flush()
    await flushMicrotasks()
    expect(save).toHaveBeenCalledTimes(1)

    releaseFirst()
    await flushing
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0][0].activeFileIndex).toBe(1)
    expect(save.mock.calls[1][0].activeFileIndex).toBe(2)
  })

  it('reports debounced failures without an unhandled rejection and exposes flush failures', async () => {
    const state = makeState()
    const error = new Error('session disk full')
    const onError = vi.fn()
    save.mockRejectedValue(error)
    const cleanup = createSessionPersist(state, save, { onError })

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith(error)
    expect(cleanup.lastError).toBe(error)

    await expect(cleanup.flush()).rejects.toThrow('session disk full')
  })
})
