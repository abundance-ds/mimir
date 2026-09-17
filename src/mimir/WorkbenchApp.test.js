import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editorOpen = vi.hoisted(() => vi.fn())
const editorOpenGraph = vi.hoisted(() => vi.fn())
const editorScratchpad = vi.hoisted(() => vi.fn())
const editorReveal = vi.hoisted(() => vi.fn())
const editorOpenSettings = vi.hoisted(() => vi.fn())
const editorClose = vi.hoisted(() => vi.fn())
const editorCycle = vi.hoisted(() => vi.fn())
const editorNew = vi.hoisted(() => vi.fn())
const editorReviewGit = vi.hoisted(() => vi.fn())
const editorPrepareWorkspaceSwitch = vi.hoisted(() => vi.fn())
const terminalPaste = vi.hoisted(() => vi.fn())
const terminalFocus = vi.hoisted(() => vi.fn())
const chatFocus = vi.hoisted(() => vi.fn())
const toolRuntimeStart = vi.hoisted(() => vi.fn())
const toolRuntimeStop = vi.hoisted(() => vi.fn())
const toolRuntimeConfig = vi.hoisted(() => ({ current: null }))
const storage = new Map()
const localStorageMock = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

vi.mock('../editor/App.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'EditorApp',
      props: {
        hideSidebar: Boolean,
        embedded: Boolean,
        workspacePath: String,
        workspacePaths: Array,
      },
      emits: [
        'closeRequest',
        'empty',
        'navigateEditor',
        'newRequest',
        'quickOpenRequest',
        'reviewGitWithAgent',
      ],
      setup(_props, { expose }) {
        expose({
          get navigationTabs() { return useFileStore().visibleOpenFiles.map(file => ({ id: file.id, name: file.path || 'Untitled', path: file.path })) },
          get activeNavigationTab() { return useFileStore().currentFile?.id || '' },
          selectNavigationTab(id) {
            const index = useFileStore().openFiles.findIndex(file => file.id === id)
            if (index < 0) return false
            useFileStore().setActiveTab(index)
            return true
          },
          mimirScratchpad: editorScratchpad,
          mimirOpen: editorOpen,
          mimirOpenGraph: editorOpenGraph,
          mimirReveal: editorReveal,
          mimirOpenSettings: editorOpenSettings,
          mimirCloseActiveTab: editorClose,
          mimirCycleTab: editorCycle,
          mimirNewFile: editorNew,
          mimirReviewGit: editorReviewGit,
          mimirPrepareWorkspaceSwitch: editorPrepareWorkspaceSwitch,
        })
        return () => h('div', { 'data-editor-stub': '', tabindex: '0' }, 'Editor')
      },
    }),
  }
})

vi.mock('./activities/TerminalActivity.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'TerminalActivity',
      props: { activity: Object, active: Boolean },
      emits: ['diagnostic', 'openFile', 'restart', 'surfaceError'],
      setup(props, { expose }) {
        expose({ focusEntry: terminalFocus, pasteText: terminalPaste })
        return () => h('div', {
          'data-terminal-stub': props.activity.id,
          'data-active': String(props.active),
        })
      },
    }),
  }
})

vi.mock('./activities/ChatActivity.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'ChatActivity',
      props: { activity: Object, active: Boolean },
      setup(props, { expose }) {
        expose({ focusEntry: chatFocus })
        return () => h('div', {
          'data-chat-stub': '',
          'data-active': String(props.active),
        })
      },
    }),
  }
})

vi.mock('../services/activities.js', () => ({
  closeActivity: vi.fn(),
  listActivities: vi.fn(),
  listenToActivityEvents: vi.fn(),
  resolveLauncher: vi.fn(),
  renameActivity: vi.fn(),
  respawnActivity: vi.fn(),
  searchActivityHistory: vi.fn(),
  setActivityArchived: vi.fn(),
  spawnActivity: vi.fn(),
  stopActivity: vi.fn(),
  clearActivity: vi.fn(),
  writeActivity: vi.fn(),
}))

vi.mock('../services/launchers.js', () => ({
  detectAgents: vi.fn(),
  loadLauncherConfig: vi.fn(),
  saveLauncherConfig: vi.fn(),
}))

vi.mock('../services/fileIndex.js', () => ({
  openWorkspaceIndex: vi.fn(),
  listIndexedFiles: vi.fn(),
  filterIndexedFiles: vi.fn(),
  refreshWorkspaceIndex: vi.fn(),
  beginContentSearch: vi.fn(),
  cancelContentSearch: vi.fn(),
  searchIndexedContent: vi.fn(),
}))

vi.mock('../services/workspaceFileOperations.js', () => ({
  listWorkspaceDirectory: vi.fn(async () => [{
    path: '/w/README.md',
    name: 'README.md',
    relativePath: 'README.md',
    mtime: 42,
    size: 120,
    isDirectory: false,
    textReadable: true,
    openBehavior: 'text',
  }]),
  inspectWorkspaceEntry: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  duplicateWorkspaceEntry: vi.fn(),
  importWorkspaceEntries: vi.fn(),
  trashWorkspaceEntries: vi.fn(),
  openWorkspaceEntryNative: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
}))

vi.mock('../services/routines.js', () => ({
  createRoutineDefinition: vi.fn(),
  duplicateRoutineDefinition: vi.fn(),
  listenToRoutineEvents: vi.fn(async () => vi.fn()),
  loadRoutineCatalog: vi.fn(async () => ({
    directory: '/home/me/.mimir/routines',
    statePath: '/home/me/.mimir/routines-state.json',
    revision: 1,
    routines: [],
    diagnostics: [],
    lastTick: null,
  })),
  revealRoutineDefinition: vi.fn(),
  reloadRoutineCatalog: vi.fn(),
  runRoutineNow: vi.fn(),
  trashRoutineDefinition: vi.fn(),
  updateRoutineDefinition: vi.fn(),
}))

vi.mock('../services/appsCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAppsCatalog: vi.fn(),
  resolveAppLaunch: vi.fn(),
  unregisterAppTools: vi.fn(async () => {}),
}))

vi.mock('../services/toolRuntime.js', () => ({
  createToolRuntime: vi.fn((options) => {
    toolRuntimeConfig.current = options
    return {
      start: toolRuntimeStart,
      stop: toolRuntimeStop,
    }
  }),
}))

import * as activityApi from '../services/activities.js'
import * as fileApi from '../services/fileIndex.js'
import * as launcherApi from '../services/launchers.js'
import * as appsApi from '../services/appsCatalog.js'
import * as routinesApi from '../services/routines.js'
import { useActivitiesStore } from '../stores/activities.js'
import { useBusinessGraphStore } from '../stores/businessGraph.js'
import { useChatStore } from '../stores/chat.js'
import { useEditorUIStore } from '../stores/editorUI.js'
import { useFileStore } from '../stores/files.js'
import { useLaunchersStore } from '../stores/launchers.js'
import { useMeetingsStore } from '../stores/meetings.js'
import { useSettingsStore } from '../stores/settings.js'
import { useWorkbenchStore } from '../stores/workbench.js'
import WorkbenchApp from './WorkbenchApp.vue'

const indexedFiles = [
  {
    path: '/w/README.md',
    name: 'README.md',
    relativePath: 'README.md',
    mtime: 42,
    size: 120,
    textReadable: true,
  },
]

