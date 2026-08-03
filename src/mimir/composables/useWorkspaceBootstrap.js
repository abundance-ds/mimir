import { ref, watch } from 'vue'
import { openBusinessGraph } from '../../services/businessGraph.js'
import { applyResponsiveZone, responsiveZoneFor } from '../responsiveLayout.js'

export function useWorkspaceBootstrap({
  settings,
  workbench,
  activities,
  activityRuntime,
  launchers,
  appsCatalog,
  workspaceFiles,
  editorFiles,
  toolRuntime,
  diagnostic,
  coreActivities,
  openCoreActivity,
  isActivityVisible = () => true,
  getFocusOwner,
}) {
  const initialized = ref(false)
  const responsiveZone = ref('wide')
  const viewportWidth = ref(window.innerWidth)
  let desktopLayout = null

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

    const [, runtimeResult, toolRuntimeResult, appsResult] = await Promise.allSettled([
      launchers.load(),
      activityRuntime.initialize(),
      toolRuntime.start(),
      appsCatalog.load(),
    ])
    if (runtimeResult.status === 'rejected') {
      diagnostic.value = activityRuntime.error || errorMessage(runtimeResult.reason)
    }
    if (toolRuntimeResult.status === 'rejected') {
      diagnostic.value = `MCP tools could not start: ${errorMessage(toolRuntimeResult.reason)}`
    }
    if (appsResult.status === 'rejected' && !diagnostic.value) {
      diagnostic.value = `Apps could not load: ${errorMessage(appsResult.reason)}`
    }

    const savedWorkspace = String(settings.mimirWorkspaceFolder || '').trim()
    if (savedWorkspace) {
      await openWorkspace(savedWorkspace, { persist: false, revealFiles: false })
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

  async function openWorkspace(path, { persist = true, revealFiles = true } = {}) {
    try {
      await workspaceFiles.openWorkspace(path)
      const graphWarning = await mountBusinessGraph(path)
      ensureCoreActivities(path)
      if (persist) settings.set('mimirWorkspaceFolder', path)
      rememberWorkspace(path)
      diagnostic.value = graphWarning
      workbench.resetActivityHistory('files')
      if (revealFiles) openCoreActivity('files')
      return true
    } catch (cause) {
      diagnostic.value = `Workspace index failed: ${errorMessage(cause)}`
      return false
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
      [normalized, ...previous.filter(candidate => candidate !== normalized)].slice(0, 8),
    )
  }

  function dispose() {
    stopGraphFolderWatch()
  }

  return {
    chooseWorkspace,
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure')
}
