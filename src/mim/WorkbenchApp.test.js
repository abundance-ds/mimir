import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editorOpen = vi.hoisted(() => vi.fn())
const toolRuntimeStart = vi.hoisted(() => vi.fn())
const toolRuntimeStop = vi.hoisted(() => vi.fn())
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
      setup(_props, { expose }) {
        expose({ mimOpen: editorOpen })
        return () => h('div', { 'data-editor-stub': '' }, 'Editor')
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
      setup(props) {
        return () => h('div', {
          'data-terminal-stub': props.activity.id,
          'data-active': String(props.active),
        })
      },
    }),
  }
})

vi.mock('../services/activities.js', () => ({
  listActivities: vi.fn(),
  listenToActivityEvents: vi.fn(),
  resolveLauncher: vi.fn(),
  spawnActivity: vi.fn(),
  stopActivity: vi.fn(),
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

vi.mock('../services/toolRuntime.js', () => ({
  createToolRuntime: vi.fn(() => ({
    start: toolRuntimeStart,
    stop: toolRuntimeStop,
  })),
}))

import * as activityApi from '../services/activities.js'
import * as fileApi from '../services/fileIndex.js'
import * as launcherApi from '../services/launchers.js'
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
    toolRuntimeStart.mockReset()
    toolRuntimeStop.mockReset()
    toolRuntimeStart.mockResolvedValue()
    toolRuntimeStop.mockResolvedValue()
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)

    launcherApi.detectAgents.mockResolvedValue([
      { id: 'codex', title: 'Codex', installed: true, binaryPath: '/bin/codex' },
      { id: 'claude', title: 'Claude', installed: false, diagnostic: 'binary not found' },
    ])
    launcherApi.loadLauncherConfig.mockResolvedValue({
      path: '/home/me/.mim/launchers.json',
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
    activityApi.stopActivity.mockResolvedValue()

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
      localStorage.setItem('mim:editor:settings:v1', JSON.stringify({
        mimWorkspaceFolder: workspace,
      }))
    }
    const wrapper = mount(WorkbenchApp, {
      global: {
        plugins: [pinia],
        stubs: {
          Teleport: true,
          Transition: false,
        },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    await nextTick()
    return wrapper
  }

  it('composes the lean three-pane shell and complete stable launch tray', async () => {
    const wrapper = await render()
    const rows = wrapper.findAll('[data-sidebar-row]').map((row) => row.attributes('data-sidebar-row'))

    expect(wrapper.get('[data-pane="sidebar"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="activity"]').exists()).toBe(true)
    expect(wrapper.get('[data-pane="editor"]').exists()).toBe(true)
    expect(wrapper.get('[data-editor-stub]').exists()).toBe(true)
    expect(toolRuntimeStart).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      'launcher:core:files',
      'launcher:preset:review',
      'launcher:preset:claude',
      'launcher:core:apps',
      'launcher:core:routines',
    ])
    expect(wrapper.get('[data-activity-surface="files"]').exists()).toBe(true)
  })

  it('keeps unavailable launchers visible and explains the exact problem', async () => {
    const wrapper = await render()
    const claude = wrapper.get('[data-sidebar-row="launcher:preset:claude"]')

    expect(claude.attributes('data-launcher-available')).toBe('false')
    expect(claude.attributes('title')).toContain('binary not found')
    await claude.trigger('click')

    expect(wrapper.get('[data-workbench-diagnostic]').text()).toContain(
      'Claude is unavailable: binary not found',
    )
    expect(activityApi.resolveLauncher).not.toHaveBeenCalled()
  })

  it('launches an available preset in the selected workspace', async () => {
    const wrapper = await render({ workspace: '/w' })
    await wrapper.get('[data-sidebar-row="launcher:preset:review"]').trigger('click')
    await flushPromises()

    expect(fileApi.openWorkspaceIndex).toHaveBeenCalledWith('/w')
    expect(activityApi.resolveLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'review', args: ['review'] }),
      '/w',
    )
    expect(activityApi.spawnActivity).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'agent',
      launch: expect.objectContaining({
        command: '/bin/codex',
        args: ['review'],
        cwd: '/w',
      }),
    }))
    expect(useWorkbenchStore().activeActivityId).toMatch(/^agent:/)
  })

  it('opens a Files result in the mounted Editor without changing Activity', async () => {
    const wrapper = await render({ workspace: '/w' })
    expect(useWorkbenchStore().activeActivityId).toBe('files')

    await wrapper.get('[data-file-row="/w/README.md"]').trigger('dblclick')
    await flushPromises()

    expect(editorOpen).toHaveBeenCalledWith('/w/README.md')
    expect(useWorkbenchStore().activeActivityId).toBe('files')
  })

  it('uses global Quick Open and toggles the same Sidebar into its 52px rail', async () => {
    const wrapper = await render({ workspace: '/w' })
    const filesRow = wrapper.get('[data-sidebar-row="launcher:core:files"]').element

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
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
    expect(wrapper.get('[data-sidebar-row="launcher:core:files"]').element).toBe(filesRow)
  })

  it('restores persisted rail states and widths before ordinary use', async () => {
    localStorage.setItem('mim:editor:settings:v1', JSON.stringify({
      mimWorkspaceFolder: '/w',
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
    expect(workbench.paneLayout.editor).toEqual({ state: 'rail', width: 640 })
    expect(wrapper.get('[data-pane="sidebar"]').attributes('style')).toContain('width: 52px')
    expect(wrapper.get('[data-pane-restore="editor"]').exists()).toBe(true)
  })
})
