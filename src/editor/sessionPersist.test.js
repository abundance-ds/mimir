import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { createSessionPersist } from './sessionPersist.js'

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
        { path: null, content: 'untitled' },
        { path: '/b.md', content: 'b' },
      ]),
      recentFiles: ref(['/a.md', '/old.md']),
      activeFileIndex: ref(0),
      sidebarVisible: ref(true),
      activePanel: ref('outline'),
      panelOpen: ref(true),
      viewMode: ref('source'),
      zoomLevel: ref(100),
      ...overrides,
    }
  }

  it('saves after debounce when state changes', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid changes into one save', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(500)

    state.viewMode.value = 'split'
    await nextTick()
    vi.advanceTimersByTime(500)

    state.zoomLevel.value = 110
    await nextTick()
    vi.advanceTimersByTime(1000)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('snapshot includes saved files as paths and untitled files with content', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 2
    await nextTick()
    vi.advanceTimersByTime(1000)

    const snapshot = save.mock.calls[0][0]
    expect(snapshot.openFiles).toEqual([
      { path: '/a.md' },
      { path: null, content: 'untitled' },
      { path: '/b.md' },
    ])
  })

  it('omits untitled files with empty content', async () => {
    const state = makeState({
      openFiles: ref([
        { path: '/a.md', content: 'a' },
        { path: null, content: '' },
        { path: null, content: 'draft' },
      ]),
    })
    createSessionPersist(state, save)
    await nextTick()

    state.activeFileIndex.value = 1
    await nextTick()
    vi.advanceTimersByTime(1000)

    const snapshot = save.mock.calls[0][0]
    expect(snapshot.openFiles).toEqual([
      { path: '/a.md' },
      { path: null, content: 'draft' },
    ])
  })

  it('snapshot has correct shape', async () => {
    const state = makeState()
    createSessionPersist(state, save)
    await nextTick()

    state.zoomLevel.value = 150
    await nextTick()
    vi.advanceTimersByTime(1000)

    const snapshot = save.mock.calls[0][0]
    expect(snapshot).toEqual({
      openFiles: [
        { path: '/a.md' },
        { path: null, content: 'untitled' },
        { path: '/b.md' },
      ],
      recentFiles: ['/a.md', '/old.md'],
      activeFileIndex: 0,
      sidebar: { visible: true, panel: 'outline', panelOpen: true },
      viewMode: 'source',
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
})
