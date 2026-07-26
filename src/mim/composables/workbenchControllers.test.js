import { computed, nextTick, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({
  openBusinessGraph: vi.fn(async () => {}),
}))

vi.mock('../../services/businessGraph.js', () => graph)

import { useActivitiesStore } from '../../stores/activities.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { useActivityLifecycle } from './useActivityLifecycle.js'
import { useWorkbenchKeyboardRouting } from './useWorkbenchKeyboardRouting.js'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap.js'

describe('Workbench controllers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.innerWidth = 1280
  })

  it('owns durable close finalization and core-pane collapse semantics', async () => {
    const records = reactive([
      activity('run:a', { retention: 'durable', status: 'idle' }),
      activity('run:b', { retention: 'ephemeral', status: 'idle' }),
    ])
    const activities = {
      records,
      byId: id => records.find(record => record.id === id) || null,
    }
    const activityRuntime = {
      stop: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      setArchived: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      launchPreset: vi.fn(),
      launchCommand: vi.fn(),
    }
    const workbench = reactive({
      activeActivityId: 'run:a',
      paneLayout: { activity: { state: 'expanded' } },
      openActivity: vi.fn((id) => {
        workbench.activeActivityId = id
      }),
      setPaneState: vi.fn((pane, state) => {
        workbench.paneLayout[pane].state = state
      }),
    })
    const controller = useActivityLifecycle({
      activities,
      activityRuntime,
      launchers: { byId: vi.fn() },
      workbench,
      workspacePath: ref('/w'),
      diagnostic: ref(''),
      coreActivityIds: new Set(['files']),
      getSidebarActivities: () => records,
      openCoreActivity: vi.fn(),
      selectActivity: id => workbench.openActivity(id),
      openActivityRecord: vi.fn(),
    })

    expect(await controller.closeActivity('run:a')).toBe(true)
    expect(workbench.activeActivityId).toBe('run:b')
    expect(activityRuntime.setArchived).toHaveBeenCalledWith('run:a', true)
    expect(controller.closingActivityIds.value.size).toBe(0)

    records.push(activity('files', { kind: 'files' }))
    expect(await controller.closeActivity('files')).toBe(false)
    expect(workbench.setPaneState).toHaveBeenLastCalledWith('activity', 'rail')
    controller.dispose()
  })

  it('routes close to the last meaningful focus owner after native chrome takes focus', () => {
    const quickOpen = ref(false)
    const closeActivity = vi.fn()
    const sidebar = document.createElement('aside')
    sidebar.dataset.pane = 'sidebar'
    sidebar.innerHTML = `
      <div data-sidebar-row="activity:run:a">
        <button data-row-button>Run</button>
      </div>
    `
    document.body.appendChild(sidebar)
    const button = sidebar.querySelector('[data-row-button]')
    const controller = useWorkbenchKeyboardRouting({
      quickOpen,
      settings: { workbenchZoom: 1, set: vi.fn() },
      editorRef: ref(null),
      editorFiles: { openFiles: [] },
      workbench: { activeActivityId: 'run:a' },
      sidebarActivities: computed(() => [{ id: 'run:a' }]),
      toggleSidebar: vi.fn(),
      selectActivity: vi.fn(),
      closeActivity,
      collapseEmptyEditor: vi.fn(),
    })

    button.focus()
    controller.rememberWorkbenchFocus({ target: button })
    sidebar.remove()
    controller.closeNativeFocusedSurface()

    expect(closeActivity).toHaveBeenCalledWith('run:a')
  })

  it('owns startup hydration, core Activities, and responsive Editor visibility', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    settings.settingsReady = true
    const activityRuntime = {
      initialize: vi.fn(async () => {}),
      error: '',
    }
    const launchers = { load: vi.fn(async () => {}) }
    const appsCatalog = { load: vi.fn(async () => {}) }
    const workspaceFiles = {
      workspacePath: '',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    const toolRuntime = { start: vi.fn(async () => {}) }
    const diagnostic = ref('')
    const openCoreActivity = vi.fn()
    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime,
      launchers,
      appsCatalog,
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime,
      diagnostic,
      coreActivities: [
        { id: 'files', kind: 'files', title: 'Files' },
        { id: 'routines', kind: 'routine', title: 'Routines' },
      ],
      openCoreActivity,
      getFocusOwner: () => 'none',
    })

    await controller.start()
    await nextTick()

    expect(activities.byId('files')?.host.type).toBe('renderer')
    expect(activities.byId('routines')?.retention).toBe('durable')
    expect(workbench.paneLayout.editor.state).toBe('expanded')
    expect(toolRuntime.start).toHaveBeenCalledTimes(1)
    expect(controller.initialized.value).toBe(true)
    controller.dispose()
  })
})

function activity(id, overrides = {}) {
  return {
    id,
    kind: 'terminal',
    title: id,
    status: 'idle',
    workspacePath: '/w',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    retention: 'durable',
    source: {},
    host: { type: 'renderer' },
    launch: {},
    ...overrides,
  }
}
