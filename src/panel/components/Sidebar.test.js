import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'

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
  loadInitialState: vi.fn(),
}))
vi.mock('../agentsWindow', () => ({
  openOrFocusEditorWindow: vi.fn(),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: vi.fn(),
  getAllWebviewWindows: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../../services/session', () => ({
  loadSession: vi.fn(),
}))
vi.mock('../../stores/panel/apps.js', () => {
  const { ref } = require('vue')
  const _apps = ref([])
  const store = {
    apps: _apps,
    discover: vi.fn(),
    getApp: vi.fn(() => null),
    deleteApp: vi.fn(),
    trackUsage: vi.fn(),
    recentApps: ref([]),
    recentAppIds: ref([]),
  }
  return {
    useAppStore: () => store,
  }
})

import Sidebar from './Sidebar.vue'
import { usePanelUIStore } from '../../stores/panel/ui.js'
import { useProjectStore } from '../../stores/panel/projects.js'
import { useSessionStore } from '../../stores/panel/sessions.js'

function makeSession(overrides = {}) {
  return {
    id: 'sess-1',
    label: 'Test Session',
    projectId: 'general',
    modelId: 'test',
    controlId: '',
    archived: false,
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _savedMessages: [],
    proposals: [],
    usage: {},
    ...overrides,
  }
}

function factory() {
  return shallowMount(Sidebar)
}

describe('Panel Sidebar', () => {
  it('renders without error', () => {
    expect(factory().exists()).toBe(true)
  })

  it('search input is always visible', () => {
    const w = factory()
    const input = w.find('.sb-search-input')
    expect(input.exists()).toBe(true)
    expect(input.attributes('placeholder')).toContain('Search')
  })

  it('search input syncs with panelUI.searchQuery', async () => {
    const panelUI = usePanelUIStore()
    const w = factory()
    await w.find('.sb-search-input').setValue('hello')
    expect(panelUI.searchQuery).toBe('hello')
  })

  it('renders default Personal project', () => {
    const projStore = useProjectStore()
    projStore.expandProject('general')
    const w = factory()
    expect(w.text()).toContain('Personal')
  })

  it('renders custom project when added', () => {
    const projStore = useProjectStore()
    projStore.projects.push({ id: 'proj-1', name: 'My Project', workspacePath: '/tmp/test', system: false })
    projStore.expandProject('proj-1')
    const w = factory()
    expect(w.text()).toContain('My Project')
  })

  it('expands project on folder icon click', async () => {
    const projStore = useProjectStore()
    projStore.projects.push({ id: 'proj-2', name: 'Clickable', workspacePath: '/tmp', system: false })
    const w = factory()
    const toggle = w.findAll('.project-toggle').find(el => el.text().includes('Clickable'))
    expect(toggle).toBeTruthy()
    const folderBtn = toggle.find('.project-folder-btn')
    expect(folderBtn.exists()).toBe(true)
    await folderBtn.trigger('click')
    expect(projStore.projectExpanded('proj-2')).toBe(true)
  })

  it('renders sessions under expanded project', async () => {
    const projStore = useProjectStore()
    const sessionStore = useSessionStore()
    projStore.expandProject('general')
    sessionStore.sessions.push(makeSession())
    const w = factory()
    expect(w.findAll('.session-row').length).toBeGreaterThanOrEqual(1)
  })

  it('session row shows active class for active session', () => {
    const projStore = useProjectStore()
    const sessionStore = useSessionStore()
    projStore.expandProject('general')
    sessionStore.sessions.push(makeSession())
    sessionStore.activeSessionId = 'sess-1'
    const w = factory()
    const activeRow = w.find('.session-row.active')
    expect(activeRow.exists()).toBe(true)
  })

  it('collapse all button collapses projects', async () => {
    const projStore = useProjectStore()
    projStore.expandProject('general')
    expect(projStore.projectExpanded('general')).toBe(true)
    const w = factory()
    const collapseBtn = w.find('[title="Collapse all"]')
    await collapseBtn.trigger('click')
    expect(projStore.projectExpanded('general')).toBe(false)
  })

  it('shows add project menu on button click', async () => {
    const w = factory()
    const addBtn = w.findAll('.sb-icon-btn').find(b => b.attributes('title') === 'Add project')
    await addBtn.trigger('click')
    expect(w.find('.project-add-menu').exists()).toBe(true)
  })

  it('collapse all button is outside the search bar', () => {
    const w = factory()
    const toolbar = w.find('.sb-toolbar')
    const collapseBtn = w.find('.sb-collapse-btn')
    expect(toolbar.exists()).toBe(true)
    expect(collapseBtn.exists()).toBe(true)
    expect(toolbar.element.contains(collapseBtn.element)).toBe(false)
  })

  it('pinned sessions appear without header label', () => {
    const projStore = useProjectStore()
    const sessionStore = useSessionStore()
    projStore.expandProject('general')
    sessionStore.sessions.push(makeSession({ pinned: true }))
    const w = factory()
    expect(w.find('.sb-pinned-area').exists()).toBe(true)
    expect(w.text()).not.toContain('Pinned')
  })

  it('session rows have data attributes for drag', () => {
    const projStore = useProjectStore()
    const sessionStore = useSessionStore()
    projStore.expandProject('general')
    sessionStore.sessions.push(makeSession())
    const w = factory()
    const row = w.find('.session-row[data-session-id]')
    expect(row.exists()).toBe(true)
    expect(row.attributes('data-session-id')).toBe('sess-1')
    expect(row.attributes('data-project-id')).toBe('general')
  })

  it('does not have a top-level New Chat button', () => {
    const w = factory()
    expect(w.text()).not.toContain('New Chat')
  })
})
