import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createMimChatTransport: vi.fn() }))
vi.mock('../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('../../services/ai/modelControls', () => ({
  controlForModel: () => ({ id: '', label: '', options: [] }),
  defaultControlId: () => '',
  modelDisplayName: () => '',
  modelMenuItems: () => [],
  normalizeModelId: (id) => id || null,
  providerConfigured: () => false,
  resolveConcreteModel: () => 'test',
  resolveDefaultModel: () => ({ id: 'test-model' }),
}))
vi.mock('../../stores/panel/persistence', () => ({
  schedulePersist: vi.fn(),
}))

import { useSessionSearch } from './useSessionSearch.js'
import { usePanelUIStore } from '../../stores/panel/ui.js'

describe('useSessionSearch', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not search when query is less than 3 characters', async () => {
    const panelUI = usePanelUIStore()
    const { results, isSearching, searchActive } = useSessionSearch()

    panelUI.searchQuery = 'ab'
    await nextTick()
    vi.advanceTimersByTime(400)
    await nextTick()

    expect(invoke).not.toHaveBeenCalled()
    expect(searchActive.value).toBe(false)
    expect(results.value).toEqual([])
  })

  it('invokes search_sessions after 300ms debounce when query has 3+ chars', async () => {
    const panelUI = usePanelUIStore()
    invoke.mockResolvedValue([])
    const { results, searchActive } = useSessionSearch()

    panelUI.searchQuery = 'test query'
    await nextTick()

    // Should not call immediately
    expect(invoke).not.toHaveBeenCalled()

    // Advance past debounce
    vi.advanceTimersByTime(300)
    await nextTick()
    // flush the promise
    await vi.runAllTimersAsync()

    expect(invoke).toHaveBeenCalledWith('search_sessions', { query: 'test query' })
    expect(searchActive.value).toBe(true)
  })

  it('stores results from invoke response', async () => {
    const panelUI = usePanelUIStore()
    const mockResults = [
      {
        session_id: 'sess-1',
        project_id: 'proj-1',
        label: 'Chat about Rust',
        archived: false,
        match_text: '...building a search feature in Rust...',
        message_index: 3,
      },
      {
        session_id: 'sess-2',
        project_id: 'proj-1',
        label: 'Old discussion',
        archived: true,
        match_text: '...the Rust compiler optimizes...',
        message_index: 7,
      },
    ]
    invoke.mockResolvedValue(mockResults)
    const { results } = useSessionSearch()

    panelUI.searchQuery = 'Rust'
    await nextTick()
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()

    expect(results.value).toHaveLength(2)
    expect(results.value[0].session_id).toBe('sess-1')
    expect(results.value[1].archived).toBe(true)
  })

  it('clears results when query is cleared', async () => {
    const panelUI = usePanelUIStore()
    invoke.mockResolvedValue([{ session_id: 'sess-1', project_id: 'p1', label: 'X', archived: false, match_text: '...x...', message_index: 0 }])
    const { results, searchActive } = useSessionSearch()

    panelUI.searchQuery = 'something'
    await nextTick()
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()
    expect(results.value).toHaveLength(1)

    panelUI.searchQuery = ''
    await nextTick()
    vi.advanceTimersByTime(300)
    await nextTick()

    expect(results.value).toEqual([])
    expect(searchActive.value).toBe(false)
  })

  it('debounces rapid changes — only last query fires', async () => {
    const panelUI = usePanelUIStore()
    invoke.mockResolvedValue([])
    const { results } = useSessionSearch()

    panelUI.searchQuery = 'fir'
    await nextTick()
    vi.advanceTimersByTime(100)

    panelUI.searchQuery = 'first'
    await nextTick()
    vi.advanceTimersByTime(100)

    panelUI.searchQuery = 'final query'
    await nextTick()
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('search_sessions', { query: 'final query' })
  })

  it('groups results by project_id', async () => {
    const panelUI = usePanelUIStore()
    invoke.mockResolvedValue([
      { session_id: 's1', project_id: 'proj-a', label: 'A1', archived: false, match_text: '...a...', message_index: 0 },
      { session_id: 's2', project_id: 'proj-b', label: 'B1', archived: false, match_text: '...b...', message_index: 0 },
      { session_id: 's3', project_id: 'proj-a', label: 'A2', archived: false, match_text: '...a2...', message_index: 1 },
    ])
    const { resultsByProject } = useSessionSearch()

    panelUI.searchQuery = 'test'
    await nextTick()
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()

    expect(resultsByProject.value['proj-a']).toHaveLength(2)
    expect(resultsByProject.value['proj-b']).toHaveLength(1)
  })

  it('sets isSearching true during invoke and false after', async () => {
    const panelUI = usePanelUIStore()
    let resolveInvoke
    invoke.mockReturnValue(new Promise((resolve) => { resolveInvoke = resolve }))
    const { isSearching } = useSessionSearch()

    panelUI.searchQuery = 'loading test'
    await nextTick()
    vi.advanceTimersByTime(300)
    await nextTick()

    expect(isSearching.value).toBe(true)

    resolveInvoke([])
    await vi.runAllTimersAsync()

    expect(isSearching.value).toBe(false)
  })

  it('handles invoke errors gracefully', async () => {
    const panelUI = usePanelUIStore()
    invoke.mockRejectedValue(new Error('backend failed'))
    const { results, isSearching, searchActive } = useSessionSearch()

    panelUI.searchQuery = 'error test'
    await nextTick()
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()

    expect(results.value).toEqual([])
    expect(isSearching.value).toBe(false)
    // searchActive remains true because query is still present
    expect(searchActive.value).toBe(true)
  })
})
