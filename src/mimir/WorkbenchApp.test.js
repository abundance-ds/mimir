import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editorOpen = vi.hoisted(() => vi.fn())
const editorOpenSettings = vi.hoisted(() => vi.fn())
const editorClose = vi.hoisted(() => vi.fn())
const editorCycle = vi.hoisted(() => vi.fn())
const editorNew = vi.hoisted(() => vi.fn())
const terminalPaste = vi.hoisted(() => vi.fn())
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
      },
      emits: ['closeRequest', 'empty', 'navigateEditor', 'newRequest'],
      setup(_props, { expose }) {
        expose({
          mimirOpen: editorOpen,
          mimirOpenSettings: editorOpenSettings,
          mimirCloseActiveTab: editorClose,
          mimirCycleTab: editorCycle,
          mimirNewFile: editorNew,
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
      emits: ['restart'],
      setup(props, { expose }) {
        expose({ pasteText: terminalPaste })
        return () => h('div', {
          'data-terminal-stub': props.activity.id,
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
import { useFileStore } from '../stores/files.js'
import { useLaunchersStore } from '../stores/launchers.js'
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
    editorOpen.mockReset()
    editorOpenSettings.mockReset()
    editorClose.mockReset()
    editorCycle.mockReset()
    editorNew.mockReset()
    terminalPaste.mockReset()
    terminalPaste.mockResolvedValue(true)
    toolRuntimeStart.mockReset()
    toolRuntimeStop.mockReset()
    toolRuntimeConfig.current = null
    toolRuntimeStart.mockResolvedValue()
    toolRuntimeStop.mockResolvedValue()
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)
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
  })

  async function render({ workspace = '' } = {}) {
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
          Teleport: true,
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
    await wrapper.get('[data-activity-create-button]').trigger('click')
    const menu = document.body.querySelector('[data-activity-create-menu]')
    const option = [...menu.querySelectorAll('[data-activity-create-option]')]
      .find(candidate => candidate.textContent.includes(label))
    expect(option, `${label} activity source`).toBeTruthy()
    option.click()
    await flushPromises()
  }

  it('composes the lean three-pane shell and compact launch menu', async () => {
    const wrapper = await render()
    const rows = wrapper.findAll('[data-sidebar-row]').map((row) => row.attributes('data-sidebar-row'))

    expect(wrapper.get('[data-pane="sidebar"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="activity"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="editor"]').exists()).toBe(true)
    expect(wrapper.get('[data-editor-stub]').exists()).toBe(true)
    expect(toolRuntimeStart).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      'tool:core:files',
      'tool:core:routines',
      'tool:app:ledger',
    ])
    expect(wrapper.get('[data-activity-surface="files"]').exists()).toBe(true)
    await wrapper.get('[data-activity-create-button]').trigger('click')
    const review = document.body.querySelector(
      '[data-activity-create-id="preset:review"]',
    )
    expect(review).toBeTruthy()
    expect(review.querySelector('svg').getAttribute('viewBox')).toBe('0 0 256 260')
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
    await wrapper.get('[data-activity-create-button]').trigger('click')
    expect(document.body.querySelector(
      '[data-activity-create-id="app:review-runner"]',
    )).toBeTruthy()
    expect(wrapper.text()).not.toContain('Changes')
  })

  it('persists and projects manual Tool order', async () => {
    const wrapper = await render()
    const settings = useSettingsStore()

    settings.set('sidebarToolOrder', [
      'app:ledger',
      'core:routines',
      'core:files',
      'app:not-installed',
    ])
    await nextTick()

    expect(wrapper.findAll('[data-tool-key]').map((row) => row.attributes('data-tool-key'))).toEqual([
      'app:ledger',
      'core:routines',
      'core:files',
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
      'core:files',
      'app:not-installed',
    ])
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

    await wrapper.get('[data-activity-create-button]').trigger('click')
    expect(document.body.querySelector(
      '[data-activity-create-id="preset:claude"]',
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
      .find(item => item.text().includes('/other/project'))
    await recent.trigger('click')
    await flushPromises()

    expect(fileApi.openWorkspaceIndex).toHaveBeenCalledWith('/other/project')
    expect(useSettingsStore().mimirWorkspaceFolder).toBe('/other/project')
    expect(useSettingsStore().recentWorkspaceFolders[0]).toBe('/other/project')
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

    wrapper.findComponent({ name: 'BusinessGraphApp' }).vm.$emit('startWork', {
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

    await wrapper.get('[data-activity-create-button]').trigger('click')
    const menu = document.body.querySelector('[data-activity-create-menu]')
    const terminal = [...menu.querySelectorAll('[data-activity-create-option]')]
      .find(option => option.textContent.includes('Terminal'))
    expect(menu.textContent).not.toContain('Chat')
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
    expect(document.body.querySelector('[data-activity-create-menu]')).toBeNull()
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
    expect(wrapper.find('[data-sidebar-row="activity:app:ledger"]').exists()).toBe(false)
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

  it('launches external Apps as one real PTY Activity from the plus menu, Settings, and MCP', async () => {
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

    useWorkbenchStore().setPaneState('activity', 'rail')
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('launchApp', {
      app: { id: 'review-runner', title: 'Review runner' },
      launch: { mode: 'process', command: '/bin/tool', args: ['--exact'], cwd: '/w' },
      activity: {
        id: 'app:review-runner:settings-placeholder',
        kind: 'app',
        title: 'Review runner',
        workspacePath: '/w',
      },
    })
    await flushPromises()
    expect(store.byId('app:review-runner:settings-placeholder')).toBeNull()
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

  it('collapses a stable Tool with Cmd+W without archiving its internal Activity', async () => {
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="tool:app:ledger"]').trigger('click')
    await flushPromises()
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
    expect(useWorkbenchStore().activeActivityId).toBe('app:ledger')
    expect(activityPane.attributes('data-pane-state')).toBe('rail')

    await wrapper.get('[data-sidebar-row="tool:app:ledger"]').trigger('click')
    await flushPromises()
    expect(useActivitiesStore().byId('app:ledger').archivedAt).toBeNull()
    expect(wrapper.get('[data-activity-surface="app:ledger"]').exists()).toBe(true)
  })

  it('archives the exact focused Activity row with Cmd+W even when it failed', async () => {
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

    const failedRow = wrapper.get('[data-sidebar-row="activity:agent:failed"]')
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
    expect(wrapper.find('[data-sidebar-row="activity:agent:failed"]').exists()).toBe(false)
  })

  it('opens a Files result in the mounted Editor without changing Activity', async () => {
    const wrapper = await render({ workspace: '/w' })
    expect(useWorkbenchStore().activeActivityId).toBe('files')

    await wrapper.get('[data-file-row="/w/README.md"] button').trigger('dblclick')
    await flushPromises()

    expect(editorOpen).toHaveBeenCalledWith('/w/README.md', {
      preview: false,
      entry: expect.objectContaining({ openBehavior: 'text' }),
    })
    expect(useWorkbenchStore().activeActivityId).toBe('files')
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
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 240px')

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

  it('opens New activity on Cmd+N in a CLI panel with its launcher selected', async () => {
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

    expect(wrapper.get('[data-quick-open-type="new-activity"]').exists()).toBe(true)
    expect(wrapper.find('[data-quick-open-type="new-activity-enter"]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-open-type="tool"]').exists()).toBe(false)
    expect(wrapper.get('[data-quick-open-key="new:preset:review"]').attributes('aria-selected'))
      .toBe('true')
    expect(editorNew).not.toHaveBeenCalled()

    await wrapper.get('[data-quick-open-input]').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(activityApi.resolveLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'review' }),
      '/w',
    )
  })

  it('routes the embedded native New action through the last focused pane', async () => {
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

    expect(wrapper.get('[data-quick-open-type="new-activity"]').exists()).toBe(true)
    expect(wrapper.get('[data-quick-open-key="new:preset:review"]').attributes('aria-selected'))
      .toBe('true')
    expect(editorNew).not.toHaveBeenCalled()

    await wrapper.get('[data-quick-open-backdrop]').trigger('click')
    wrapper.get('[data-editor-stub]').element.focus()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('newRequest')

    expect(editorNew).toHaveBeenCalledTimes(1)
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

    expect(wrapper.find('[data-sidebar-row="activity:agent:closed"]').exists()).toBe(false)
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
    expect(wrapper.get('[data-sidebar-row="activity:agent:closed"]').exists()).toBe(true)
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
      expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 240px')
    } finally {
      modal.remove()
    }
  })

  it('keeps Activity-row keyboard switching in the navigator and Editor switching horizontal', async () => {
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert(activityRecord('agent:one', 'One', '2026-07-25T10:00:00Z'))
    store.upsert(activityRecord('agent:two', 'Two', '2026-07-25T09:00:00Z'))
    await nextTick()

    const first = wrapper.get('[data-sidebar-row="activity:agent:one"]').find('button')
    first.element.focus()
    await first.trigger('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      altKey: true,
    })
    await nextTick()

    expect(useWorkbenchStore().activeActivityId).toBe('agent:two')
    expect(document.activeElement).toBe(
      wrapper.get('[data-sidebar-row="activity:agent:two"]').find('button').element,
    )

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
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert(activityRecord('agent:one', 'One', '2026-07-25T10:00:00Z'))
    store.upsert(activityRecord('agent:two', 'Two', '2026-07-25T09:00:00Z'))
    await nextTick()

    // WebKit does not focus buttons on click: the row click selects the
    // Activity while document focus stays on <body>.
    const row = wrapper.get('[data-sidebar-row="activity:agent:one"]')
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
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:ended', 'Ended run', '2026-07-25T10:00:00Z'),
      status: 'done',
    })
    await nextTick()
    activityApi.setActivityArchived.mockClear()

    const row = wrapper.get('[data-sidebar-row="activity:agent:ended"]')
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
    expect(document.activeElement).toBe(wrapper.get('[data-pane-action="expand"]').element)

    const sidebarCollapse = wrapper.get('[data-sidebar-collapse]')
    sidebarCollapse.element.focus()
    await sidebarCollapse.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-pane-action="restore-sidebar"]').element)

    await wrapper.get('[data-pane-action="restore-sidebar"]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-collapse]').element)
  })

  it('routes native-menu close by remembered focus and rails the last Activity/Editor', async () => {
    const wrapper = await render()
    const store = useActivitiesStore()
    store.upsert({
      ...activityRecord('agent:ended', 'Finished review', '2026-07-25T10:00:00Z'),
      status: 'done',
    })
    await nextTick()

    const row = wrapper.get('[data-sidebar-row="activity:agent:ended"]')
    await row.trigger('click')
    row.find('button').element.focus()
    row.find('button').element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('closeRequest')
    await flushPromises()

    expect(activityApi.setActivityArchived).toHaveBeenCalledWith('agent:ended', true)
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('rail')

    useFileStore().newFile()
    wrapper.get('[data-editor-stub]').element.focus()
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('closeRequest')
    expect(editorClose).toHaveBeenCalledTimes(1)
    wrapper.findComponent({ name: 'EditorApp' }).vm.$emit('empty')
    await nextTick()
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('rail')
  })

  it('adapts narrow windows to one focused surface and restores the desktop layout', async () => {
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
    expect(wrapper.get('[data-pane="activity"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.get('[data-pane="editor"]').attributes('data-pane-state')).toBe('expanded')
    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 512px')

    window.innerWidth = 800
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="editor"]').attributes('style')).toContain('width: 412px')

    window.innerWidth = 1280
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 240px')
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
