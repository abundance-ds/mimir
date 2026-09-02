import { ref, watch } from 'vue'
import {
  createGraphNode,
  getGraphNode,
  openBusinessGraph,
  queryGraph,
} from '../../services/businessGraph.js'
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../../services/workspaceConfig.js'
import { workspacePathStatuses } from '../../services/workspaceAvailability.js'
import {
  managedProjectStatus,
  setManagedProjectEnabled,
  teamRepositoryStatus,
} from '../../services/managedRepositories.js'
import { activityWorkspacePath, normalizedWorkspacePath } from '../activityWorkspace.js'
import { applyResponsiveZone, responsiveZoneFor } from '../responsiveLayout.js'

const WORKSPACE_STATUS_TTL_MS = 30_000

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
  requestWorkspaceSetup = async () => null,
}) {
  const initialized = ref(false)
  const responsiveZone = ref('wide')
  const viewportWidth = ref(window.innerWidth)
  const unavailableWorkspacePaths = ref(new Set())
  const workspaceViewByPath = new Map()
  let desktopLayout = null
  let automaticResumeEnabled = false
  let automaticResumeLauncherFailure = ''
  let automaticResumeWorkers = 0
  let automaticResumeQueue = []
  let workspaceStatusPromise = null
  let workspaceStatusSignature = ''
  let workspaceStatusCheckedAt = 0
  const queuedAutomaticResumeIds = new Set()
  const attemptedAutomaticResumeIds = new Set()

  async function start() {
    ensureCoreActivities()
    if (!settings.settingsReady) await settings.load()
    registerRecentWorkspaceConfigs()
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
    void reconcileWorkspaces()

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
      automaticResumeEnabled = true
      automaticResumeLauncherFailure = launcherLoadFailure
      queueInterruptedAgentsForActiveProject()
    }
  }

  function queueInterruptedAgentsForActiveProject() {
    if (!automaticResumeEnabled) return
    const projectPath = normalizedWorkspacePath(workspaceFiles.workspacePath)
    if (!projectPath) return

    automaticResumeQueue = automaticResumeQueue.filter((item) => {
      if (item.projectPath === projectPath) return true
      queuedAutomaticResumeIds.delete(item.activity.id)
      return false
    })

    for (const activity of activities.visibleActivities) {
      if (!isCurrentProjectInterruptedAgent(activity, projectPath)) continue
      if (
        attemptedAutomaticResumeIds.has(activity.id)
        || queuedAutomaticResumeIds.has(activity.id)
      ) continue
      const presetId = activity.source?.presetId || activity.source?.launcherId
      const preset = !automaticResumeLauncherFailure && presetId
        ? launchers.byId(presetId)
        : null
      const unavailable = automaticResumeLauncherFailure
        || automaticResumeUnavailableReason(activity, preset)
      if (unavailable) {
        attemptedAutomaticResumeIds.add(activity.id)
        activityRuntime.markAutomaticResumeFailure(activity.id, unavailable)
        continue
      }
      queuedAutomaticResumeIds.add(activity.id)
      automaticResumeQueue.push({ activity, preset, projectPath })
    }
    drainAutomaticResumeQueue()
  }

  function drainAutomaticResumeQueue() {
    while (automaticResumeEnabled && automaticResumeWorkers < 2 && automaticResumeQueue.length) {
      const item = automaticResumeQueue.shift()
      queuedAutomaticResumeIds.delete(item.activity.id)
      if (normalizedWorkspacePath(workspaceFiles.workspacePath) !== item.projectPath) continue

      const current = activities.byId(item.activity.id)
      if (!current || !isCurrentProjectInterruptedAgent(current, item.projectPath)) continue
      if (attemptedAutomaticResumeIds.has(current.id)) continue
      attemptedAutomaticResumeIds.add(current.id)
      automaticResumeWorkers += 1
      Promise.resolve(activityRuntime.resumePreset(item.preset, current, {
        automatic: true,
        open: false,
      })).catch(() => {
        // The runtime keeps the interrupted row and records the exact cause.
      }).finally(() => {
        automaticResumeWorkers -= 1
        drainAutomaticResumeQueue()
      })
    }
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
      diagnostic.value = 'Workspace creation is available in the Mimir desktop app.'
      return false
    }
    try {
      const [{ invoke }, { save }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-dialog'),
      ])
      const selection = await save({
        title: 'Create workspace',
        defaultPath: newProjectDefaultPath(workspaceFiles.workspacePath),
      })
      const path = typeof selection === 'string' ? selection : selection?.path
      if (!path) return false
      if (await invoke('path_exists', { path })) {
        diagnostic.value = 'The workspace folder already exists. Use Open workspace instead.'
        return false
      }
      return openWorkspace(path, { create: true })
    } catch (cause) {
      diagnostic.value = `Workspace could not be created: ${errorMessage(cause)}`
      return false
    }
  }

  async function openWorkspace(path, { persist = true, activate = true, create = false } = {}) {
    try {
      const configuration = await ensureWorkspaceConfiguration(path, { create })
      if (configuration === false) return false
      if (create && configuration === null && window.__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('create_dir', { path })
        await setManagedProjectEnabled(path, true, { initialize: true })
        await setManagedProjectEnabled(path, false)
      }
      await prepareEditorWorkspaceSwitch()
      rememberActiveActivity(workspaceFiles.workspacePath)
      await workspaceFiles.openWorkspace(path)
      if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
        void Promise.resolve(managedProjectStatus(path)).catch(() => {})
      }
      const graphWarning = await mountBusinessGraph(path)
      ensureCoreActivities(path)
      if (persist) settings.set('mimirWorkspaceFolder', path)
      rememberWorkspace(path)
      markWorkspaceAvailable(path)
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
      queueInterruptedAgentsForActiveProject()
      return true
    } catch (cause) {
      const action = create ? 'be created' : 'open'
      diagnostic.value = `Workspace could not ${action}: ${errorMessage(cause)}`
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
      await openBusinessGraph(projectRoot)
      return ''
    } catch (cause) {
      const message = `Business graph could not open: ${errorMessage(cause)}`
      diagnostic.value = message
      return message
    }
  }

  async function ensureWorkspaceConfiguration(path, { create = false } = {}) {
    const workspace = String(path || '').trim()
    if (!workspace || !window.__TAURI_INTERNALS__) return null
    let teamRoot = ''
    try {
      const team = await teamRepositoryStatus()
      if (team?.managed) teamRoot = team.root
    } catch { /* Team setup is optional */ }
    if (!teamRoot) return null

    let existing = null
    if (!create) existing = await loadWorkspaceConfig(workspace)

    const graphRoot = create ? teamRoot : workspace
    await openBusinessGraph(graphRoot)

    if (existing?.project) {
      const linked = await getGraphNode(existing.project)
      if (linked?.kind === 'project') return existing
    } else if (existing) {
      return existing
    }

    const result = await queryGraph({
      scopeIds: ['team:main'],
      kinds: ['project'],
      limit: 500,
    })
    const projects = Array.isArray(result?.items) ? result.items : []
    const draft = await requestWorkspaceSetup({
      path: workspace,
      projects,
      initialConfig: existing,
      error: existing?.project
        ? 'The linked Project is unavailable. Select another Project or None.'
        : '',
    })
    if (!draft) {
      if (workspaceFiles.workspacePath) {
        await mountBusinessGraph(workspaceFiles.workspacePath)
      }
      return false
    }

    if (create) {
      await invoke('create_dir', { path: workspace })
      await setManagedProjectEnabled(workspace, true, { initialize: true })
      // Repository ownership and visibility stay on GitHub. Until the user
      // connects an existing remote in Settings, this local repository is manual.
      await setManagedProjectEnabled(workspace, false)
    }
    let project = String(draft.project || '').trim()
    const newProjectTitle = String(draft.newProjectTitle || '').trim()
    if (newProjectTitle) {
      const created = await createGraphNode({
        kind: 'project',
        title: newProjectTitle,
        scopeId: 'team:main',
        properties: { projectStatus: 'planned' },
      })
      project = created.id
    }
    return saveWorkspaceConfig(workspace, {
      id: existing?.id,
      project,
      graphScope: draft.graphScope,
    })
  }

  function registerRecentWorkspaceConfigs() {
    const paths = Array.isArray(settings.recentWorkspaceFolders)
      ? settings.recentWorkspaceFolders
      : []
    void Promise.allSettled(paths.map(path => loadWorkspaceConfig(path)))
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

  function workspaceStatusCandidates() {
    const paths = []
    const seen = new Set()
    const add = (path) => {
      const normalized = normalizedWorkspacePath(path)
      if (!normalized || seen.has(normalized)) return
      seen.add(normalized)
      paths.push(String(path).trim())
    }
    add(workspaceFiles.workspacePath)
    add(settings.mimirWorkspaceFolder)
    for (const path of Array.isArray(settings.recentWorkspaceFolders)
      ? settings.recentWorkspaceFolders
      : []) add(path)
    for (const activity of Array.isArray(activities.visibleActivities)
      ? activities.visibleActivities
      : []) {
      add(activityWorkspacePath(activity, id => launchers.byId?.(id)))
    }
    return paths
  }

  function reconcileWorkspaces({ force = false } = {}) {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
      return Promise.resolve(false)
    }
    const paths = workspaceStatusCandidates()
    const signature = paths.map(normalizedWorkspacePath).sort().join('\n')
    const fresh = signature === workspaceStatusSignature
      && Date.now() - workspaceStatusCheckedAt < WORKSPACE_STATUS_TTL_MS
    if (!force && fresh) return Promise.resolve(true)
    if (workspaceStatusPromise) return workspaceStatusPromise

    workspaceStatusPromise = workspacePathStatuses(paths)
      .then((statuses) => {
        const candidates = new Set(paths.map(normalizedWorkspacePath))
        const nextUnavailable = new Set(
          [...unavailableWorkspacePaths.value].filter(path => candidates.has(path)),
        )
        for (const status of Array.isArray(statuses) ? statuses : []) {
          const path = normalizedWorkspacePath(status?.path)
          if (!path) continue
          if (status.available === false) nextUnavailable.add(path)
          else if (status.available === true) nextUnavailable.delete(path)
        }
        unavailableWorkspacePaths.value = nextUnavailable
        workspaceStatusSignature = signature
        workspaceStatusCheckedAt = Date.now()
        return true
      })
      .catch(() => false)
      .finally(() => {
        workspaceStatusPromise = null
      })
    return workspaceStatusPromise
  }

  function markWorkspaceAvailable(path) {
    const normalized = normalizedWorkspacePath(path)
    if (!normalized || !unavailableWorkspacePaths.value.has(normalized)) return
    const next = new Set(unavailableWorkspacePaths.value)
    next.delete(normalized)
    unavailableWorkspacePaths.value = next
    workspaceStatusCheckedAt = 0
  }

  function dispose() {
    automaticResumeEnabled = false
    automaticResumeQueue = []
    queuedAutomaticResumeIds.clear()
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
    reconcileWorkspaces,
    responsiveZone,
    start,
    syncResponsiveLayout,
    unavailableWorkspacePaths,
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
