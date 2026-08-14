import { ref, watch } from 'vue'
import { openBusinessGraph } from '../../services/businessGraph.js'
import { activityWorkspacePath, normalizedWorkspacePath } from '../activityWorkspace.js'
import { applyResponsiveZone, responsiveZoneFor } from '../responsiveLayout.js'

export function useWorkspaceBootstrap({
  settings,
  workbench,
  activities,
  activityRuntime,
  launchers,
  appsCatalog,
  chat = null,
  workspaceFiles,
  editorFiles,
  toolRuntime,
  diagnostic,
  coreActivities,
  openCoreActivity,
  isActivityVisible = () => true,
  getFocusOwner,
  prepareEditorWorkspaceSwitch = () => {},
}) {
  const initialized = ref(false)
  const responsiveZone = ref('wide')
  const viewportWidth = ref(window.innerWidth)
  const workspaceViewByPath = new Map()
  let desktopLayout = null
  let automaticResumeGeneration = 0

  const stopGraphFolderWatch = watch(
    () => settings.mimirTeamGraphFolder,
    () => {
      if (initialized.value && workspaceFiles.workspacePath) {
        void mountBusinessGraph()
      }
    },
  )

  async function start() {
    ensureCoreActivities()
    if (!settings.settingsReady) await settings.load()
    restoreWorkbench()

    // The editor is a first-class startup surface, even when an old layout
    // snapshot predates the right-hand pane.
    workbench.setPaneState('editor', 'expanded')
    syncResponsiveLayout({ force: true, preferEditor: true })

    const [launchersResult, runtimeResult, toolRuntimeResult, appsResult] = await Promise.allSettled([
      launchers.load(),
      activityRuntime.initialize(),
      toolRuntime.start(),
      appsCatalog.load(),
    ])
    if (runtimeResult.status === 'rejected') {
      diagnostic.value = activityRuntime.error || errorMessage(runtimeResult.reason)
    }
    const launcherLoadFailure = launchersResult.status === 'rejected'
      ? `Launcher catalog could not load: ${errorMessage(launchersResult.reason)}`
      : ''
    if (toolRuntimeResult.status === 'rejected') {
      diagnostic.value = `MCP tools could not start: ${errorMessage(toolRuntimeResult.reason)}`
    }
    if (appsResult.status === 'rejected' && !diagnostic.value) {
      diagnostic.value = `Apps could not load: ${errorMessage(appsResult.reason)}`
    }

    const savedWorkspace = String(settings.mimirWorkspaceFolder || '').trim()
    if (savedWorkspace) {
      await openWorkspace(savedWorkspace, { persist: false, activate: false })
    }

    const savedActivity = settings.workbenchLayout?.activeActivityId
    const savedRecord = savedActivity ? activities.byId(savedActivity) : null
    if (savedRecord && isActivityVisible(savedRecord)) {
      workbench.openActivity(savedActivity)
    } else if (!activities.byId(workbench.activeActivityId)) {
      workbench.openActivity('files')
    }
    initialized.value = true
    persistWorkbench()
    if (runtimeResult.status === 'fulfilled') {
      void resumeInterruptedAgentsAtStartup({ launcherLoadFailure })
    }
  }

  async function resumeInterruptedAgentsAtStartup({ launcherLoadFailure = '' } = {}) {
    const projectPath = normalizedWorkspacePath(workspaceFiles.workspacePath)
    if (!projectPath) return
    const generation = ++automaticResumeGeneration
    const queue = []

    for (const activity of activities.visibleActivities) {
      if (!isCurrentProjectInterruptedAgent(activity, projectPath)) continue
      const presetId = activity.source?.presetId || activity.source?.launcherId
      const preset = !launcherLoadFailure && presetId ? launchers.byId(presetId) : null
      const unavailable = launcherLoadFailure
        || automaticResumeUnavailableReason(activity, preset)
      if (unavailable) {
        activityRuntime.markAutomaticResumeFailure(activity.id, unavailable)
        continue
      }
      queue.push({ activity, preset })
    }

    let nextIndex = 0
    async function worker() {
      while (generation === automaticResumeGeneration && nextIndex < queue.length) {
        const item = queue[nextIndex]
        nextIndex += 1
        try {
          await activityRuntime.resumePreset(item.preset, item.activity, {
            automatic: true,
            open: false,
          })
        } catch {
          // The runtime keeps the interrupted row and records the exact cause.
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(2, queue.length) },
      () => worker(),
    ))
  }

  function isCurrentProjectInterruptedAgent(activity, projectPath) {
    if (
      activity.kind !== 'agent'
      || activity.status !== 'interrupted'
      || activity.source?.appId
      || activity.host?.type !== 'pty'
    ) return false
    return activityWorkspacePath(activity, id => launchers.byId(id)) === projectPath
  }

  function ensureCoreActivities(workspacePath = workspaceFiles.workspacePath) {
    const timestamp = new Date(0).toISOString()
    for (const core of coreActivities) {
      const existing = activities.byId(core.id)
      activities.upsert({
        id: core.id,
        kind: core.kind,
        title: core.title,
        workspacePath: workspacePath || '',
        status: 'ready',
        createdAt: existing?.createdAt || timestamp,
        updatedAt: existing?.updatedAt || timestamp,
        retention: 'durable',
        source: { type: 'core' },
        host: { type: 'renderer' },
        launch: {},
      })
    }
  }

  function restoreWorkbench() {
    const saved = settings.workbenchLayout
    if (saved && typeof saved === 'object') workbench.restoreLayout(saved)
  }

  function persistWorkbench(layout = workbench.layoutSnapshot()) {
    if (!initialized.value) return
    const persistedLayout = responsiveZone.value === 'wide'
      ? layout
      : (desktopLayout || layout)
    settings.set('workbenchLayout', {
      ...persistedLayout,
      activeActivityId: workbench.activeActivityId || 'files',
    })
  }

  function syncResponsiveLayout({ force = false, preferEditor = null } = {}) {
    viewportWidth.value = window.innerWidth
    const nextZone = responsiveZoneFor(window.innerWidth)
    if (!force && nextZone === responsiveZone.value) return
    if (responsiveZone.value === 'wide' && nextZone !== 'wide') {
      desktopLayout = workbench.layoutSnapshot()
    }
    workbench.setSinglePaneMode(nextZone === 'focus')
    applyResponsiveZone(workbench, nextZone, {
      preferEditor: preferEditor ?? responsiveEditorPreference(),
      desktopLayout,
    })
    responsiveZone.value = nextZone
    if (nextZone === 'wide') desktopLayout = null
  }

  function responsiveEditorPreference() {
    const owner = getFocusOwner?.() || 'none'
    if (owner === 'editor') return true
    if (owner === 'activity' || owner === 'sidebar') return false
    return Boolean(editorFiles.currentFile)
  }

  function focusNarrowPane(pane) {
    if (responsiveZone.value !== 'focus') return
    applyResponsiveZone(workbench, 'focus', {
      preferEditor: pane === 'editor',
      desktopLayout,
    })
  }

  async function chooseWorkspace() {
    if (!window.__TAURI_INTERNALS__) {
      diagnostic.value = 'Folder selection is available in the Mimir desktop app.'
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selection = await open({
        directory: true,
        multiple: false,
        title: 'Open workspace',
      })
      const path = Array.isArray(selection) ? selection[0] : selection
      if (path) await openWorkspace(typeof path === 'string' ? path : path.path)
    } catch (cause) {
      diagnostic.value = `Workspace could not be opened: ${errorMessage(cause)}`
    }
  }

  async function createWorkspace() {
    if (!window.__TAURI_INTERNALS__) {
      diagnostic.value = 'Project creation is available in the Mimir desktop app.'
      return false
    }
    try {
      const [{ invoke }, { save }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-dialog'),
      ])
      const selection = await save({
        title: 'Create project',
        defaultPath: newProjectDefaultPath(workspaceFiles.workspacePath),
      })
      const path = typeof selection === 'string' ? selection : selection?.path
      if (!path) return false
      if (await invoke('path_exists', { path })) {
        diagnostic.value = 'The project folder already exists. Use Open project instead.'
        return false
      }
      await invoke('create_dir', { path })
      return openWorkspace(path)
    } catch (cause) {
      diagnostic.value = `Project could not be created: ${errorMessage(cause)}`
      return false
    }
  }

  async function openWorkspace(path, { persist = true, activate = true } = {}) {
    await prepareEditorWorkspaceSwitch()
    rememberActiveActivity(workspaceFiles.workspacePath)
    try {
      await workspaceFiles.openWorkspace(path)
      const graphWarning = await mountBusinessGraph(path)
      ensureCoreActivities(path)
      if (persist) settings.set('mimirWorkspaceFolder', path)
      rememberWorkspace(path)
      editorFiles.setWorkspaceScope?.(path, settings.recentWorkspaceFolders)
      diagnostic.value = graphWarning
      const workspaceView = rememberedWorkspaceView(path)
      const activityId = restorableActivityId(workspaceView)
      workbench.resetActivityHistory(activityId)
      restoreWorkspaceDetails(workspaceView, activityId)
      if (activate) {
        if (activityId === 'files') openCoreActivity('files')
        else {
          focusNarrowPane('activity')
          workbench.setPaneState('activity', 'expanded')
        }
      }
      return true
    } catch (cause) {
      diagnostic.value = `Workspace index failed: ${errorMessage(cause)}`
      return false
    }
  }

  function rememberActiveActivity(path) {
    const workspace = normalizedWorkspacePath(path)
    const activityId = String(workbench.activeActivityId || '').trim()
    if (!workspace || !activityId) return
    const file = editorFiles.currentFile
    workspaceViewByPath.set(workspace, {
      activityId,
      chatTarget: activityId === 'chats' ? String(chat?.activeTarget || '').trim() : '',
      editorEntry: file?.path
        ? { path: file.path }
        : file?.draftId
          ? { draftId: file.draftId }
          : null,
    })
  }

  function rememberedWorkspaceView(path) {
    return workspaceViewByPath.get(normalizedWorkspacePath(path)) || null
  }

  function restorableActivityId(workspaceView) {
    const activityId = workspaceView?.activityId
    if (!activityId) return 'files'
    try {
      const activity = activities.byId(activityId)
      if (
        activity
        && !activity.archivedAt
        && !activity.closeRequestedAt
        && isActivityVisible(activity)
      ) {
        return activityId
      }
    } catch {
      // Session memory is optional. A bad candidate must not block a workspace switch.
    }
    return 'files'
  }

  function restoreWorkspaceDetails(workspaceView, activityId) {
    try {
      if (workspaceView?.editorEntry) {
        editorFiles.activateSessionEntry?.(workspaceView.editorEntry)
      }
    } catch {
      // A closed or malformed editor tab does not affect workspace navigation.
    }
    if (
      activityId !== 'chats'
      || !workspaceView?.chatTarget
      || !chat?.config?.enabled
      || !chat.targets?.some(target => target.id === workspaceView.chatTarget)
    ) {
      return
    }
    try {
      void Promise.resolve(chat.selectTarget(workspaceView.chatTarget)).catch(() => {})
    } catch {
      // Chat restore is best-effort and must never block the Activity surface.
    }
  }

  async function mountBusinessGraph(projectRoot = workspaceFiles.workspacePath) {
    if (!projectRoot) return ''
    try {
      await openBusinessGraph(projectRoot, settings.mimirTeamGraphFolder)
      return ''
    } catch (cause) {
      const message = `Business graph could not open: ${errorMessage(cause)}`
      diagnostic.value = message
      return message
    }
  }

  function rememberWorkspace(path) {
    const normalized = String(path || '').trim()
    if (!normalized) return
    const previous = Array.isArray(settings.recentWorkspaceFolders)
      ? settings.recentWorkspaceFolders
      : []
    settings.set(
      'recentWorkspaceFolders',
      [normalized, ...previous.filter(candidate => candidate !== normalized)],
    )
  }

  function dispose() {
    automaticResumeGeneration += 1
    stopGraphFolderWatch()
  }

  return {
    chooseWorkspace,
    createWorkspace,
    dispose,
    ensureCoreActivities,
    focusNarrowPane,
    initialized,
    mountBusinessGraph,
    openWorkspace,
    persistWorkbench,
    responsiveZone,
    start,
    syncResponsiveLayout,
    viewportWidth,
  }
}

function automaticResumeUnavailableReason(activity, preset) {
  if (!preset) return 'The launcher preset is unavailable.'
  if (!activity.host?.resumeStrategy || activity.host.resumeStrategy === 'none') {
    return 'The launcher does not support exact session resume.'
  }
  if (!String(activity.session?.cliSessionId || '').trim()) {
    return 'The exact provider session id is unavailable.'
  }
  return ''
}

function newProjectDefaultPath(currentPath) {
  const value = String(currentPath || '').replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (separatorIndex < 0) return 'Untitled project'
  return `${value.slice(0, separatorIndex + 1)}Untitled project`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure')
}
