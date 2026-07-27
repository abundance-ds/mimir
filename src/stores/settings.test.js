import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings.js'

// happy-dom localStorage is incomplete — provide a working mock
const storage = new Map()
const localStorageMock = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

describe('settings store', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ── Defaults & Computed ──

  it('initializes all settings with correct defaults', () => {
    const store = useSettingsStore()

    expect(store.workbenchZoom).toBe(100)
    expect(store.editorFontFamily).toBe('mono')
    expect(store.editorFontSize).toBe(16)
    expect(store.editorTheme).toBe('parchment')
    expect(store.editorWordWrap).toBe(true)
    expect(store.editorLineNumbers).toBe(false)
    expect(store.editorAutoSave).toBe(true)
    expect(store.editorSpellCheck).toBe(false)
    expect(store.editorToolbarMode).toBe('top')
    expect(store.editorLivePreview).toBe(true)
    expect(store.aiGhostSuggestions).toBe(true)
    expect(store.aiGhostModel).toBe('auto')
    expect(store.aiInlineRewrite).toBe(true)
    expect(store.mimWorkspaceFolder).toBe('')
    expect(store.mimTeamGraphFolder).toBe('')
    expect(store.sidebarToolOrder).toEqual([])
    expect(store.sidebarNewActivityOrder).toEqual([])
    expect(store.businessGraphViewState).toEqual({
      section: 'work',
      sectionViews: {
        work: 'board',
        projects: 'portfolio',
        knowledge: 'list',
        all: 'list',
      },
      work: {
        groupBy: 'status',
        sortBy: 'priority',
        priority: '',
        visibleStatuses: ['backlog', 'plan', 'in-progress', 'waiting', 'review', 'done'],
      },
    })
    expect(store.recentWorkspaceFolders).toEqual([])
    expect(store.workbenchFileFavorites).toEqual({})
    expect(store.workbenchLayout).toEqual({
      sidebar: { state: 'expanded', width: 240 },
      activity: { state: 'expanded', width: 560 },
      editor: { state: 'expanded', width: 520 },
      activeActivityId: 'files',
    })
    expect(store.exportFormat).toBeUndefined()
    expect(store.telemetryEnabled).toBeUndefined()
    expect(store.aiApprovalMode).toBeUndefined()
  })

  it('clamps workbenchZoom writes to the supported range', () => {
    const store = useSettingsStore()
    store.set('workbenchZoom', 9000)
    expect(store.workbenchZoom).toBe(200)
    store.set('workbenchZoom', 5)
    expect(store.workbenchZoom).toBe(50)
    store.set('workbenchZoom', 'nonsense')
    expect(store.workbenchZoom).toBe(100)
  })

  it('normalizes persisted workbenchZoom during load', async () => {
    storage.set('mim:editor:settings:v1', JSON.stringify({ workbenchZoom: 5 }))
    const store = useSettingsStore()
    await store.load()
    expect(store.workbenchZoom).toBe(50)
  })

  it('isDarkTheme returns true for dark themes', () => {
    const store = useSettingsStore()
    store.set('editorTheme', 'slate')
    expect(store.isDarkTheme).toBe(true)
    store.set('editorTheme', 'monokai')
    expect(store.isDarkTheme).toBe(true)
  })

  it('isDarkTheme returns false for light themes', () => {
    const store = useSettingsStore()
    store.set('editorTheme', 'parchment')
    expect(store.isDarkTheme).toBe(false)
    store.set('editorTheme', 'glacier')
    expect(store.isDarkTheme).toBe(false)
  })

  it('settingsReady is true after initial load completes', async () => {
    const store = useSettingsStore()
    await Promise.resolve()
    expect(store.settingsReady).toBe(true)
  })

  it('deduplicates concurrent startup loads', async () => {
    const getItem = vi.spyOn(localStorageMock, 'getItem')
    const store = useSettingsStore()

    await Promise.all([store.load(), store.load()])

    expect(getItem).toHaveBeenCalledTimes(1)
  })

  // ── set() ──

  it('set() updates the setting value', () => {
    const store = useSettingsStore()
    expect(store.editorFontSize).toBe(16)
    store.set('editorFontSize', 18)
    expect(store.editorFontSize).toBe(18)
  })

  it('set() ignores unknown keys', () => {
    const store = useSettingsStore()
    store.set('nonExistentSetting', 'value')
    expect(store.nonExistentSetting).toBeUndefined()
  })

  it('set() works for array settings', () => {
    const store = useSettingsStore()
    store.set('recentAppIds', ['one', 'two'])
    expect(store.recentAppIds).toEqual(['one', 'two'])
  })

  it('clones persisted business graph view state instead of retaining caller references', () => {
    const store = useSettingsStore()
    const state = {
      section: 'projects',
      sectionViews: { projects: 'graph' },
      work: { visibleStatuses: ['plan'] },
    }

    store.set('businessGraphViewState', state)
    state.sectionViews.projects = 'list'
    state.work.visibleStatuses.push('done')

    expect(store.businessGraphViewState.sectionViews.projects).toBe('graph')
    expect(store.businessGraphViewState.work.visibleStatuses).toEqual(['plan'])
  })

  it('keeps all shell persistence in one detached workbench object', () => {
    const store = useSettingsStore()
    const layout = {
      sidebar: { state: 'rail', width: 300 },
      activity: { state: 'expanded', width: 620 },
      editor: { state: 'expanded', width: 480 },
      activeActivityId: 'agent:review',
    }
    store.set('workbenchLayout', layout)
    layout.sidebar.width = 1

    expect(store.workbenchLayout.sidebar.width).toBe(300)
    expect(store.workbenchLayout.activeActivityId).toBe('agent:review')
  })

  // ── Debounced save ──

  it('set() triggers debounced save to localStorage', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.load()

    const setItemSpy = vi.spyOn(localStorageMock, 'setItem')
    store.set('editorFontSize', 16)

    expect(setItemSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(setItemSpy).toHaveBeenCalled()
    const persisted = JSON.parse(storage.get('mim:editor:settings:v1'))
    expect(persisted.editorFontSize).toBe(16)
  })

  it('multiple rapid set() calls debounce to a single save', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.load()

    const setItemSpy = vi.spyOn(localStorageMock, 'setItem')
    store.set('editorFontSize', 14)
    store.set('editorFontSize', 16)
    store.set('editorFontSize', 18)

    await vi.advanceTimersByTimeAsync(300)
    expect(setItemSpy).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(storage.get('mim:editor:settings:v1'))
    expect(persisted.editorFontSize).toBe(18)
  })

  // ── load() must not trigger save (the bug we fixed) ──

  it('load() does not trigger save', async () => {
    vi.useFakeTimers()

    storage.set('mim:editor:settings:v1', JSON.stringify({
      editorFontSize: 20,
      editorTheme: 'monokai',
    }))

    const store = useSettingsStore()
    const saveSpy = vi.spyOn(store, 'save')
    await store.load()

    expect(store.editorFontSize).toBe(20)
    expect(store.editorTheme).toBe('monokai')

    await vi.advanceTimersByTimeAsync(500)
    expect(saveSpy).not.toHaveBeenCalled()
  })

  // ── load() correctness ──

  it('load() applies saved values over defaults', async () => {
    storage.set('mim:editor:settings:v1', JSON.stringify({
      editorFontSize: 16,
      editorWordWrap: false,
      editorTheme: 'slate',
    }))

    const store = useSettingsStore()
    await store.load()

    expect(store.editorFontSize).toBe(16)
    expect(store.editorWordWrap).toBe(false)
    expect(store.editorTheme).toBe('slate')
    expect(store.editorFontFamily).toBe('mono')
  })

  it('load() tolerates empty localStorage', async () => {
    const store = useSettingsStore()
    await store.load()
    expect(store.editorFontSize).toBe(16)
    expect(store.settingsReady).toBe(true)
  })

  it('load() tolerates corrupt localStorage', async () => {
    storage.set('mim:editor:settings:v1', 'not json')
    const store = useSettingsStore()
    await store.load()
    expect(store.editorFontSize).toBe(16)
    expect(store.settingsReady).toBe(true)
  })

  // ── save() ──

  it('save() persists current values to localStorage', async () => {
    const store = useSettingsStore()
    await Promise.resolve()

    store.set('editorFontSize', 22)
    await store.save()

    const raw = JSON.parse(storage.get('mim:editor:settings:v1'))
    expect(raw.editorFontSize).toBe(22)
  })

  // ── Round-trip ──

  it('set → save → load preserves values', async () => {
    const store = useSettingsStore()
    await Promise.resolve()

    store.set('editorTheme', 'monokai')
    store.set('editorFontSize', 18)
    store.set('editorWordWrap', false)
    await store.save()

    store.set('editorTheme', 'parchment')
    store.set('editorFontSize', 12)
    store.set('editorWordWrap', true)

    await store.load()
    expect(store.editorTheme).toBe('monokai')
    expect(store.editorFontSize).toBe(18)
    expect(store.editorWordWrap).toBe(false)
  })

  it('set() before settingsReady does not schedule save', async () => {
    vi.useFakeTimers()

    const store = useSettingsStore()
    // settingsReady is false until load() resolves
    const saveSpy = vi.spyOn(store, 'save')
    store.set('editorFontSize', 20)

    expect(store.editorFontSize).toBe(20)
    await vi.advanceTimersByTimeAsync(500)
    expect(saveSpy).not.toHaveBeenCalled()
  })
})
