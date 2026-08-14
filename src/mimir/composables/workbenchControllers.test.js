import { computed, nextTick, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({
  openBusinessGraph: vi.fn(async () => {}),
}))

vi.mock('../../services/businessGraph.js', () => graph)

import { useActivitiesStore } from '../../stores/activities.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { normalizedWorkspacePath } from '../activityWorkspace.js'
import { useActivityLifecycle } from './useActivityLifecycle.js'
import { useWorkbenchKeyboardRouting } from './useWorkbenchKeyboardRouting.js'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap.js'

describe('Workbench controllers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.innerWidth = 1280
  })

  it('archives durable and terminal closes and owns core-pane collapse semantics', async () => {
    const records = reactive([
      activity('run:a', { retention: 'durable', status: 'idle' }),
      activity('run:b', {
        retention: 'ephemeral',
        status: 'done',
        host: { type: 'pty' },
      }),
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

    expect(await controller.closeActivity('run:b')).toBe(true)
    expect(activityRuntime.setArchived).toHaveBeenCalledWith('run:b', true)
    expect(activityRuntime.clear).not.toHaveBeenCalled()

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

  it('closes the Sidebar multi-selection with Cmd+W and native Close instead of one row', () => {
    const quickOpen = ref(false)
    const closeActivity = vi.fn()
    const closeActivities = vi.fn()
    const sidebarSelection = ref(['run:a', 'run:b'])
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
      sidebarActivities: computed(() => [{ id: 'run:a' }, { id: 'run:b' }]),
      sidebarSelection,
      toggleSidebar: vi.fn(),
      selectActivity: vi.fn(),
      closeActivity,
      closeActivities,
      collapseEmptyEditor: vi.fn(),
    })
    controller.rememberWorkbenchFocus({ target: button })

    controller.onKeydown({
      key: 'w',
      metaKey: true,
      target: document.body,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    })
    expect(closeActivities).toHaveBeenCalledWith(['run:a', 'run:b'])
    expect(closeActivity).not.toHaveBeenCalled()

    controller.closeNativeFocusedSurface()
    expect(closeActivities).toHaveBeenCalledTimes(2)

    sidebarSelection.value = []
    controller.onKeydown({
      key: 'w',
      metaKey: true,
      target: document.body,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    })
    expect(closeActivity).toHaveBeenCalledWith('run:a')
    sidebar.remove()
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

  it('consumes a keystroke that targets content behind a modal', () => {
    const controller = useWorkbenchKeyboardRouting({
      quickOpen: ref(false),
      settings: { workbenchZoom: 1, set: vi.fn() },
      editorRef: ref(null),
      editorFiles: { openFiles: [] },
      workbench: { activeActivityId: 'files' },
      sidebarActivities: computed(() => []),
      toggleSidebar: vi.fn(),
      selectActivity: vi.fn(),
      closeActivity: vi.fn(),
      collapseEmptyEditor: vi.fn(),
    })
    const background = document.createElement('div')
    const modal = document.createElement('section')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(background, modal)
    const event = {
      key: 'Enter',
      target: background,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }

    controller.onKeydown(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()
    background.remove()
    modal.remove()
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

  it('resumes only current-project sidebar agents in the background, two at a time', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    settings.settingsReady = true
    settings.mimirWorkspaceFolder = '/w'
    const preset = { id: 'codex', cwd: { mode: 'workspace' } }

    for (let index = 0; index < 10; index += 1) {
      activities.upsert(activity(`agent:${index}`, {
        kind: 'agent',
        status: 'interrupted',
        workspacePath: '/w',
        source: { presetId: 'codex', workspaceScope: 'workspace' },
        host: { type: 'pty', resumeStrategy: 'codex' },
        session: { cliSessionId: `session-${index}` },
      }))
    }
    activities.upsert(activity('agent:archived', {
      kind: 'agent',
      status: 'interrupted',
      workspacePath: '/w',
      archivedAt: '2026-08-14T10:00:00Z',
      source: { presetId: 'codex', workspaceScope: 'workspace' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: { cliSessionId: 'archived-session' },
    }))
    activities.upsert(activity('agent:global', {
      kind: 'agent',
      status: 'interrupted',
      workspacePath: '',
      source: { presetId: 'codex', workspaceScope: 'global' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: { cliSessionId: 'global-session' },
    }))
    activities.upsert(activity('agent:other', {
      kind: 'agent',
      status: 'interrupted',
      workspacePath: '/other',
      source: { presetId: 'codex', workspaceScope: 'workspace' },
      host: { type: 'pty', resumeStrategy: 'codex' },
      session: { cliSessionId: 'other-session' },
    }))
    activities.upsert(activity('agent:missing-session', {
      kind: 'agent',
      status: 'interrupted',
      workspacePath: '/w',
      source: { presetId: 'codex', workspaceScope: 'workspace' },
      host: { type: 'pty', resumeStrategy: 'codex' },
    }))

    let activeResumes = 0
    let maxActiveResumes = 0
    const releases = []
    const resumePreset = vi.fn((_, candidate) => new Promise((resolve) => {
      activeResumes += 1
      maxActiveResumes = Math.max(maxActiveResumes, activeResumes)
      releases.push(() => {
        activeResumes -= 1
        resolve({ ...candidate, status: 'idle' })
      })
    }))
    const markAutomaticResumeFailure = vi.fn()
    const workspaceFiles = {
      workspacePath: '',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: {
        initialize: vi.fn(async () => {}),
        resumePreset,
        markAutomaticResumeFailure,
        error: '',
      },
      launchers: {
        load: vi.fn(async () => {}),
        byId: id => (id === 'codex' ? preset : null),
      },
      appsCatalog: { load: vi.fn(async () => {}) },
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime: { start: vi.fn(async () => {}) },
      diagnostic: ref(''),
      coreActivities: [{ id: 'files', kind: 'files', title: 'Files' }],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: candidate => !candidate.workspacePath || candidate.workspacePath === '/w',
      getFocusOwner: () => 'none',
    })

    await controller.start()

    expect(resumePreset).toHaveBeenCalledTimes(2)
    expect(maxActiveResumes).toBe(2)
    expect(markAutomaticResumeFailure).toHaveBeenCalledWith(
      'agent:missing-session',
      'The exact provider session id is unavailable.',
    )

    for (let completed = 0; completed < 10; completed += 1) {
      while (!releases.length) await Promise.resolve()
      releases.shift()()
      await Promise.resolve()
      await nextTick()
    }

    expect(resumePreset).toHaveBeenCalledTimes(10)
    expect(maxActiveResumes).toBe(2)
    expect(resumePreset.mock.calls.every(([, , options]) => (
      options.automatic === true && options.open === false
    ))).toBe(true)
    expect(resumePreset.mock.calls.map(([, candidate]) => candidate.id)).not.toContain('agent:archived')
    expect(resumePreset.mock.calls.map(([, candidate]) => candidate.id)).not.toContain('agent:global')
    expect(resumePreset.mock.calls.map(([, candidate]) => candidate.id)).not.toContain('agent:other')
    controller.dispose()
  })

  it('returns to each workspace Activity for the current app session', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    const workspaceFiles = {
      workspacePath: '/alpha',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    const editorFiles = {
      currentFile: { path: '/alpha/notes.md' },
      activateSessionEntry: vi.fn((entry) => {
        editorFiles.currentFile = { ...entry }
        return true
      }),
    }
    const prepareEditorWorkspaceSwitch = vi.fn()
    activities.upsert(activity('files', { kind: 'files', workspacePath: '' }))
    activities.upsert(activity('agent:alpha', { workspacePath: '/alpha' }))
    activities.upsert(activity('agent:beta', { workspacePath: '/beta' }))
    workbench.openActivity('agent:alpha')

    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: { initialize: vi.fn(), error: '' },
      launchers: { load: vi.fn() },
      appsCatalog: { load: vi.fn() },
      workspaceFiles,
      editorFiles,
      toolRuntime: { start: vi.fn() },
      diagnostic: ref(''),
      coreActivities: [{ id: 'files', kind: 'files', title: 'Files' }],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: candidate => (
        !candidate.workspacePath
        || normalizedWorkspacePath(candidate.workspacePath)
          === normalizedWorkspacePath(workspaceFiles.workspacePath)
      ),
      getFocusOwner: () => 'none',
      prepareEditorWorkspaceSwitch,
    })

    await controller.openWorkspace('/beta')
    expect(prepareEditorWorkspaceSwitch).toHaveBeenCalledTimes(1)
    expect(prepareEditorWorkspaceSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceFiles.openWorkspace.mock.invocationCallOrder[0],
    )
    expect(workbench.activeActivityId).toBe('files')
    expect(workbench.canGoPreviousActivity).toBe(false)

    workbench.openActivity('agent:beta')
    editorFiles.currentFile = { path: '/beta/plan.md' }
    await controller.openWorkspace('/alpha/')
    expect(workbench.activeActivityId).toBe('agent:alpha')
    expect(workbench.canGoPreviousActivity).toBe(false)
    expect(editorFiles.currentFile.path).toBe('/alpha/notes.md')

    await controller.openWorkspace('/beta')
    expect(workbench.activeActivityId).toBe('agent:beta')
    expect(workbench.canGoPreviousActivity).toBe(false)
    expect(editorFiles.currentFile.path).toBe('/beta/plan.md')
    controller.dispose()
  })

  it('creates an empty project folder and retains the complete project history', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    const workspaceFiles = {
      workspacePath: '/work/current',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    activities.upsert(activity('files', { kind: 'files', workspacePath: '' }))
    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: { initialize: vi.fn(), error: '' },
      launchers: { load: vi.fn() },
      appsCatalog: { load: vi.fn() },
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime: { start: vi.fn() },
      diagnostic: ref(''),
      coreActivities: [{ id: 'files', kind: 'files', title: 'Files' }],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: () => true,
      getFocusOwner: () => 'none',
    })

    window.__TAURI_INTERNALS__ = {}
    vi.mocked(save).mockResolvedValueOnce('/work/new-project')
    vi.mocked(invoke)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
    try {
      await expect(controller.createWorkspace()).resolves.toBe(true)
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Create project',
        defaultPath: '/work/Untitled project',
      }))
      expect(invoke).toHaveBeenNthCalledWith(1, 'path_exists', { path: '/work/new-project' })
      expect(invoke).toHaveBeenNthCalledWith(2, 'create_dir', { path: '/work/new-project' })
      expect(workspaceFiles.openWorkspace).toHaveBeenCalledWith('/work/new-project')

      for (let index = 0; index < 10; index++) {
        await controller.openWorkspace(`/work/project-${index}`)
      }
      expect(settings.recentWorkspaceFolders).toHaveLength(11)
      expect(settings.recentWorkspaceFolders[0]).toBe('/work/project-9')
      expect(settings.recentWorkspaceFolders).toContain('/work/new-project')
    } finally {
      delete window.__TAURI_INTERNALS__
      controller.dispose()
    }
  })

  it('keeps Create project cancellation and failures recoverable', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    const diagnostic = ref('')
    const workspaceFiles = {
      workspacePath: '/work/current',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    activities.upsert(activity('files', { kind: 'files', workspacePath: '' }))
    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: { initialize: vi.fn(), error: '' },
      launchers: { load: vi.fn() },
      appsCatalog: { load: vi.fn() },
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime: { start: vi.fn() },
      diagnostic,
      coreActivities: [{ id: 'files', kind: 'files', title: 'Files' }],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: () => true,
      getFocusOwner: () => 'none',
    })

    window.__TAURI_INTERNALS__ = {}
    try {
      vi.mocked(save).mockResolvedValueOnce(null)
      await expect(controller.createWorkspace()).resolves.toBe(false)
      expect(invoke).not.toHaveBeenCalled()
      expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
      expect(diagnostic.value).toBe('')

      vi.mocked(save).mockResolvedValueOnce('/work/existing')
      vi.mocked(invoke).mockResolvedValueOnce(true)
      await expect(controller.createWorkspace()).resolves.toBe(false)
      expect(invoke).toHaveBeenLastCalledWith('path_exists', { path: '/work/existing' })
      expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
      expect(diagnostic.value).toBe(
        'The project folder already exists. Use Open project instead.',
      )

      diagnostic.value = ''
      vi.mocked(save).mockResolvedValueOnce('/work/broken')
      vi.mocked(invoke)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('Disk is full'))
      await expect(controller.createWorkspace()).resolves.toBe(false)
      expect(invoke).toHaveBeenLastCalledWith('create_dir', { path: '/work/broken' })
      expect(workspaceFiles.openWorkspace).not.toHaveBeenCalled()
      expect(diagnostic.value).toBe('Project could not be created: Disk is full')
    } finally {
      delete window.__TAURI_INTERNALS__
      controller.dispose()
    }
  })

  it('returns to the selected chat for each workspace without blocking the switch', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    const workspaceFiles = {
      workspacePath: '/alpha',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    const chat = {
      activeTarget: '#alpha',
      config: { enabled: true },
      targets: [{ id: '#alpha' }, { id: '#beta' }],
      selectTarget: vi.fn(async (target) => {
        chat.activeTarget = target
      }),
    }
    activities.upsert(activity('files', { kind: 'files', workspacePath: '' }))
    activities.upsert(activity('chats', { kind: 'chat', workspacePath: '' }))
    workbench.openActivity('chats')

    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: { initialize: vi.fn(), error: '' },
      launchers: { load: vi.fn() },
      appsCatalog: { load: vi.fn() },
      chat,
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime: { start: vi.fn() },
      diagnostic: ref(''),
      coreActivities: [
        { id: 'files', kind: 'files', title: 'Files' },
        { id: 'chats', kind: 'chat', title: 'Chats' },
      ],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: () => true,
      getFocusOwner: () => 'none',
    })

    await controller.openWorkspace('/beta')
    workbench.openActivity('chats')
    chat.activeTarget = '#beta'

    await controller.openWorkspace('/alpha')
    expect(workbench.activeActivityId).toBe('chats')
    expect(chat.activeTarget).toBe('#alpha')

    await controller.openWorkspace('/beta')
    expect(workbench.activeActivityId).toBe('chats')
    expect(chat.activeTarget).toBe('#beta')
    expect(chat.selectTarget).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('uses Files when a remembered workspace Activity is no longer available', async () => {
    const settings = useSettingsStore()
    const workbench = useWorkbenchStore()
    const activities = useActivitiesStore()
    const workspaceFiles = {
      workspacePath: '/alpha',
      openWorkspace: vi.fn(async (path) => {
        workspaceFiles.workspacePath = path
      }),
    }
    activities.upsert(activity('files', { kind: 'files', workspacePath: '' }))
    activities.upsert(activity('agent:alpha', { workspacePath: '/alpha' }))
    workbench.openActivity('agent:alpha')

    const controller = useWorkspaceBootstrap({
      settings,
      workbench,
      activities,
      activityRuntime: { initialize: vi.fn(), error: '' },
      launchers: { load: vi.fn() },
      appsCatalog: { load: vi.fn() },
      workspaceFiles,
      editorFiles: { currentFile: null },
      toolRuntime: { start: vi.fn() },
      diagnostic: ref(''),
      coreActivities: [{ id: 'files', kind: 'files', title: 'Files' }],
      openCoreActivity: id => workbench.openActivity(id),
      isActivityVisible: candidate => (
        !candidate.workspacePath || candidate.workspacePath === workspaceFiles.workspacePath
      ),
      getFocusOwner: () => 'none',
    })

    await controller.openWorkspace('/beta')
    activities.upsert({
      ...activities.byId('agent:alpha'),
      status: 'done',
      archivedAt: '2026-08-11T09:00:00Z',
    })
    await controller.openWorkspace('/alpha')

    expect(workbench.activeActivityId).toBe('files')
    expect(workbench.canGoPreviousActivity).toBe(false)
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