describe('WorkbenchApp', () => {
  let pinia
  let wrappers

  beforeEach(() => {
    pinia = createPinia()
    wrappers = []
    setActivePinia(pinia)
    vi.resetAllMocks()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    editorOpen.mockReset()
    editorOpenGraph.mockReset()
    editorOpenGraph.mockResolvedValue({ path: '/w/graph/entry.md', kind: 'graph' })
    editorReveal.mockReset()
    editorOpenSettings.mockReset()
    editorClose.mockReset()
    editorCycle.mockReset()
    editorNew.mockReset()
    editorReviewGit.mockReset()
    terminalPaste.mockReset()
    terminalPaste.mockResolvedValue(true)
    terminalFocus.mockReset()
    chatFocus.mockReset()
    toolRuntimeStart.mockReset()
    toolRuntimeStop.mockReset()
    toolRuntimeConfig.current = null
    toolRuntimeStart.mockResolvedValue()
    toolRuntimeStop.mockResolvedValue()
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)
    delete window.__TAURI_INTERNALS__
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    })

    launcherApi.detectAgents.mockResolvedValue([
      { id: 'codex', title: 'Codex', installed: true, binaryPath: '/bin/codex' },
      { id: 'claude', title: 'Claude', installed: false, diagnostic: 'binary not found' },
    ])
    launcherApi.loadLauncherConfig.mockResolvedValue({
      path: '/home/me/.mimir/launchers.json',
      diagnostic: null,
      presets: [
        {
          id: 'review',
          title: 'Review with Codex',
          kind: 'agent',
          agentId: 'codex',
          args: ['review'],
          cwd: { mode: 'workspace' },
        },
        {
          id: 'claude',
          title: 'Claude',
          kind: 'agent',
          agentId: 'claude',
          args: [],
          cwd: { mode: 'workspace' },
        },
      ],
    })
    activityApi.listActivities.mockResolvedValue([])
    activityApi.listenToActivityEvents.mockResolvedValue(vi.fn())
    activityApi.resolveLauncher.mockResolvedValue({
      presetId: 'review',
      title: 'Review with Codex',
      kind: 'agent',
      agentId: 'codex',
      resumeStrategy: 'codex',
      command: '/bin/codex',
      args: ['review'],
      cwd: '/w',
      env: {},
    })
    activityApi.spawnActivity.mockImplementation(async (record) => ({
      record: { ...record, status: 'idle' },
      scrollback: { chunks: [] },
      live: true,
    }))
    activityApi.respawnActivity.mockImplementation(async (record, _size, cliSessionId) => ({
      record: { ...record, status: 'idle', session: { runId: 'run-2', cliSessionId } },
      scrollback: { chunks: [] },
      live: true,
    }))
    activityApi.stopActivity.mockResolvedValue()
    activityApi.closeActivity.mockImplementation(async (id) => ({
      ...useActivitiesStore().byId(id),
      closeRequestedAt: '2026-07-25T12:00:00Z',
    }))
    activityApi.searchActivityHistory.mockResolvedValue([])
    activityApi.renameActivity.mockImplementation(async (id, title) => ({
      ...useActivitiesStore().byId(id),
      title,
    }))
    activityApi.setActivityArchived.mockImplementation(async (id, archived) => ({
      ...useActivitiesStore().byId(id),
      archivedAt: archived ? '2026-07-25T12:00:00Z' : null,
      updatedAt: '2026-07-25T12:00:00Z',
    }))
    activityApi.clearActivity.mockResolvedValue()
    routinesApi.runRoutineNow.mockResolvedValue(null)
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps',
      diagnostics: [],
      apps: [{
        id: 'ledger',
        title: 'Ledger',
        description: 'Project instrument.',
        mode: 'embedded',
        builtin: false,
        tools: [],
      }],
    })
    appsApi.resolveAppLaunch.mockResolvedValue({
      mode: 'embedded',
      appId: 'ledger',
      url: 'app://localhost/ledger/index.html',
    })

    fileApi.openWorkspaceIndex.mockResolvedValue(indexedFiles)
    fileApi.listIndexedFiles.mockResolvedValue(indexedFiles)
    fileApi.filterIndexedFiles.mockResolvedValue([])
    fileApi.refreshWorkspaceIndex.mockResolvedValue({
      added: 0,
      changed: 0,
      removed: 0,
      total: 1,
    })
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    vi.useRealTimers()
  })

  async function render({ workspace = '', teleport = true } = {}) {
    if (workspace) {
      localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
        mimirWorkspaceFolder: workspace,
      }))
    }
    const wrapper = mount(WorkbenchApp, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          Teleport: teleport,
          Transition: false,
          EmbeddedAppHost: true,
        },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    await nextTick()
    return wrapper
  }

  async function chooseActivitySource(wrapper, label) {
    await wrapper.get('[data-new-main-tab]').trigger('click')
    const menu = document.body.querySelector('[data-quick-open]')
    const option = [...menu.querySelectorAll('[data-quick-open-row]')]
      .find(candidate => candidate.textContent.includes(label))
    expect(option, `${label} activity source`).toBeTruthy()
    option.click()
    await flushPromises()
  }

  it('shares session selection, names, and order between Activities and main tabs', async () => {
    const wrapper = await render({ workspace: '/w' })
    const activities = useActivitiesStore()
    for (const id of ['one', 'two']) activities.upsert(activityRecord(id, id, '2026-07-25T10:00:00Z'))
    await nextTick()
    const workbench = useWorkbenchStore()
    workbench.restoreTabs(['one', 'routines', 'two'])
    await nextTick()
    const rows = () => wrapper.findAll('[data-activity-key]').map(row => row.attributes('data-activity-key'))
    const tabs = () => wrapper.findAll('[data-main-tab]').map(row => row.attributes('data-main-tab'))
    const editor = wrapper.get('[data-editor-stub]').element
    expect(rows()).toEqual(['one', 'two'])
    await wrapper.get('[data-activity-key="one"] > button').trigger('click')
    expect(workbench.activeActivityId).toBe('one')
    expect(wrapper.get('[data-main-tab="one"] [role=tab]').attributes('aria-selected')).toBe('true')
    await flushPromises()
    expect(terminalFocus).toHaveBeenCalled()
    await wrapper.get('[data-main-tab="two"] [role=tab]').trigger('click')
    expect(wrapper.get('[data-activity-key="two"] > button').attributes('aria-current')).toBe('page')
    await wrapper.get('[data-activity-key="two"] > button').trigger('keydown', { key: 'F2' })
    await wrapper.get('[data-tab-rename]').setValue('New title')
    await wrapper.get('[data-tab-rename]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-main-tab="two"]').text()).toContain('New title')
    expect(wrapper.get('[data-activity-key="two"]').text()).toContain('New title')
    await wrapper.get('[data-main-tab="one"] [role=tab]').trigger('dblclick')
    await wrapper.get('[data-tab-rename]').setValue('From tab')
    await wrapper.get('[data-tab-rename]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-activity-key="one"]').text()).toContain('From tab')
    wrapper.findComponent({ name: 'SidebarActivities' }).vm.$emit('reorder', ['two', 'one'])
    await nextTick()
    expect(tabs()).toEqual(['two', 'routines', 'one'])
    wrapper.findComponent({ name: 'ActivityTabs' }).vm.$emit('reorder', ['one', 'two', 'routines'])
    await nextTick()
    expect(rows()).toEqual(['one', 'two'])
    const selected = workbench.activeActivityId
    await wrapper.get('[data-files-collapse]').trigger('click')
    const settings = useSettingsStore()
    await settings.flush()
    expect(JSON.parse(storage.get('mimir:editor:settings:v1')).sidebarFilesCollapsed).toBe(true)
    expect(wrapper.get('nav[aria-label="Open Activities"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(false)
    expect(workbench.activeActivityId).toBe(selected)
    expect(tabs()).toEqual(['one', 'two', 'routines'])
    expect(wrapper.get('[data-editor-stub]').element).toBe(editor)
    expect(activityApi.closeActivity).not.toHaveBeenCalled()
  })

  it('closes a live session from the header through the existing stop and archive path', async () => {
    const wrapper = await render({ workspace: '/w' })
    const activities = useActivitiesStore()
    activities.upsert(activityRecord('live', 'Live run', '2026-07-25T10:00:00Z'))
    await nextTick()
    useSettingsStore().set('showMainTabs', false)
    useWorkbenchStore().openActivity('live')
    await nextTick()
    expect(wrapper.find('[data-activity-close]').exists()).toBe(false)
    expect(wrapper.get('[data-close-main-view]').attributes('title')).toBe('Stop and archive')
    await wrapper.get('[data-close-main-view]').trigger('click')
    await flushPromises()
    expect(activityApi.closeActivity).toHaveBeenCalledWith('live')
    expect(activityApi.setActivityArchived).not.toHaveBeenCalled()
    activities.upsert({ ...activities.byId('live'), status: 'stopped' })
    await flushPromises()
    expect(activityApi.setActivityArchived).toHaveBeenCalledWith('live', true)
    expect(wrapper.find('[data-main-tab="live"]').exists()).toBe(false)
    expect(wrapper.find('[data-activity-key="live"]').exists()).toBe(false)
  })

  it('uses the existing header with tabs hidden and preserves navigation and mounted content', async () => {
    const wrapper = await render({ workspace: '/w', teleport: false })
    const activities = useActivitiesStore()
    const workbench = useWorkbenchStore()
    const settings = useSettingsStore()
    for (const id of ['one', 'two']) activities.upsert(activityRecord(id, id, '2026-07-25T10:00:00Z'))
    await nextTick()
    workbench.restoreTabs(['one', 'routines', 'two'])
    workbench.openActivity('one')
    await flushPromises()
    const editor = wrapper.get('[data-editor-stub]').element
    const terminal = wrapper.get('[data-terminal-stub="one"]').element
    const order = [...workbench.openTabIds]
    settings.set('showMainTabs', false)
    await nextTick()
    expect(wrapper.find('[data-main-tab]').exists()).toBe(false)
    expect(wrapper.get('[data-pane-title]').text()).toContain('one')
    expect(wrapper.find('[data-activity-close]').exists()).toBe(false)
    expect(wrapper.get('[data-editor-stub]').element).toBe(editor)
    expect(wrapper.get('[data-terminal-stub="one"]').element).toBe(terminal)
    expect(workbench.openTabIds).toEqual(order)
    await wrapper.get('[data-activity-key="two"] > button').trigger('click')
    expect(workbench.activeActivityId).toBe('two')
    expect(wrapper.get('[data-pane-title]').text()).toContain('two')
    settings.set('sidebarFilesCollapsed', true)
    workbench.setPaneState('sidebar', 'rail')
    await nextTick()
    await wrapper.get('[aria-label="Open views"]').trigger('click')
    await flushPromises()
    const menu = document.querySelector('[role="dialog"][aria-label="Open views"]')
    expect(menu.textContent).toContain('Routines')
    const input = menu.querySelector('input')
    input.value = 'routines'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(document.activeElement).toBe(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(workbench.activeActivityId).toBe('routines')
    expect(wrapper.get('[data-close-main-view]').attributes('title')).toBe('Close')
    await wrapper.get('[data-close-main-view]').trigger('click')
    expect(workbench.openTabIds).not.toContain('routines')
    await wrapper.get('[data-new-main-tab]').trigger('click')
    expect(document.querySelector('[data-quick-open]')).toBeTruthy()
    settings.set('showMainTabs', true)
    await nextTick()
    expect(wrapper.find('[data-main-tab="one"]').exists()).toBe(true)
    expect(wrapper.find('[data-close-main-view]').exists()).toBe(false)
    expect(wrapper.get('[data-terminal-stub="one"]').element).toBe(terminal)
    expect(wrapper.get('[data-editor-stub]').element).toBe(editor)
    expect(activityApi.closeActivity).not.toHaveBeenCalled()
  })

  it('restores the saved tab preference and retains New Activity in an empty header', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({ showMainTabs: false }))
    const wrapper = await render()
    expect(wrapper.find('[data-main-tab]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="Open views"]').exists()).toBe(true)
    expect(wrapper.find('[data-close-main-view]').exists()).toBe(false)
    await wrapper.get('[data-new-main-tab]').trigger('click')
    expect(document.querySelector('[data-quick-open]')).toBeTruthy()
  })

  it('projects native work status to the Sidebar without inferring work from output', async () => {
    const wrapper = await render({ workspace: '/w' })
    const activities = useActivitiesStore()
    activities.upsert({ ...activityRecord('signals', 'Signal test', '2026-07-25T10:00:00Z'), status: 'idle' })
    await nextTick()
    const receive = activityApi.listenToActivityEvents.mock.calls[0][0]
    receive({ type: 'output', activityId: 'signals', bytes: [65] })
    await nextTick()
    expect(wrapper.find('[data-activity-working="signals"]').exists()).toBe(false)
    receive({ type: 'status', activityId: 'signals', status: 'working', needsInputIsBlocking: false })
    await nextTick()
    expect(wrapper.get('[data-activity-working="signals"]').findAll('span')).toHaveLength(9)
    receive({ type: 'status', activityId: 'signals', status: 'idle', needsInputIsBlocking: false })
    await nextTick()
    expect(wrapper.find('[data-activity-working="signals"]').exists()).toBe(false)
  })

  it('restores the Files drawer height and disclosure without hiding Activities or main tabs', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w', sidebarFilesCollapsed: true, sidebarFilesHeight: 300,
    }))
    const wrapper = await render()
    useActivitiesStore().upsert(activityRecord('saved', 'Saved session', '2026-07-25T10:00:00Z'))
    await nextTick()
    expect(wrapper.get('[data-sidebar-files-toggle]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('nav[aria-label="Open Activities"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(false)
    expect(wrapper.find('[data-main-tab="saved"]').exists()).toBe(true)
    await wrapper.get('[data-sidebar-files-toggle]').trigger('click')
    expect(wrapper.get('[data-activity-key="saved"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('328px')
    await wrapper.get('[data-sidebar-files-resize]').trigger('keydown', { key: 'ArrowDown' })
    await useSettingsStore().flush()
    expect(JSON.parse(storage.get('mimir:editor:settings:v1')).sidebarFilesHeight).toBe(272)
  })

  it('restores saved tool tabs without creating duplicate sessions', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      workbenchLayout: { activeActivityId: 'app:ledger', openTabIds: ['routines', 'app:ledger'] },
    }))
    const wrapper = await render()
    expect(useWorkbenchStore().activeActivityId).toBe('app:ledger')
    expect(wrapper.findAll('[data-main-tab]').map(tab => tab.attributes('data-main-tab'))).toEqual(['routines', 'app:ledger'])
    expect(activityApi.spawnActivity).not.toHaveBeenCalled()
  })

  it.each(['activity', 'editor', 'sidebar'])('uses the same app-wide shortcuts from an input in %s', async pane => {
    const wrapper = await render({ workspace: '/w' })
    const field = document.createElement('input')
    wrapper.get(`[data-pane="${pane}"]`).element.append(field)
    field.focus()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, isComposing: true, bubbles: true }))
    await nextTick()
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    const projectInput = wrapper.get('[data-quick-open-input]')
    expect(projectInput.element.value).toBe('p: ')
    expect(document.activeElement).toBe(projectInput.element)
    await projectInput.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    expect(document.activeElement).toBe(field)
    const press = key => field.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
    press('t')
    await nextTick()
    expect(wrapper.get('[data-quick-open]').text()).toContain('New tab')
    wrapper.findComponent({ name: 'QuickOpen' }).vm.$emit('close')
    await nextTick()
    field.focus()
    press('n')
    await flushPromises()
    expect(editorNew).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    field.focus()
    press(',')
    await nextTick()
    expect(useEditorUIStore().settingsOpen).toBe(true)
    field.remove()
  })

  it('focuses and restores the named pane at narrow widths', async () => {
    const wrapper = await render({ workspace: '/w' })
    useFileStore().newFile()
    window.innerWidth = 700
    window.dispatchEvent(new Event('resize'))
    const workbench = useWorkbenchStore()
    workbench.setPaneState('editor', 'expanded')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    await flushPromises()
    expect(workbench.paneLayout.activity.state).toBe('expanded')
    expect(workbench.paneLayout.editor.state).toBe('rail')
    expect(document.activeElement.closest('[data-pane]').dataset.pane).toBe('activity')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true }))
    await flushPromises()
    expect(workbench.paneLayout.editor.state).toBe('expanded')
    expect(workbench.paneLayout.activity.state).toBe('rail')
    expect(document.activeElement.closest('[data-pane]').dataset.pane).toBe('editor')
    expect(editorNew).not.toHaveBeenCalled()
  })

  it('creates a document when focusing an empty Editor, without opening an empty panel', async () => {
    await render({ workspace: '/w' })
    useWorkbenchStore().setPaneState('editor', 'rail')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true }))
    await flushPromises()
    expect(editorNew).toHaveBeenCalledTimes(1)
    expect(useWorkbenchStore().paneLayout.editor.state).toBe('expanded')
  })

  it('opens the Main tab picker with Cmd+T', async () => {
    const wrapper = await render({ workspace: '/w' })
    const pane = wrapper.get('[data-pane="activity"]')
    pane.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))
    await nextTick()
    expect(wrapper.get('[data-quick-open]').text()).toContain('New tab')
    expect(wrapper.get('[data-quick-open-key="new:preset:review"]').exists()).toBe(true)
  })

  it('keeps the visible Files sidebar ready for drops while File Manager is open', async () => {
    const wrapper = await render({ workspace: '/w' })
    useWorkbenchStore().setPaneState('sidebar', 'expanded')
    await nextTick()
    const sidebarFiles = wrapper.findAllComponents({ name: 'FilesActivity' }).find(component => component.props('compact'))
    sidebarFiles.vm.$emit('openManager')
    await flushPromises()
    expect(useWorkbenchStore().activeActivityId).toBe('files')
    expect(sidebarFiles.props('active')).toBe(true)
    useWorkbenchStore().setPaneState('sidebar', 'rail')
    await nextTick()
    expect(sidebarFiles.props('active')).toBe(false)
  })

  it('composes the lean three-pane shell and compact launch menu', async () => {
    const wrapper = await render()
    const rows = wrapper.findAll('[data-sidebar-row]').map((row) => row.attributes('data-sidebar-row'))

    expect(wrapper.get('[data-pane="sidebar"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="activity"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="editor"]').exists()).toBe(true)
    expect(wrapper.get('[data-editor-stub]').exists()).toBe(true)
    expect(toolRuntimeStart).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      'tool:core:scratchpad',
      'tool:core:routines',
      'tool:app:ledger',
      'tool:core:chats',
    ])
    expect(wrapper.get('[data-pane="sidebar"] [data-files-activity]').exists()).toBe(true)
    await wrapper.get('[data-new-main-tab]').trigger('click')
    const review = document.body.querySelector(
      '[data-quick-open-key="new:preset:review"]',
    )
    expect(review).toBeTruthy()
    expect(review.textContent).toContain('Review with Codex')
  })

  it('shows a sync error after the current diagnostic is dismissed', async () => {
    let syncErrorHandler
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === 'mimir://managed-git-error') syncErrorHandler = handler
      return vi.fn()
    })
    window.__TAURI_INTERNALS__ = {}
    const wrapper = await render()

    wrapper.findComponent({ name: 'FilesActivity' }).vm.$emit('diagnostic', 'Current issue')
    await nextTick()
    syncErrorHandler({ payload: { message: 'Reconnect GitHub.', root: '/team' } })
    await nextTick()

    expect(wrapper.get('[data-workbench-diagnostic]').text()).toContain('Current issue')
    await wrapper.get('[data-workbench-diagnostic] button').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-workbench-diagnostic]').text())
      .toContain('Automatic sync needs attention: Reconnect GitHub.')
  })

  it('gives replacement and queued diagnostics a full 25 seconds', async () => {
    let syncErrorHandler
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === 'mimir://managed-git-error') syncErrorHandler = handler
      return vi.fn()
    })
    window.__TAURI_INTERNALS__ = {}
    const wrapper = await render()
    vi.useFakeTimers()
    const files = wrapper.findComponent({ name: 'FilesActivity' })

    files.vm.$emit('diagnostic', 'File not found')
    await nextTick()
    await vi.advanceTimersByTimeAsync(20_000)
    files.vm.$emit('diagnostic', 'Another file not found')
    await nextTick()
    syncErrorHandler({ payload: { message: 'Reconnect GitHub.', root: '/team' } })
    await nextTick()

    await vi.advanceTimersByTimeAsync(24_999)
    expect(wrapper.get('[data-workbench-diagnostic]').text()).toContain('Another file not found')
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.get('[data-workbench-diagnostic]').text()).toContain('Reconnect GitHub.')
    await vi.advanceTimersByTimeAsync(24_999)
    expect(wrapper.find('[data-workbench-diagnostic]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.find('[data-workbench-diagnostic]').exists()).toBe(false)
  })

  it('focuses a new CLI Activity launched from the plus menu', async () => {
    const wrapper = await render({ workspace: '/w' })

    await chooseActivitySource(wrapper, 'Review with Codex')

    expect(useWorkbenchStore().activeActivityId).toMatch(/^agent:/)
    expect(terminalFocus).toHaveBeenCalled()
  })

  it('focuses the renamed Activity surface when Enter confirms its name', async () => {
    const wrapper = await render({ workspace: '/w' })
    const activity = activityRecord(
      'agent:rename',
      'Review API',
      '2026-08-18T10:00:00Z',
    )
    useActivitiesStore().upsert(activity)
    await nextTick()

    await wrapper.get('[data-main-tab="agent:rename"] [role=tab]').trigger('click')
    await wrapper.get('[data-main-tab="agent:rename"] [role=tab]').trigger('dblclick')
    const input = wrapper.get('[data-tab-rename]')
    await input.setValue('Review API contract')
    terminalFocus.mockClear()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await nextTick()

    expect(activityApi.renameActivity).toHaveBeenCalledWith(
      'agent:rename',
      'Review API contract',
    )
    expect(useWorkbenchStore().activeActivityId).toBe('agent:rename')
    expect(document.activeElement.getAttribute('role')).toBe('tab')
  })

  it('promotes a terminal API failure to the Activity row error state', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:surface-error', 'Surface error', '2026-08-14T12:00:00Z'),
      status: 'idle',
    })
    useWorkbenchStore().openActivity('agent:surface-error')
    await vi.dynamicImportSettled()
    await flushPromises()
    await nextTick()

    wrapper.findAllComponents({ name: 'TerminalActivity' })
      .find(component => component.props('activity').id === 'agent:surface-error')
      .vm.$emit('surfaceError', {
        activityId: 'agent:surface-error',
        error: 'Could not send terminal input.',
      })
    await nextTick()

    expect(store.byId('agent:surface-error').error).toBe('Could not send terminal input.')
    expect(wrapper.get('[data-main-tab="agent:surface-error"] [aria-label="Error"]').exists()).toBe(true)
  })

  it('opens Chats as one unique tool tab', async () => {
    const wrapper = await render()
    await wrapper.get('[data-sidebar-row="tool:core:chats"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-sidebar-row="tool:core:chats"]').trigger('click')
    expect(useWorkbenchStore().openTabIds.filter(id => id === 'chats')).toHaveLength(1)
  })

  it.each(['open', 'record'])('routes a %s notification to Scribe with the correct recording behavior', async (action) => {
    appsApi.loadAppsCatalog.mockResolvedValue({ directory: '/apps', diagnostics: [], apps: [{ id: 'scribe', title: 'Scribe', mode: 'embedded', builtin: true, tools: [] }] })
    appsApi.resolveAppLaunch.mockResolvedValue({ mode: 'embedded', appId: 'scribe', title: 'Scribe', url: '', builtin: true })
    const wrapper = await render()
    const meetings = useMeetingsStore()
    const start = vi.spyOn(meetings, 'start').mockResolvedValue(null)
    vi.spyOn(meetings, 'refresh').mockResolvedValue()
    vi.mocked(invoke).mockImplementation(async (command) => command === 'meetings_take_record_requests'
      ? [{ candidateId: 'call-a', appName: 'Chrome', action }]
      : undefined)
    const handler = vi.mocked(listen).mock.calls.find(([event]) => event === 'mimir://meeting-record-requested')?.[1]
    expect(handler).toBeTypeOf('function')
    handler({ payload: null })
    await flushPromises()
    expect(wrapper.find('[data-main-tab="app:scribe"]').exists()).toBe(true)
    expect(start).toHaveBeenCalledTimes(action === 'record' ? 1 : 0)
    if (action === 'record') expect(start).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'call-a' }))
  })

  it('opens Scribe for a banner action queued before Workbench startup finishes', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({ directory: '/apps', diagnostics: [], apps: [{ id: 'scribe', title: 'Scribe', mode: 'embedded', builtin: true, tools: [] }] })
    appsApi.resolveAppLaunch.mockResolvedValue({ mode: 'embedded', appId: 'scribe', title: 'Scribe', url: '', builtin: true })
    const previous = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, ...args) => command === 'meetings_take_record_requests'
      ? Promise.resolve([{ candidateId: 'call-a', appName: 'Chrome', action: 'open' }])
      : previous?.(command, ...args))
    const start = vi.spyOn(useMeetingsStore(), 'start').mockResolvedValue(null)
    await render()
    await flushPromises()
    expect(useWorkbenchStore().activeActivityId).toBe('app:scribe')
    expect(start).not.toHaveBeenCalled()
  })

  it('routes the persistent sidebar microphone control through the human meeting store', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({ directory: '/apps', diagnostics: [], apps: [{ id: 'scribe', title: 'Scribe', mode: 'embedded', builtin: true, tools: [] }] })
    const wrapper = await render()
    const meetings = useMeetingsStore()
    const active = {
      id: 'meeting-live',
      title: 'Architecture review',
      lifecycle: 'capturing',
      transcription: 'live',
      startedAt: '2026-07-31T00:00:00Z',
      recordingStartedAt: new Date().toISOString(),
      stoppedAt: null,
      durationMs: 1_000,
      micMuted: false,
      channels: ['microphone', 'system'],
      gaps: [],
      transcriptRevision: 0,
      transcriptFinal: false,
      segments: [],
      jobs: [],
    }
    const state = {
      revision: 20,
      meetings: [active],
      meetingsTruncated: false,
      nextMeetingsBefore: null,
      activeMeetingId: active.id,
      candidates: [],
      config: meetings.config,
      permissions: { microphone: 'granted', systemAudio: 'granted' },
      models: [],
      diagnostic: null,
    }
    meetings.applySnapshot(state)
    await nextTick()
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('0:01')
    vi.mocked(invoke).mockResolvedValueOnce({
      ...state,
      revision: 21,
      meetings: [{ ...active, micMuted: true }],
    })

    await wrapper.get('[data-sidebar-meeting-microphone]').trigger('click')
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('meetings_set_mic_muted', {
      meetingId: active.id,
      muted: true,
    })
    expect(meetings.activeMeeting.micMuted).toBe(true)
  })

  it('places singleton apps in Tools and process apps in the compact plus menu', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps',
      diagnostics: [],
      apps: [
        {
          id: 'scratch',
          title: 'Today',
          mode: 'embedded',
          builtin: true,
          tools: [],
        },
        {
          id: 'business-graph',
          title: 'Business graph',
          mode: 'rust-helper',
          helper: 'business-graph',
          builtin: true,
          tools: [],
        },
        {
          id: 'review-runner',
          title: 'Review runner',
          mode: 'process',
          command: '/bin/review',
          builtin: false,
          tools: [],
        },
      ],
    })
    const wrapper = await render()

    expect(wrapper.get('[data-sidebar-row="tool:app:scratch"]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-row="tool:app:business-graph"]').exists()).toBe(true)
    expect(wrapper.find('[data-sidebar-row^="launcher:"]').exists()).toBe(false)
    await wrapper.get('[data-new-main-tab]').trigger('click')
    expect(document.body.querySelector(
      '[data-quick-open-key="new:app:review-runner"]',
    )).toBeTruthy()
    expect(wrapper.find('[data-sidebar-row="tool:app:review-runner"]').exists()).toBe(false)
  })

  it('persists and projects manual Tool order', async () => {
    const wrapper = await render()
    const settings = useSettingsStore()

    settings.set('sidebarToolOrder', [
      'app:ledger',
      'core:routines',
      'core:chats',
      'app:not-installed',
    ])
    await nextTick()

    expect(wrapper.findAll('[data-tool-key]').map((row) => row.attributes('data-tool-key'))).toEqual([
      'app:ledger',
      'core:routines',
      'core:chats',
      'core:scratchpad',
    ])

    await wrapper
      .get('[data-sidebar-row="tool:app:ledger"]')
      .find('button')
      .trigger('keydown', {
        key: 'ArrowDown',
        altKey: true,
        shiftKey: true,
      })

    expect(settings.sidebarToolOrder).toEqual([
      'core:routines',
      'app:ledger',
      'core:chats',
      'core:scratchpad',
      'app:not-installed',
    ])
  })

  it('opens Scratchpad in the Editor without changing the main tab', async () => {
    const wrapper = await render()
    const workbench = useWorkbenchStore()
    const active = workbench.activeActivityId
    const tabs = [...workbench.openTabIds]
    await wrapper.get('[data-sidebar-row="tool:core:scratchpad"]').find('button').trigger('click')
    expect(editorScratchpad).toHaveBeenCalled()
    expect(workbench.activeActivityId).toBe(active)
    expect(workbench.openTabIds).toEqual(tabs)
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('scratchpadReveal', { focus: false })
    await nextTick()
    expect(workbench.activeActivityId).toBe(active)
  })

  it('always boots with the mounted Editor visible and keeps one global Settings entry', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      workbenchLayout: {
        sidebar: { state: 'expanded', width: 240 },
        activity: { state: 'expanded', width: 560 },
        editor: { state: 'rail', width: 520 },
        activeActivityId: 'files',
      },
    }))

    const wrapper = await render()

    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.find('[data-sidebar-manage-apps]').exists()).toBe(false)
    await wrapper.get('[data-sidebar-settings]').trigger('click')
    expect(editorOpenSettings).toHaveBeenLastCalledWith('appearance')
  })

  it('restores a railed Editor when Settings navigates to an app definition', async () => {
    const wrapper = await render()
    useWorkbenchStore().setPaneState('editor', 'rail')
    await nextTick()

    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('navigateEditor', {
      path: '/home/me/.mimir/apps/notes/app.toml',
    })
    await nextTick()

    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
  })

  it('opens a fresh file when the Editor rail is restored with no open files', async () => {
    const wrapper = await render()
    useWorkbenchStore().setPaneState('editor', 'rail')
    await nextTick()

    await wrapper.get('[data-pane-restore="editor"]').trigger('click')
    await nextTick()

    expect(editorNew).toHaveBeenCalledOnce()
  })

  it('does not force a new file when the Editor rail is restored with a file already open', async () => {
    const wrapper = await render()
    useFileStore().newFile()
    useWorkbenchStore().setPaneState('editor', 'rail')
    await nextTick()

    await wrapper.get('[data-pane-restore="editor"]').trigger('click')
    await nextTick()

    expect(editorNew).not.toHaveBeenCalled()
  })

  it('boots narrow focus mode into Editor before restored tabs are available', async () => {
    window.innerWidth = 700

    const wrapper = await render()

    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')

    await wrapper.get('[data-pane-restore="activity"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('rail')

    await wrapper.get('[data-pane-restore="editor"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
  })

  it('keeps unavailable CLI tools out of the launch surface', async () => {
    const wrapper = await render()

    await wrapper.get('[data-new-main-tab]').trigger('click')
    expect(document.body.querySelector(
      '[data-quick-open-key="new:preset:claude"]',
    )).toBeNull()
    expect(activityApi.resolveLauncher).not.toHaveBeenCalled()
  })

  it('switches recent projects from the sidebar and promotes the selection to most recent', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      recentWorkspaceFolders: ['/w', '/other/project'],
    }))
    const wrapper = await render()
    fileApi.openWorkspaceIndex.mockClear()

    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    const recent = wrapper.get('[data-project-switcher-menu]')
      .findAll('[data-project-menu-item]')
      .find(item => item.attributes('data-project-path') === '/other/project')
    await recent.trigger('click')
    await flushPromises()

    expect(fileApi.openWorkspaceIndex).toHaveBeenCalledWith('/other/project')
    expect(useSettingsStore().mimirWorkspaceFolder).toBe('/other/project')
    expect(useSettingsStore().recentWorkspaceFolders[0]).toBe('/other/project')
    expect(wrapper.findComponent({ name: 'EditorApp' }).props('workspacePath')).toBe('/other/project')
    expect(wrapper.findComponent({ name: 'EditorApp' }).props('workspacePaths')).toContain('/w')
  })

  it('switches to the previous project with Cmd+Shift+P and Enter, then back again', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      recentWorkspaceFolders: ['/w', '/other/project', '/older/project'],
    }))
    const wrapper = await render()
    useWorkbenchStore().setPaneState('sidebar', 'rail')
    fileApi.openWorkspaceIndex.mockClear()
    for (const path of ['/other/project', '/w']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
      await flushPromises()
      expect(wrapper.get('[data-quick-open-row][aria-selected="true"]').attributes('data-quick-open-key')).toBe(`project:${path}`)
      await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(useSettingsStore().mimirWorkspaceFolder).toBe(path)
      expect(useSettingsStore().recentWorkspaceFolders[0]).toBe(path)
      expect(fileApi.openWorkspaceIndex).toHaveBeenLastCalledWith(path)
      expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    }
    expect(activityApi.stopActivity).not.toHaveBeenCalled()
  })

  it('shows a missing project once without letting its Activity retain the project row', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      recentWorkspaceFolders: ['/w', '/gone'],
    }))
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:gone', 'Recover removed work', '2026-07-25T10:00:00Z'),
      workspacePath: '/gone',
      status: 'interrupted',
      source: { presetId: 'review' },
      launch: { command: '/bin/codex', args: [], cwd: '/gone', env: {} },
    })
    await nextTick()
    let resolveStatuses
    window.__TAURI_INTERNALS__ = {}
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => {
      resolveStatuses = resolve
    }))
    try {
      await wrapper.get('[data-sidebar-workspace]').trigger('click')

      expect(wrapper.get('[data-project-switcher-menu]').exists()).toBe(true)
      expect(wrapper.get('[data-project-path="/gone"]').exists()).toBe(true)
      expect(invoke).toHaveBeenCalledWith('workspace_paths_status', {
        paths: ['/w', '/gone'],
      })

      resolveStatuses([
        { path: '/w', available: true },
        { path: '/gone', available: false },
      ])
      await flushPromises()

      const missing = wrapper.get('[data-project-path="/gone"]')
      expect(missing.attributes('disabled')).toBeDefined()
      expect(missing.text()).toContain('gone - not found')
      expect(wrapper.findComponent({ name: 'EditorApp' }).props('workspacePaths')).toEqual(['/w'])

      await wrapper.get('[data-sidebar-workspace]').trigger('click')
      await wrapper.get('[data-sidebar-workspace]').trigger('click')
      expect(wrapper.find('[data-project-path="/gone"]').exists()).toBe(false)
      expect(useSettingsStore().recentWorkspaceFolders).toEqual(['/w'])

      await wrapper.get('[data-sidebar-workspace]').trigger('click')
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        bubbles: true,
      }))
      await nextTick()
      const input = wrapper.get('[data-quick-open-input]')
      await input.setValue('a:Recover removed work')
      expect(wrapper.get('[data-quick-open-key="activity:agent:gone"]').text())
        .toContain('workspace not found')
      await input.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(useSettingsStore().mimirWorkspaceFolder).toBe('/w')
      expect(useWorkbenchStore().activeActivityId).toBe('agent:gone')
      expect(wrapper.get('[data-main-tab="agent:gone"]').exists()).toBe(true)
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })

  it('shows only the current project Activities while hidden tasks keep running', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      recentWorkspaceFolders: ['/w', '/other/project'],
    }))
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:alpha', 'Alpha task', '2026-07-25T10:00:00Z'),
      source: { presetId: 'review' },
    })
    store.upsert({
      ...activityRecord('agent:beta', 'Beta task', '2026-07-25T09:00:00Z'),
      workspacePath: '/other/project',
      status: 'needs-input',
      source: { presetId: 'review' },
      launch: { command: '/bin/codex', args: [], cwd: '/other/project', env: {} },
    })
    await nextTick()

    expect(wrapper.find('[data-main-tab="agent:alpha"]').exists()).toBe(true)
    expect(wrapper.find('[data-activity-key="agent:alpha"]').exists()).toBe(true)
    expect(wrapper.find('[data-activity-key="agent:beta"]').exists()).toBe(false)
    expect(wrapper.find('[data-main-tab="agent:beta"]').exists()).toBe(false)

    await wrapper.get('[data-main-tab="agent:alpha"]').find('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-terminal-stub="agent:alpha"]').exists()).toBe(true)

    await wrapper.get('[data-sidebar-workspace]').trigger('click')
    const betaProject = wrapper.get('[data-project-switcher-menu]')
      .findAll('[data-project-menu-item]')
      .find(item => item.attributes('data-project-path') === '/other/project')
    expect(betaProject.text()).not.toContain('needs input')
    await betaProject.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-main-tab="agent:alpha"]').exists()).toBe(false)
    expect(wrapper.find('[data-activity-key="agent:alpha"]').exists()).toBe(false)
    expect(wrapper.find('[data-activity-key="agent:beta"]').exists()).toBe(true)
    expect(wrapper.find('[data-main-tab="agent:beta"]').exists()).toBe(true)
    expect(store.byId('agent:alpha').status).toBe('working')
    expect(activityApi.stopActivity).not.toHaveBeenCalled()
    expect(wrapper.get('[data-terminal-stub="agent:alpha"]').attributes('data-active')).toBe('false')
    expect(useWorkbenchStore().activeActivityId).toBe('')
    expect(useWorkbenchStore().openTabIds).toContain('agent:alpha')
  })

  it('saves a manual position for each new Activity and drops positions for closed ones', async () => {
    await render({ workspace: '/w' })
    const store = useActivitiesStore()
    const settings = useSettingsStore()

    store.upsert(activityRecord('agent:alpha', 'Alpha task', '2026-07-25T10:00:00Z'))
    await nextTick()
    store.upsert(activityRecord('agent:beta', 'Beta task', '2026-07-25T11:00:00Z'))
    await nextTick()

    expect(settings.activityNavigator.order).toEqual(['agent:beta', 'agent:alpha'])

    // Live output must not move a row that already holds a position.
    store.reconcileStatus('agent:alpha', 'needs-input')
    await nextTick()
    expect(settings.activityNavigator.order).toEqual(['agent:beta', 'agent:alpha'])

    store.reconcileStatus('agent:beta', 'done')
    store.remove('agent:beta')
    await nextTick()
    expect(settings.activityNavigator.order).toEqual(['agent:alpha'])
  })

  it('does not restore a saved Activity from a different project at startup', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      recentWorkspaceFolders: ['/w', '/other/project'],
      workbenchLayout: {
        sidebar: { state: 'expanded', width: 240 },
        activity: { state: 'expanded', width: 560 },
        editor: { state: 'expanded', width: 520 },
        activeActivityId: 'agent:beta',
      },
    }))
    activityApi.listActivities.mockResolvedValueOnce([{
      ...activityRecord('agent:beta', 'Beta task', '2026-07-25T09:00:00Z'),
      workspacePath: '/other/project',
      source: { presetId: 'review' },
      launch: { command: '/bin/codex', args: [], cwd: '/other/project', env: {} },
    }])

    const wrapper = await render()

    expect(useWorkbenchStore().activeActivityId).toBe('')
    expect(wrapper.find('[data-main-tab="agent:beta"]').exists()).toBe(false)
  })

  it('launches an available preset in the selected workspace', async () => {
    const wrapper = await render({ workspace: '/w' })
    await chooseActivitySource(wrapper, 'Review')

    expect(fileApi.openWorkspaceIndex).toHaveBeenCalledWith('/w')
    expect(activityApi.resolveLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'review', args: ['review'] }),
      '/w',
    )
    expect(activityApi.spawnActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent',
        launch: expect.objectContaining({
          command: '/bin/codex',
          args: ['review'],
          cwd: '/w',
        }),
      }),
      {},
      null,
    )
    expect(useWorkbenchStore().activeActivityId).toMatch(/^agent:/)
  })

  it('starts graph-grounded work as a durable associated agent Activity', async () => {
    const wrapper = await render({ workspace: '/w' })
    useActivitiesStore().upsert({
      id: 'app:business-graph',
      kind: 'app',
      title: 'Business graph',
      workspacePath: '/w',
      status: 'ready',
      createdAt: '2026-07-26T00:00:00Z',
      updatedAt: '2026-07-26T00:00:00Z',
      retention: 'durable',
      source: {
        type: 'app',
        appId: 'business-graph',
        app: {
          id: 'business-graph',
          title: 'Business graph',
          mode: 'rust-helper',
          helper: 'business-graph',
        },
      },
      host: { type: 'app' },
      launch: {
        plan: {
          appId: 'business-graph',
          mode: 'rust-helper',
          helper: 'business-graph',
        },
      },
    })
    useWorkbenchStore().openActivity('app:business-graph')
    await vi.dynamicImportSettled()
    await flushPromises()
    await nextTick()

    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('startGraphWork', {
      nodeId: 'issue-1',
      nodeKind: 'issue',
      title: 'Extract evidence',
      scopeIds: ['project:alpha'],
      graphRevision: 9,
      prompt: 'Graph-grounded prompt',
    })
    await flushPromises()

    expect(activityApi.spawnActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'agent',
        title: 'Work · Extract evidence',
        retention: 'durable',
        source: expect.objectContaining({
          type: 'business-graph-work',
          graphNodeId: 'issue-1',
          graphScopeIds: ['project:alpha'],
          graphRevision: 9,
        }),
        launch: expect.objectContaining({
          args: ['review', 'Graph-grounded prompt'],
        }),
      }),
      {},
      null,
    )
    expect(useWorkbenchStore().activeActivityId).toMatch(/^agent:/)

    useLaunchersStore().presets.push({
      id: 'summary-agent',
      title: 'Summary agent',
      kind: 'agent',
      binary: '/bin/summary-agent',
      args: [],
      cwd: { mode: 'workspace' },
    })
    wrapper.findComponent({ name: 'BusinessGraphApp' }).vm.$emit('startWork', {
      presetId: 'summary-agent',
      sourceType: 'business-graph-summary',
      nodeId: 'changes',
      nodeKind: 'history',
      title: 'Summary · 50 changes',
      scopeIds: ['project:alpha'],
      graphRevision: 9,
      graphEventSince: '2026-07-20T00:00:00Z',
      graphEventCount: 37,
      graphContextShortened: true,
      graphContextBytes: 79_500,
      prompt: 'Summarise attached graph history',
    })
    await flushPromises()

    expect(activityApi.resolveLauncher).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'summary-agent' }),
      '/w',
    )
    expect(activityApi.spawnActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Summary · 50 changes',
        source: expect.objectContaining({
          type: 'business-graph-summary',
          graphNodeId: 'changes',
          graphEventSince: '2026-07-20T00:00:00Z',
          graphEventCount: 37,
          graphContextShortened: true,
          graphContextBytes: 79_500,
        }),
      }),
      {},
      null,
    )
  })

  it('resumes an interrupted agent into the same Activity row instead of spawning a new one', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      id: 'agent:resume-me',
      kind: 'agent',
      title: 'Review with Codex',
      workspacePath: '/w',
      status: 'interrupted',
      createdAt: '2026-07-25T10:00:00Z',
      updatedAt: '2026-07-25T10:00:00Z',
      retention: 'durable',
      source: { launcherId: 'codex', presetId: 'review' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      launch: { command: '/bin/codex', args: ['review'], cwd: '/w', env: {} },
      session: {
        runId: 'run-1',
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        exit: { reason: 'interrupted' },
      },
    })
    useWorkbenchStore().openActivity('agent:resume-me')
    await flushPromises()

    wrapper.findAllComponents({ name: 'TerminalActivity' })
      .find((component) => component.props('activity').id === 'agent:resume-me')
      .vm.$emit('restart', { activity: store.byId('agent:resume-me') })
    await flushPromises()

    expect(activityApi.spawnActivity).not.toHaveBeenCalled()
    expect(activityApi.respawnActivity).toHaveBeenCalledTimes(1)
    const respawned = activityApi.respawnActivity.mock.calls[0][0]
    expect(respawned.id).toBe('agent:resume-me')
    expect(respawned.launch.args).toEqual([
      'resume',
      '11111111-1111-4111-8111-111111111111',
    ])
    expect(respawned.launch.env.MIMIR_ACTIVITY_ID).toBe('agent:resume-me')
    expect(store.activities.filter((activity) => activity.kind === 'agent')).toHaveLength(1)
    expect(useWorkbenchStore().activeActivityId).toBe('agent:resume-me')
    expect(store.byId('agent:resume-me')).toMatchObject({
      status: 'idle',
      session: { runId: 'run-2' },
    })
  })

  it('launches a fresh Terminal Activity from the Activity plus menu', async () => {
    const wrapper = await render({ workspace: '/w' })
    useLaunchersStore().presets.push({
      id: 'terminal',
      title: 'Terminal',
      kind: 'terminal',
      enabled: true,
      args: [],
      env: {},
      cwd: { mode: 'workspace' },
    })
    activityApi.resolveLauncher.mockResolvedValueOnce({
      presetId: 'terminal',
      title: 'Terminal',
      kind: 'terminal',
      agentId: null,
      resumeStrategy: 'none',
      command: '/bin/zsh',
      args: [],
      cwd: '/w',
      env: {},
    })
    await nextTick()

    await wrapper.get('[data-new-main-tab]').trigger('click')
    const menu = document.body.querySelector('[data-quick-open]')
    const terminal = [...menu.querySelectorAll('[data-quick-open-row]')]
      .find(option => option.textContent.includes('Terminal'))
    expect(menu.textContent).toContain('Chats')
    terminal.click()
    await flushPromises()

    expect(activityApi.resolveLauncher).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'terminal', kind: 'terminal' }),
      '/w',
    )
    expect(activityApi.spawnActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'terminal',
        title: 'Terminal',
        launch: expect.objectContaining({
          command: '/bin/zsh',
          cwd: '/w',
        }),
      }),
      {},
      null,
    )
    expect(useWorkbenchStore().activeActivityId).toMatch(/^terminal:/)
    expect(document.body.querySelector('[data-quick-open]')).toBeNull()
  })

  it('opens returned routine runs as PTY surfaces and reruns the current routine definition', async () => {
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:core:routines"]').trigger('click')
    await flushPromises()
    const run = {
      id: 'routine:manual',
      kind: 'routine',
      title: 'Morning review',
      status: 'working',
      workspacePath: '/w',
      createdAt: '2026-07-25T12:00:00Z',
      updatedAt: '2026-07-25T12:00:00Z',
      retention: 'durable',
      source: { routineId: 'morning', presetId: 'review' },
      host: { type: 'pty' },
      launch: {
        command: '/bin/codex',
        args: ['exec', 'original prompt'],
        cwd: '/w',
        env: {},
      },
    }

    wrapper.findComponent({ name: 'RoutinesActivity' }).vm.$emit('openActivity', run)
    await flushPromises()

    expect(useWorkbenchStore().activeActivityId).toBe('routine:manual')
    expect(wrapper.get('[data-terminal-stub="routine:manual"]').exists()).toBe(true)
    expect(await window.__mimir_activityPaste('hello')).toBe(true)
    expect(terminalPaste).toHaveBeenCalledWith('hello')

    const freshRun = { ...run, id: 'routine:fresh', launch: { ...run.launch, args: ['fresh prompt'] } }
    routinesApi.runRoutineNow.mockResolvedValue({
      activity: freshRun,
      scheduledFor: '2026-07-25T12:00:00Z',
    })
    wrapper.findAllComponents({ name: 'TerminalActivity' })
      .find((component) => component.props('activity').id === run.id)
      .vm.$emit('restart', { activity: run })
    await flushPromises()

    expect(routinesApi.runRoutineNow).toHaveBeenCalledWith('morning')
    expect(useWorkbenchStore().activeActivityId).toBe('routine:fresh')
    expect(wrapper.get('[data-terminal-stub="routine:fresh"]').exists()).toBe(true)
  })

  it('opens an installed singleton app directly from its Tool row', async () => {
    const wrapper = await render({ workspace: '/w' })

    await wrapper.get('[data-sidebar-row="tool:app:ledger"]').trigger('click')
    await flushPromises()

    expect(appsApi.resolveAppLaunch).toHaveBeenCalledWith('ledger', '/w')
    expect(useWorkbenchStore().activeActivityId).toBe('app:ledger')
    expect(wrapper.get('[data-activity-surface="app:ledger"]').exists()).toBe(true)
    expect(wrapper.find('[data-main-tab="app:ledger"]').exists()).toBe(true)
    expect(wrapper.get('[data-sidebar-row="tool:app:ledger"] button').attributes('aria-current')).toBe('page')
  })

  it('lands keyboard focus inside the Business graph after its Tool row is clicked', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps',
      diagnostics: [],
      apps: [{
        id: 'business-graph',
        title: 'Business graph',
        mode: 'rust-helper',
        helper: 'business-graph',
        builtin: true,
        tools: [],
      }],
    })
    appsApi.resolveAppLaunch.mockResolvedValue({
      mode: 'rust-helper',
      appId: 'business-graph',
      helper: 'business-graph',
    })
    const wrapper = await render({ workspace: '/w' })

    // WebKit does not focus Sidebar buttons on click, so the click alone
    // leaves focus on <body>; selection must move it into the surface.
    await wrapper.get('[data-sidebar-row="tool:app:business-graph"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    await nextTick()

    expect(useWorkbenchStore().activeActivityId).toBe('app:business-graph')
    const surface = wrapper.get('[data-activity-surface="app:business-graph"]').element
    expect(surface.contains(document.activeElement)).toBe(true)
  })

  it.each(['board', 'list', 'entries'])('opens a clicked Graph entry from %s through its Activity wrapper', async view => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps', diagnostics: [],
      apps: [{ id: 'business-graph', title: 'Graph', mode: 'rust-helper', helper: 'business-graph', builtin: true, tools: [] }],
    })
    appsApi.resolveAppLaunch.mockResolvedValue({ mode: 'rust-helper', appId: 'business-graph', helper: 'business-graph' })
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:app:business-graph"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    const graph = useBusinessGraphStore()
    graph.nodes = [{ id: 'issue-1', title: 'Open this entry', kind: 'issue', status: 'plan', tags: [], scopeId: 'project:alpha', updatedAt: '2026-09-13T10:00:00Z' }]
    const invokeFallback = vi.mocked(invoke).getMockImplementation()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'graph_query'
      ? Promise.resolve({ items: [...graph.nodes], total: graph.nodes.length, graphRevision: 1 })
      : invokeFallback?.(command, args))
    graph.error = ''
    await nextTick()
    if (view === 'entries') await wrapper.get('[data-graph-section="all"]').trigger('click')
    if (view === 'list') await wrapper.get('[data-graph-view="list"]').trigger('click')
    await flushPromises()
    const workbench = useWorkbenchStore()
    workbench.setPaneState('editor', 'rail')
    await nextTick()

    const selector = view === 'board' ? '[data-board-card="issue-1"]' : '[data-graph-node="issue-1"]'
    await wrapper.get(selector).trigger('click')
    await flushPromises()

    expect(editorOpenGraph).toHaveBeenCalledExactlyOnceWith({ id: 'issue-1' })
    expect(workbench.paneLayout.editor.state).toBe('expanded')
    expect(workbench.activeActivityId).toBe('app:business-graph')
    expect(wrapper.find(selector).exists()).toBe(true)
  })

  it('opens the Graph record requested from Scribe detail', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps', diagnostics: [],
      apps: ['scribe', 'business-graph'].map(id => ({
        id, title: id, mode: 'rust-helper', helper: id, builtin: true, tools: [],
      })),
    })
    appsApi.resolveAppLaunch.mockImplementation(async appId => ({
      mode: 'rust-helper', appId, helper: appId,
    }))
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:app:scribe"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    wrapper.findComponent({ name: 'ScribeApp' }).vm.$emit('openGraphNode', 'meeting-filed')
    await vi.dynamicImportSettled()
    await flushPromises()
    expect(useWorkbenchStore().activeActivityId).toBe('app:scribe')
    expect(useWorkbenchStore().paneLayout.editor.state).toBe('expanded')
    expect(editorOpenGraph).toHaveBeenCalledWith('meeting-filed')
  })

  it('does not reopen or focus the Editor when a delayed Graph open is canceled', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps', diagnostics: [],
      apps: [{ id: 'business-graph', title: 'Graph', mode: 'rust-helper', helper: 'business-graph', builtin: true, tools: [] }],
    })
    appsApi.resolveAppLaunch.mockResolvedValue({ mode: 'rust-helper', appId: 'business-graph', helper: 'business-graph' })
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:app:business-graph"]').trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()
    const workbench = useWorkbenchStore()
    workbench.setPaneState('editor', 'rail')
    const focusBefore = document.activeElement
    let finish
    editorOpenGraph.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    wrapper.findComponent({ name: 'BusinessGraphApp' }).vm.$emit('openGraphNode', { id: 'superseded' })
    await flushPromises()
    finish(null)
    await flushPromises()
    expect(editorOpenGraph).toHaveBeenCalledWith({ id: 'superseded' })
    expect(workbench.paneLayout.editor.state).toBe('rail')
    expect(workbench.activeActivityId).toBe('app:business-graph')
    expect(document.activeElement).toBe(focusBefore)
  })

  it('launches external Apps as one real PTY Activity from the plus menu and MCP', async () => {
    appsApi.loadAppsCatalog.mockResolvedValue({
      directory: '/home/me/.mimir/apps',
      diagnostics: [],
      apps: [
        {
          id: 'ledger',
          title: 'Ledger',
          description: 'Project instrument.',
          mode: 'embedded',
          builtin: false,
          tools: [],
        },
        {
          id: 'review-runner',
          title: 'Review runner',
          description: 'Run review.',
          mode: 'terminal',
          builtin: false,
          tools: [],
        },
      ],
    })
    appsApi.resolveAppLaunch.mockImplementation(async (id) => (
      id === 'review-runner'
        ? {
            mode: 'terminal',
            appId: id,
            preset: 'review',
            args: ['--app-flag'],
            env: { APP_CHANNEL: 'review', MIMIR_ACTIVITY_ID: 'must-not-win' },
          }
        : { mode: 'embedded', appId: id, url: 'app://localhost/ledger/index.html' }
    ))
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()

    useWorkbenchStore().setPaneState('activity', 'rail')
    await chooseActivitySource(wrapper, 'Review runner')
    const sidebarRun = store.activities.find((activity) => activity.source?.appId === 'review-runner')
    expect(sidebarRun.id).toMatch(/^agent:/)
    expect(sidebarRun.launch.args).toContain('--app-flag')
    expect(sidebarRun.launch.env.APP_CHANNEL).toBe('review')
    expect(sidebarRun.launch.env.MIMIR_ACTIVITY_ID).toBe(sidebarRun.id)
    expect(store.byId('app:review-runner')).toBeNull()
    expect(wrapper.get(`[data-terminal-stub="${sidebarRun.id}"]`).exists()).toBe(true)
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')

    appsApi.resolveAppLaunch.mockResolvedValueOnce({
      mode: 'process',
      appId: 'review-runner',
      command: '/bin/tool',
      args: ['--exact'],
      cwd: '/w',
    })
    const processTool = await toolRuntimeConfig.current.launchApp('review-runner', 'process')
    await flushPromises()
    expect(store.byId(processTool.activityId)).not.toBeNull()
    expect(activityApi.spawnActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      launch: expect.objectContaining({ command: '/bin/tool', args: ['--exact'] }),
    }))
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')
    const processRun = store.activities.find((activity) => activity.launch?.command === '/bin/tool')
    wrapper.findAllComponents({ name: 'TerminalActivity' })
      .find((component) => component.props('activity').id === processRun.id)
      .vm.$emit('restart', { activity: processRun })
    await flushPromises()
    const restarted = activityApi.spawnActivity.mock.calls.at(-1)[0]
    expect(restarted.launch.args).toEqual(['--exact'])
    expect(restarted.launch.env.MIMIR_ACTIVITY_ID).toBe(restarted.id)
    expect(restarted.launch.env.MIMIR_MCP_URL).toBe('http://127.0.0.1:17532/mcp')

    const toolResult = await toolRuntimeConfig.current.launchApp('review-runner', 'terminal')
    expect(toolResult.activityId).toMatch(/^agent:/)
    expect(store.byId('app:review-runner')).toBeNull()

    appsApi.resolveAppLaunch.mockResolvedValueOnce({
      mode: 'terminal',
      appId: 'review-runner',
      preset: 'missing',
      args: [],
      env: {},
    })
    await expect(
      toolRuntimeConfig.current.launchApp('review-runner', 'terminal'),
    ).rejects.toThrow("Launcher preset 'missing' is not configured")
  })

  it('closes and reopens a unique tool tab without replacing its surface', async () => {
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:app:ledger"]').trigger('click')
    await flushPromises()
    const originalSurface = wrapper.get('[data-activity-surface="app:ledger"]').element
    appsApi.resolveAppLaunch.mockClear()
    activityApi.stopActivity.mockClear()
    activityApi.setActivityArchived.mockClear()

    const activityPane = wrapper.get('[data-pane="activity"]')
    activityPane.element.setAttribute('tabindex', '0')
    activityPane.element.focus()
    activityPane.element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    activityPane.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: true,
      bubbles: true,
    }))
    await flushPromises()

    expect(activityApi.stopActivity).not.toHaveBeenCalled()
    expect(activityApi.setActivityArchived).not.toHaveBeenCalled()
    expect(useActivitiesStore().byId('app:ledger').archivedAt).toBeNull()
    expect(useWorkbenchStore().activeActivityId).toBe('')
    expect(activityPane.attributes('data-pane-state')).toBe('expanded')

    await wrapper.get('[data-sidebar-row="tool:app:ledger"]').trigger('click')
    await flushPromises()
    expect(useActivitiesStore().byId('app:ledger').archivedAt).toBeNull()
    expect(wrapper.get('[data-activity-surface="app:ledger"]').element).toBe(originalSurface)
    expect(appsApi.resolveAppLaunch).not.toHaveBeenCalled()
  })

  it.each(['[data-main-tab="agent:failed"]', '[data-activity-key="agent:failed"]'])('archives the exact focused session with Cmd+W from %s', async selector => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:selected', 'Selected run', '2026-07-25T13:00:00Z'),
      status: 'done',
    })
    store.upsert({
      ...activityRecord('agent:failed', 'Failed run', '2026-07-25T12:00:00Z'),
      status: 'error',
      error: 'CLI exited before it could start',
    })
    useWorkbenchStore().openActivity('agent:selected')
    await nextTick()
    activityApi.setActivityArchived.mockClear()

    const failedRow = wrapper.get(selector)
    const failedRowButton = failedRow.get('button')
    failedRowButton.element.focus()
    failedRowButton.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await flushPromises()

    expect(activityApi.setActivityArchived).toHaveBeenCalledTimes(1)
    expect(activityApi.setActivityArchived).toHaveBeenCalledWith('agent:failed', true)
    expect(store.byId('agent:failed').archivedAt).toEqual(expect.any(String))
    expect(store.byId('agent:selected').archivedAt).toBeNull()
    expect(useWorkbenchStore().activeActivityId).toBe('agent:selected')
    expect(wrapper.find('[data-main-tab="agent:failed"]').exists()).toBe(false)
    expect(wrapper.find('[data-activity-key="agent:failed"]').exists()).toBe(false)
  })

  it('closes a live Activity before archiving it from the tab menu', async () => {
    const wrapper = await render({ workspace: '/w' })
    useActivitiesStore().upsert(
      activityRecord('agent:menu-archive', 'Menu archive', '2026-07-25T13:00:00Z'),
    )
    await nextTick()
    activityApi.closeActivity.mockClear()
    activityApi.setActivityArchived.mockClear()

    await wrapper.get('[data-main-tab="agent:menu-archive"]').trigger('contextmenu', { clientX: 300, clientY: 40 })
    await nextTick()
    const close = [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.includes('Stop and archive'))
    close.click()
    await flushPromises()

    expect(activityApi.closeActivity).toHaveBeenCalledWith('agent:menu-archive')
    expect(activityApi.setActivityArchived).not.toHaveBeenCalled()
  })

  it('switches to an existing unsaved document from Go to without reopening it', async () => {
    const wrapper = await render({ workspace: '/w' })
    const files = useFileStore()
    files.newFile()
    const first = files.currentFile.id
    files.newFile()
    const count = files.openFiles.length
    const picker = wrapper.findComponent({ name: 'QuickOpen' })
    await nextTick()
    expect(picker.props('documents').some(tab => tab.id === first)).toBe(true)
    picker.vm.$emit('activate', { type: 'document', documentId: first })
    await flushPromises()
    expect(files.currentFile.id).toBe(first)
    expect(files.openFiles).toHaveLength(count)
    expect(editorOpen).not.toHaveBeenCalled()
    expect(useWorkbenchStore().paneLayout.editor.state).toBe('expanded')
  })

  it('opens a Files result in the mounted Editor without changing Activity', async () => {
    const wrapper = await render({ workspace: '/w' })
    expect(useWorkbenchStore().activeActivityId).toBe('')

    await wrapper.get('[data-file-row="/w/README.md"] button').trigger('dblclick')
    await flushPromises()

    expect(editorOpen).toHaveBeenCalledWith('/w/README.md', {
      preview: false,
      entry: expect.objectContaining({ openBehavior: 'text' }),
    })
    expect(useWorkbenchStore().activeActivityId).toBe('')
  })

  it('preserves preview and pin requests when revealing a Files content match', async () => {
    const wrapper = await render({ workspace: '/w' })
    const files = wrapper.findAllComponents({ name: 'FilesActivity' }).find(component => component.props('compact'))
    const match = { path: '/w/README.md', line: 4, column: 3, entry: { openBehavior: 'text' } }
    for (const preview of [true, false]) {
      files.vm.$emit('openFile', { ...match, preview })
      await flushPromises()
      expect(editorReveal).toHaveBeenLastCalledWith({ ...match, preview })
    }
  })

  it('reveals a terminal file reference at its source location', async () => {
    const wrapper = await render({ workspace: '/w' })
    const activity = activityRecord('agent:links', 'Link test', '2026-08-25T12:00:00Z')
    useActivitiesStore().upsert(activity)
    useWorkbenchStore().openActivity(activity.id)
    await vi.dynamicImportSettled()
    await flushPromises()
    await nextTick()

    wrapper.findAllComponents({ name: 'TerminalActivity' })
      .find(component => component.props('activity').id === activity.id)
      .vm.$emit('openFile', {
        path: '/w/src/App.vue',
        line: 42,
        column: 8,
      })
    await flushPromises()

    expect(editorReveal).toHaveBeenCalledWith({
      path: '/w/src/App.vue',
      line: 42,
      column: 8,
    })
  })

  it('opens a Git change from Files in the mounted Editor review surface', async () => {
    const wrapper = await render({ workspace: '/w' })
    const request = {
      workspacePath: '/w',
      file: 'README.md',
      scope: 'unstaged',
    }

    wrapper.findComponent({ name: 'FilesActivity' }).vm.$emit('reviewGit', request)
    await flushPromises()

    expect(editorReviewGit).toHaveBeenCalledWith(request)
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
    expect(useWorkbenchStore().activeActivityId).toBe('')
  })

  it('starts a focused agent Activity from a Git review', async () => {
    const wrapper = await render({ workspace: '/w' })

    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('reviewGitWithAgent', {
      workspacePath: '/w',
      path: 'src/main.js',
      status: 'modified',
      scope: 'unstaged',
      presetId: 'review',
    })
    await flushPromises()

    expect(activityApi.resolveLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'review' }),
      '/w',
    )
    expect(activityApi.spawnActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review · main.js',
        retention: 'durable',
        source: expect.objectContaining({
          type: 'git-review',
          gitPath: 'src/main.js',
          gitScope: 'unstaged',
        }),
        launch: expect.objectContaining({ args: ['review'] }),
      }),
      {},
      null,
    )
    expect(activityApi.writeActivity).toHaveBeenCalledWith(
      expect.stringMatching(/^agent:/),
      expect.stringContaining('Review the Git change for src/main.js.'),
    )
    expect(activityApi.writeActivity.mock.calls.at(-1)[1]).toContain('My question or instruction: ')
    expect(activityApi.writeActivity.mock.calls.at(-1)[1]).not.toMatch(/[\r\n]/)
    expect(useWorkbenchStore().activeActivityId).toMatch(/^agent:/)
  })

  it('contains workbench shortcuts inside Quick Open and resumes them after close', async () => {
    const wrapper = await render({ workspace: '/w' })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    expect(wrapper.get('[data-quick-open]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 280px')

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    expect(editorClose).not.toHaveBeenCalled()

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('closeRequest')
    await nextTick()
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    expect(editorClose).not.toHaveBeenCalled()

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
  })

  it('opens Quick Open from native macOS Go to unless a modal owns input', async () => {
    const wrapper = await render({ workspace: '/w' })
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)

    try {
      wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('quickOpenRequest')
      await nextTick()
      expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    } finally {
      modal.remove()
    }

    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('quickOpenRequest')
    await nextTick()

    expect(wrapper.get('[data-quick-open]').exists()).toBe(true)
  })

  it('creates an Editor document with Cmd+N from a CLI panel', async () => {
    const wrapper = await render({ workspace: '/w' })
    const record = {
      ...activityRecord('agent:review', 'Review with Codex', '2026-07-29T10:00:00Z'),
      source: { presetId: 'review', launcherId: 'codex' },
    }
    useActivitiesStore().upsert(record)
    useWorkbenchStore().openActivity(record.id)
    await vi.dynamicImportSettled()
    await nextTick()

    const terminal = wrapper.get('[data-terminal-stub="agent:review"]')
    terminal.element.setAttribute('tabindex', '0')
    terminal.element.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await nextTick()

    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    expect(editorNew).toHaveBeenCalledTimes(1)
    expect(useWorkbenchStore().paneLayout.editor.state).toBe('expanded')
  })

  it('routes the embedded native New action to an Editor document', async () => {
    const wrapper = await render({ workspace: '/w' })
    const record = {
      ...activityRecord('agent:review', 'Review with Codex', '2026-07-29T10:00:00Z'),
      source: { presetId: 'review', launcherId: 'codex' },
    }
    useActivitiesStore().upsert(record)
    useWorkbenchStore().openActivity(record.id)
    await vi.dynamicImportSettled()
    await nextTick()

    const terminal = wrapper.get('[data-terminal-stub="agent:review"]')
    terminal.element.setAttribute('tabindex', '0')
    terminal.element.focus()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('newRequest')
    await nextTick()

    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
    expect(editorNew).toHaveBeenCalledTimes(1)

    wrapper.get('[data-editor-stub]').element.focus()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('newRequest')

    expect(editorNew).toHaveBeenCalledTimes(2)
  })

  it('routes Escape through the Go to hierarchy before closing the root', async () => {
    const wrapper = await render({ workspace: '/w' })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    await wrapper.get('[data-quick-open-type="new-activity-enter"]').trigger('click')
    expect(wrapper.get('[data-quick-open-type="new-activity"]').exists()).toBe(true)
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(false)

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.get('[data-quick-open]').exists()).toBe(true)
    expect(wrapper.get('[data-quick-open-type="new-activity-enter"]').exists()).toBe(true)

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
  })

  it('keeps closed work out of the Sidebar and resumes it through @ History', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:closed', 'Review sidebar order', '2026-07-25T12:00:00Z'),
      status: 'done',
      archivedAt: '2026-07-25T13:00:00Z',
      source: { presetId: 'review' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: {
        runId: 'run-1',
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        exit: { reason: 'completed', code: 0 },
      },
    })
    await nextTick()

    expect(wrapper.find('[data-main-tab="agent:closed"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Archived')

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    const input = wrapper.get('[data-quick-open-input]')
    await input.setValue('@')
    expect(wrapper.get('[data-quick-open-scope]').text()).toBe('History')
    expect(wrapper.get('[data-quick-open-type="history"]').text()).toContain('Review sidebar order')

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(activityApi.setActivityArchived).not.toHaveBeenCalledWith('agent:closed', false)
    expect(activityApi.respawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent:closed',
      launch: expect.objectContaining({
        args: ['resume', '11111111-1111-4111-8111-111111111111'],
      }),
    }), {}, '11111111-1111-4111-8111-111111111111')
    expect(store.byId('agent:closed').archivedAt).toBeNull()
    expect(store.byId('agent:closed').session.runId).toBe('run-2')
    expect(useWorkbenchStore().activeActivityId).toBe('agent:closed')
    expect(wrapper.get('[data-main-tab="agent:closed"]').exists()).toBe(true)
  })

  it('switches projects before restoring work from global History', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:other-history', 'Other project review', '2026-07-25T12:00:00Z'),
      workspacePath: '/other/project',
      status: 'done',
      archivedAt: '2026-07-25T13:00:00Z',
      source: { presetId: 'review' },
      host: { type: 'pty' },
      launch: { command: '/bin/codex', args: [], cwd: '/other/project', env: {} },
    })
    store.upsert({
      ...activityRecord('agent:local-history', 'Local review', '2026-07-25T11:00:00Z'),
      status: 'done',
      archivedAt: '2026-07-25T12:00:00Z',
    })
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    const input = wrapper.get('[data-quick-open-input]')

    await input.setValue('@')
    expect(wrapper.find('[data-quick-open-key="history:agent:local-history"]').exists()).toBe(true)
    expect(wrapper.find('[data-quick-open-key="history:agent:other-history"]').exists()).toBe(false)

    await input.setValue('@Other project review')
    const otherRow = wrapper.get('[data-quick-open-key="history:agent:other-history"]')
    expect(otherRow.get('[data-quick-open-project]').text()).toBe('project')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(fileApi.openWorkspaceIndex).toHaveBeenLastCalledWith('/other/project')
    expect(useSettingsStore().mimirWorkspaceFolder).toBe('/other/project')
    expect(store.byId('agent:other-history').archivedAt).toBeNull()
    expect(useWorkbenchStore().activeActivityId).toBe('agent:other-history')
    expect(wrapper.find('[data-main-tab="agent:other-history"]').exists()).toBe(true)
  })

  it('resumes an archived PTY routine when Rust omits its null archivedAt field', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    const routineId = 'routine:briefing:one'
    store.upsert({
      ...activityRecord(routineId, 'Briefing', '2026-07-25T12:00:00Z'),
      kind: 'routine',
      status: 'done',
      archivedAt: '2026-07-25T13:00:00Z',
      source: { routineId: 'briefing', presetId: 'review' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: {
        runId: 'run-1',
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        exit: { reason: 'completed', code: 0 },
      },
    })
    activityApi.respawnActivity.mockImplementationOnce(async (request, _size, cliSessionId) => {
      const { archivedAt: _archivedAt, ...record } = request
      return {
        record: {
          ...record,
          status: 'idle',
          updatedAt: '2026-07-25T13:00:01Z',
          session: { runId: 'run-2', cliSessionId },
        },
        scrollback: { chunks: [] },
        live: true,
      }
    })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
    }))
    await nextTick()
    const input = wrapper.get('[data-quick-open-input]')
    await input.setValue('@')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(activityApi.setActivityArchived).not.toHaveBeenCalledWith(routineId, false)
    expect(activityApi.respawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: routineId,
      launch: expect.objectContaining({
        args: ['resume', '11111111-1111-4111-8111-111111111111'],
      }),
    }), {}, '11111111-1111-4111-8111-111111111111')
    expect(store.byId(routineId).archivedAt).toBeNull()
    expect(store.byId(routineId).session.runId).toBe('run-2')
    expect(useWorkbenchStore().activeActivityId).toBe(routineId)
    expect(wrapper.find('[data-activity-missing]').exists()).toBe(false)
    expect(wrapper.get(`[data-terminal-stub="${routineId}"]`).exists()).toBe(true)
  })

  it('steps interface zoom with modifier chords and resets with 0, even behind a modal', async () => {
    await render()
    const settings = useSettingsStore()
    const zoomChord = (key, code) => new KeyboardEvent('keydown', {
      key,
      code,
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    document.dispatchEvent(zoomChord('=', 'Equal'))
    await nextTick()
    expect(settings.workbenchZoom).toBe(110)

    document.dispatchEvent(zoomChord('=', 'Equal'))
    await nextTick()
    expect(settings.workbenchZoom).toBe(125)

    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    try {
      document.dispatchEvent(zoomChord('-', 'Minus'))
      await nextTick()
      expect(settings.workbenchZoom).toBe(110)

      document.dispatchEvent(zoomChord('0', 'Digit0'))
      await nextTick()
      expect(settings.workbenchZoom).toBe(100)
    } finally {
      modal.remove()
    }
  })

  it('does not route global workbench shortcuts behind a teleported modal', async () => {
    const wrapper = await render()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }))
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        bubbles: true,
      }))
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b',
        metaKey: true,
        bubbles: true,
      }))
      await nextTick()

      expect(wrapper.find('[data-quick-open]').exists()).toBe(false)
      expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 280px')
    } finally {
      modal.remove()
    }
  })

  it('keeps Activity-row keyboard switching in the navigator and Editor switching horizontal', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert(activityRecord('agent:one', 'One', '2026-07-25T10:00:00Z'))
    store.upsert(activityRecord('agent:two', 'Two', '2026-07-25T09:00:00Z'))
    await nextTick()

    const first = wrapper.get('[data-main-tab="agent:one"]').find('button')
    first.element.focus()
    await first.trigger('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      altKey: true,
    })
    await nextTick()

    expect(useWorkbenchStore().activeActivityId).toBe('agent:two')
    await flushPromises()
    expect(terminalFocus).toHaveBeenCalled()

    const editor = wrapper.get('[data-editor-stub]')
    editor.element.focus()
    await editor.trigger('keydown', {
      key: 'ArrowLeft',
      metaKey: true,
      altKey: true,
    })
    expect(editorCycle).toHaveBeenLastCalledWith(-1)
  })

  it('cycles Activities after a Sidebar click that leaves focus on body (WebKit)', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert(activityRecord('agent:one', 'One', '2026-07-25T10:00:00Z'))
    store.upsert(activityRecord('agent:two', 'Two', '2026-07-25T09:00:00Z'))
    await nextTick()

    // WebKit does not focus buttons on click: the row click selects the
    // Activity while document focus stays on <body>.
    const row = wrapper.get('[data-main-tab="agent:one"]')
    row.find('button').element.dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    )
    await row.find('button').trigger('click')
    await nextTick()
    expect(useWorkbenchStore().activeActivityId).toBe('agent:one')
    expect(document.activeElement).toBe(document.body)

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      altKey: true,
      bubbles: true,
    }))
    await nextTick()
    expect(useWorkbenchStore().activeActivityId).toBe('agent:two')
  })

  it('closes the clicked Sidebar row with Cmd+W while focus stays on body (WebKit)', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:ended', 'Ended run', '2026-07-25T10:00:00Z'),
      status: 'done',
    })
    await nextTick()
    activityApi.setActivityArchived.mockClear()

    const row = wrapper.get('[data-main-tab="agent:ended"]')
    row.find('button').element.dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    )
    await row.find('button').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(document.body)

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await flushPromises()

    expect(activityApi.setActivityArchived).toHaveBeenCalledWith('agent:ended', true)
    expect(store.byId('agent:ended').archivedAt).toEqual(expect.any(String))
  })

  it('hands focus between pane controls and visible rails in both directions', async () => {
    const wrapper = await render()

    const activityCollapse = wrapper.get('[data-pane-action="collapse"]')
    activityCollapse.element.focus()
    await activityCollapse.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-pane-restore="activity"]').element)

    await wrapper.get('[data-pane-restore="activity"]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[aria-label="All tabs"]').element)

    const sidebarCollapse = wrapper.get('[data-sidebar-collapse]')
    sidebarCollapse.element.focus()
    await sidebarCollapse.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-restore]').element)

    await wrapper.get('[data-sidebar-restore]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-collapse]').element)
  })

  it('routes native-menu close by remembered focus and rails the last Activity/Editor', async () => {
    const wrapper = await render({ workspace: '/w' })
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:ended', 'Finished review', '2026-07-25T10:00:00Z'),
      status: 'done',
    })
    await nextTick()

    const row = wrapper.get('[data-main-tab="agent:ended"]')
    await row.find('[role=tab]').trigger('click')
    row.find('button').element.focus()
    row.find('button').element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('closeRequest')
    await flushPromises()

    expect(activityApi.setActivityArchived).toHaveBeenCalledWith('agent:ended', true)
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')

    useFileStore().newFile()
    wrapper.get('[data-editor-stub]').element.focus()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('closeRequest')
    expect(editorClose).toHaveBeenCalledTimes(1)
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('empty')
    await nextTick()
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('rail')
  })

  it('adapts narrow windows to one focused surface and preserves panel choices when widened', async () => {
    const wrapper = await render({ workspace: '/w' })
    useFileStore().newFile()
    const activityPane = wrapper.get('[data-pane="activity"]')
    activityPane.element.setAttribute('tabindex', '0')
    activityPane.element.focus()
    activityPane.element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    window.innerWidth = 700
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('rail')

    await wrapper.get('[data-file-row="/w/README.md"] button').trigger('dblclick')
    await flushPromises()
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')

    window.innerWidth = 900
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')

    window.innerWidth = 800
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')

    window.innerWidth = 1280
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
  })

  it.each(['sidebar', 'activity', 'editor'])('keeps a manual %s collapse across wider window boundaries', async (pane) => {
    window.innerWidth = 700
    const wrapper = await render({ workspace: '/w' })
    const workbench = useWorkbenchStore()
    workbench.setPaneState(pane, 'rail')
    await nextTick()
    for (const width of [800, 1039, 1040, 1500]) {
      window.innerWidth = width
      window.dispatchEvent(new Event('resize'))
      await nextTick()
      expect(workbench.paneLayout[pane].state).toBe('rail')
    }
    if (pane === 'editor') {
      expect(useFileStore().currentFile).toBeFalsy()
      expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('rail')
      expect(editorNew).not.toHaveBeenCalled()
    }
    wrapper.unmount()
    expect(useSettingsStore().workbenchLayout[pane].state).toBe('rail')
  })

  it('restores persisted widths but refuses to boot with the Editor hidden', async () => {
    localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({
      mimirWorkspaceFolder: '/w',
      workbenchLayout: {
        sidebar: { state: 'rail', width: 300 },
        activity: { state: 'expanded', width: 610 },
        editor: { state: 'rail', width: 640 },
        activeActivityId: 'files',
      },
    }))

    const wrapper = await render()
    const workbench = useWorkbenchStore()

    expect(workbench.paneLayout.sidebar).toEqual({ state: 'rail', width: 300 })
    expect(workbench.paneLayout.editor).toEqual({ state: 'expanded', width: 640 })
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
    expect(wrapper.get('[data-pane-stage="editor"]').attributes('aria-hidden')).toBe('false')
  })

  it('flushes the latest layout immediately when the Workbench unmounts', async () => {
    const wrapper = await render()
    const settings = useSettingsStore()
    const flush = vi.spyOn(settings, 'flush')
    useWorkbenchStore().setPaneWidth('editor', 701)

    wrapper.unmount()
    await flushPromises()

    expect(flush).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(storage.get('mimir:editor:settings:v1'))
    expect(persisted.workbenchLayout.editor.width).toBe(701)
  })
})

function activityRecord(id, title, updatedAt) {
  return {
    id,
    title,
    kind: 'agent',
    status: 'working',
    workspacePath: '/w',
    createdAt: updatedAt,
    updatedAt,
    retention: 'durable',
    source: { presetId: 'codex' },
    host: { type: 'pty' },
    launch: { command: '/bin/codex', args: [], cwd: '/w', env: {} },
  }
}
