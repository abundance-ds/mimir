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

  it('resumes an interrupted agent inside its existing Activity row', async () => {
    const preset = { id: 'codex', title: 'Codex', kind: 'agent' }
    const interrupted = activity('agent:one', {
      kind: 'agent',
      status: 'interrupted',
      workspacePath: '',
      source: { presetId: 'codex' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    })
    const activityRuntime = {
      resumePreset: vi.fn(async () => interrupted),
      launchPreset: vi.fn(async () => {}),
    }
    const diagnostic = ref('')
    const controller = useActivityLifecycle({
      activities: { records: [], byId: () => null },
      activityRuntime,
      launchers: { byId: id => (id === 'codex' ? preset : null) },
      workbench: reactive({ activeActivityId: '', paneLayout: { activity: { state: 'normal' } } }),
      workspacePath: ref('/w'),
      diagnostic,
      coreActivityIds: new Set(),
      getSidebarActivities: () => [],
      openCoreActivity: vi.fn(),
      selectActivity: vi.fn(),
      openActivityRecord: vi.fn(),
    })

    await controller.restartActivity({ activity: interrupted })
    expect(activityRuntime.resumePreset).toHaveBeenCalledWith(
      preset,
      expect.objectContaining({ id: 'agent:one', workspacePath: '/w' }),
    )
    expect(activityRuntime.launchPreset).not.toHaveBeenCalled()

    const plain = activity('agent:two', {
      kind: 'agent',
      status: 'done',
      source: { presetId: 'codex' },
      host: { type: 'pty' },
    })
    await controller.restartActivity({ activity: plain })
    expect(activityRuntime.resumePreset).toHaveBeenCalledTimes(1)
    expect(activityRuntime.launchPreset).toHaveBeenCalledWith(preset, '/w', {
      kind: 'agent',
      title: 'agent:two',
    })
    expect(diagnostic.value).toBe('')
    controller.dispose()
  })

  it.each(['done', 'interrupted'])(
    'atomically resumes an archived %s routine instead of only reopening its transcript',
    async (status) => {
      const preset = { id: 'review', title: 'Review', kind: 'agent' }
      const archived = activity('routine:briefing:one', {
        kind: 'routine',
        title: 'Briefing',
        status,
        archivedAt: '2026-07-25T13:00:00Z',
        source: { routineId: 'briefing', presetId: 'review' },
        host: { type: 'pty', resumeStrategy: 'codex' },
        session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
      })
      const resumed = {
        ...archived,
        status: 'idle',
        archivedAt: null,
        session: { runId: 'run-2' },
      }
      const activityRuntime = {
        resumePreset: vi.fn(async () => resumed),
        setArchived: vi.fn(),
      }
      const diagnostic = ref('')
      const selectActivity = vi.fn()
      const controller = useActivityLifecycle({
        activities: { records: reactive([archived]), byId: () => archived },
        activityRuntime,
        launchers: { byId: id => (id === 'review' ? preset : null) },
        workbench: reactive({
          activeActivityId: '',
          paneLayout: { activity: { state: 'normal' } },
        }),
        workspacePath: ref('/fallback'),
        diagnostic,
        coreActivityIds: new Set(),
        getSidebarActivities: () => [],
        openCoreActivity: vi.fn(),
        selectActivity,
        openActivityRecord: vi.fn(),
      })

      await controller.restoreActivity(archived.id)

      expect(activityRuntime.resumePreset).toHaveBeenCalledWith(
        preset,
        expect.objectContaining({
          id: archived.id,
          workspacePath: '/w',
          archivedAt: expect.any(String),
        }),
      )
      expect(activityRuntime.setArchived).not.toHaveBeenCalled()
      expect(selectActivity).toHaveBeenCalledWith(archived.id)
      expect(diagnostic.value).toBe('')
      controller.dispose()
    },
  )

  it('restores only the transcript when an archived Activity has no exact session id', async () => {
    const archived = activity('agent:legacy', {
      kind: 'agent',
      status: 'done',
      archivedAt: '2026-07-25T13:00:00Z',
      source: { presetId: 'codex' },
      host: { type: 'pty', resumeStrategy: 'codex' },
    })
    const restored = { ...archived, archivedAt: null }
    const activityRuntime = {
      resumePreset: vi.fn(),
      setArchived: vi.fn(async () => restored),
    }
    const selectActivity = vi.fn()
    const controller = useActivityLifecycle({
      activities: { records: reactive([archived]), byId: () => archived },
      activityRuntime,
      launchers: { byId: () => ({ id: 'codex' }) },
      workbench: reactive({
        activeActivityId: '',
        paneLayout: { activity: { state: 'normal' } },
      }),
      workspacePath: ref('/w'),
      diagnostic: ref(''),
      coreActivityIds: new Set(),
      getSidebarActivities: () => [],
      openCoreActivity: vi.fn(),
      selectActivity,
      openActivityRecord: vi.fn(),
    })

    await controller.restoreActivity(archived.id)

    expect(activityRuntime.resumePreset).not.toHaveBeenCalled()
    expect(activityRuntime.setArchived).toHaveBeenCalledWith(archived.id, false)
    expect(selectActivity).toHaveBeenCalledWith(archived.id)
    controller.dispose()
  })

  it('leaves a resumable History entry archived when its respawn fails', async () => {
    const archived = activity('agent:closed', {
      kind: 'agent',
      title: 'Closed review',
      status: 'done',
      archivedAt: '2026-07-25T13:00:00Z',
      source: { presetId: 'review' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: { cliSessionId: '11111111-1111-4111-8111-111111111111' },
    })
    const activityRuntime = {
      resumePreset: vi.fn(async () => {
        throw new Error('launcher unavailable')
      }),
      setArchived: vi.fn(),
    }
    const diagnostic = ref('')
    const selectActivity = vi.fn()
    const controller = useActivityLifecycle({
      activities: { records: reactive([archived]), byId: () => archived },
      activityRuntime,
      launchers: { byId: () => ({ id: 'review' }) },
      workbench: reactive({
        activeActivityId: '',
        paneLayout: { activity: { state: 'normal' } },
      }),
      workspacePath: ref('/w'),
      diagnostic,
      coreActivityIds: new Set(),
      getSidebarActivities: () => [],
      openCoreActivity: vi.fn(),
      selectActivity,
      openActivityRecord: vi.fn(),
    })

    await controller.restoreActivity(archived.id)

    expect(activityRuntime.setArchived).not.toHaveBeenCalled()
    expect(selectActivity).not.toHaveBeenCalled()
    expect(archived.archivedAt).toBe('2026-07-25T13:00:00Z')
    expect(diagnostic.value).toContain('Closed review could not resume: launcher unavailable')
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

  it('routes native New through the focused CLI Activity and falls back to Editor New File', () => {
    const quickOpen = ref(false)
    const quickOpenInitialView = ref('root')
    const quickOpenPreferredTargetId = ref('')
    const activityNewTargetId = ref('preset:review')
    const newFile = vi.fn()
    const controller = useWorkbenchKeyboardRouting({
      quickOpen,
      quickOpenInitialView,
      quickOpenPreferredTargetId,
      activityNewTargetId,
      settings: { workbenchZoom: 1, set: vi.fn() },
      editorRef: ref({ mimirNewFile: newFile }),
      editorFiles: { openFiles: [] },
      workbench: { activeActivityId: 'run:a' },
      sidebarActivities: computed(() => [{ id: 'run:a' }]),
      toggleSidebar: vi.fn(),
      selectActivity: vi.fn(),
      closeActivity: vi.fn(),
      collapseEmptyEditor: vi.fn(),
    })
    const activityPane = document.createElement('section')
    activityPane.dataset.pane = 'activity'
    activityPane.tabIndex = 0
    document.body.appendChild(activityPane)

    activityPane.focus()
    controller.newNativeFocusedSurface()

    expect(quickOpen.value).toBe(true)
    expect(quickOpenInitialView.value).toBe('new-activity')
    expect(quickOpenPreferredTargetId.value).toBe('preset:review')
    expect(newFile).not.toHaveBeenCalled()

    quickOpen.value = false
    const editorPane = document.createElement('section')
    editorPane.dataset.pane = 'editor'
    editorPane.tabIndex = 0
    document.body.appendChild(editorPane)
    editorPane.focus()
    controller.newNativeFocusedSurface()

    expect(newFile).toHaveBeenCalledTimes(1)
    activityPane.remove()
    editorPane.remove()
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
