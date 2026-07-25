<template>
  <WorkbenchShell
    :dragging="resize.dragging.value"
    :activity-title="activeActivity?.title || 'Activity'"
    :activity-meta="activityMeta"
    :editor-title="editorTitle"
    :editor-meta="editorMeta"
    @resize-start="resize.start"
  >
    <template #sidebar="{ collapsed }">
      <WorkbenchSidebar
        :collapsed="collapsed"
        :workspace-name="workspaceName"
        :workspace-path="workspaceFiles.workspacePath"
        :launchers="launcherRows"
        :activities="sidebarActivities"
        :archived-activities="archivedSidebarActivities"
        :active-activity-id="workbench.activeActivityId || ''"
        @launch="onLaunch"
        @select-activity="selectActivity"
        @choose-workspace="chooseWorkspace"
        @toggle-collapse="toggleSidebar"
        @rename-activity="renameActivity"
        @stop-activity="stopActivity"
        @archive-activity="archiveActivity"
        @restore-activity="restoreActivity"
        @clear-activity="clearActivity"
      />
    </template>

    <template #activity>
      <PaneFrame
        pane="activity"
        :title="activeActivity?.title || 'Activity'"
        :meta="activityMeta"
      >
        <div class="relative h-full min-h-0">
          <ActivityHost
            :activities="hostActivities"
            :active-id="workbench.activeActivityId || ''"
            @recover="openCoreActivity('files')"
          >
            <template
              v-for="activity in hostActivities"
              :key="activity.id"
              #[`activity-${activity.id}`]="{ activity: hostedActivity }"
            >
              <component
                :ref="(surface) => setActivitySurface(hostedActivity.id, surface)"
                :is="surfaceFor(hostedActivity)"
                :activity="hostedActivity"
                :active="hostedActivity.id === workbench.activeActivityId"
                :font-size="settings.mimTerminalFontSize"
                :diagnostic="surfaceDiagnostic(hostedActivity)"
                @open-file="openFileInEditor"
                @choose-workspace="chooseWorkspace"
                @request-stop="stopActivity"
                @restart="restartActivity"
                @launch-app="launchApp"
                @launch-plan="launchAppPlan"
                @diagnostic="showDiagnostic"
              />
            </template>
          </ActivityHost>

          <div
            v-if="diagnostic"
            data-workbench-diagnostic
            class="absolute inset-x-2 top-2 z-40 flex items-start gap-2 border border-rem/30 bg-surface px-3 py-2 text-[10px] leading-relaxed text-rem"
            role="status"
          >
            <IconAlertTriangle :size="14" :stroke-width="1.7" class="mt-px shrink-0" />
            <span class="min-w-0 flex-1">{{ diagnostic }}</span>
            <button
              type="button"
              title="Dismiss diagnostic"
              class="grid size-6 shrink-0 place-items-center hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="diagnostic = ''"
            >
              <IconX :size="13" :stroke-width="1.8" />
            </button>
          </div>
        </div>
      </PaneFrame>
    </template>

    <template #editor>
      <EditorApp ref="editorRef" hide-sidebar embedded />
    </template>
  </WorkbenchShell>

  <QuickOpen
    :open="quickOpen"
    @close="quickOpen = false"
    @open-file="openFileInEditor"
  />
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconAlertTriangle, IconX } from '@tabler/icons-vue'
import EditorApp from '../editor/App.vue'
import { useActivitiesStore } from '../stores/activities.js'
import { useActivityRuntimeStore } from '../stores/activityRuntime.js'
import { useAppsCatalogStore } from '../stores/appsCatalog.js'
import { useFileStore } from '../stores/files.js'
import { useLaunchersStore } from '../stores/launchers.js'
import { useSettingsStore } from '../stores/settings.js'
import { useWorkbenchStore } from '../stores/workbench.js'
import { useWorkspaceFilesStore } from '../stores/workspaceFiles.js'
import { createToolRuntime } from '../services/toolRuntime.js'
import { callAppAction, openAppWindow } from '../services/appsCatalog.js'
import FilesActivity from './activities/FilesActivity.vue'
import UnavailableActivity from './activities/UnavailableActivity.vue'
import ActivityHost from './components/ActivityHost.vue'
import PaneFrame from './components/PaneFrame.vue'
import QuickOpen from './components/QuickOpen.vue'
import WorkbenchShell from './components/WorkbenchShell.vue'
import WorkbenchSidebar from './components/WorkbenchSidebar.vue'
import { useWorkbenchResize } from './composables/useWorkbenchResize.js'

const activityModules = import.meta.glob('./activities/*Activity.vue', { eager: true })
const optionalSurfaces = {
  terminal: activityModules['./activities/TerminalActivity.vue']?.default || null,
  agent: activityModules['./activities/TerminalActivity.vue']?.default || null,
  routine: activityModules['./activities/RoutinesActivity.vue']?.default || null,
}
const AppsActivity = activityModules['./activities/AppsActivity.vue']?.default || null
const AppActivity = activityModules['./activities/AppActivity.vue']?.default || null

const CORE_ACTIVITIES = Object.freeze([
  { id: 'files', kind: 'files', title: 'Files' },
  { id: 'apps', kind: 'app', title: 'Apps' },
  { id: 'routines', kind: 'routine', title: 'Routines' },
])
const CORE_ACTIVITY_IDS = new Set(CORE_ACTIVITIES.map((activity) => activity.id))

const workbench = useWorkbenchStore()
const activities = useActivitiesStore()
const activityRuntime = useActivityRuntimeStore()
const appsCatalog = useAppsCatalogStore()
const launchers = useLaunchersStore()
const workspaceFiles = useWorkspaceFilesStore()
const settings = useSettingsStore()
const editorFiles = useFileStore()
const editorRef = ref(null)
const quickOpen = ref(false)
const diagnostic = ref('')
const initialized = ref(false)
const activitySurfaces = new Map()

const toolRuntime = createToolRuntime({
  getEditor: () => editorRef.value,
  getWorkspacePath: () => workspaceFiles.workspacePath || null,
  settings,
  listActivities: () => activities.activities,
  listApps: listAppsForTool,
  launchApp: launchAppFromTool,
})

const resize = useWorkbenchResize(workbench, {
  persist: (layout) => persistWorkbench(layout),
})

const hostActivities = computed(() => activities.visibleActivities)
const sidebarActivities = computed(() => (
  activities.visibleActivities.filter((activity) => !CORE_ACTIVITY_IDS.has(activity.id))
))
const archivedSidebarActivities = computed(() => activities.archivedActivities)
const activeActivity = computed(() => (
  activities.byId(workbench.activeActivityId) || null
))
const activityMeta = computed(() => {
  const activity = activeActivity.value
  if (!activity) return 'Unavailable'
  return humanStatus(activity.status)
})
const workspaceName = computed(() => basename(workspaceFiles.workspacePath))
const editorTitle = computed(() => {
  const path = editorFiles.currentFile?.path
  return path ? basename(path) : 'Editor'
})
const editorMeta = computed(() => {
  const file = editorFiles.currentFile
  if (!file) return 'No document'
  return file.dirty ? 'Unsaved' : `${editorFiles.openFiles.length} tab${editorFiles.openFiles.length === 1 ? '' : 's'}`
})

const launcherRows = computed(() => [
  {
    id: 'core:files',
    title: 'Files',
    icon: 'files',
    shortcut: shortcut('P'),
    available: true,
  },
  ...launchers.decoratedPresets.map((preset) => ({
    id: `preset:${preset.id}`,
    title: preset.title,
    icon: preset.kind === 'terminal' ? 'terminal' : 'agent',
    shortcut: '',
    available: preset.available,
    unavailableReason: preset.unavailableReason,
  })),
  {
    id: 'core:apps',
    title: 'Apps',
    icon: 'apps',
    shortcut: '',
    available: true,
  },
  {
    id: 'core:routines',
    title: 'Routines',
    icon: 'routines',
    shortcut: '',
    available: true,
  },
])

watch(
  () => [
    workbench.paneLayout.sidebar.state,
    workbench.paneLayout.activity.state,
    workbench.paneLayout.editor.state,
    workbench.activeActivityId,
  ],
  () => persistWorkbench(),
)

onMounted(async () => {
  ensureCoreActivities()
  document.addEventListener('keydown', onKeydown, true)
  window.__mim_terminalPaste = pasteToActiveTerminal

  await settings.load()
  restoreWorkbench()

  const [, runtimeResult, toolRuntimeResult] = await Promise.allSettled([
    launchers.load(),
    activityRuntime.initialize(),
    toolRuntime.start(),
  ])
  if (runtimeResult.status === 'rejected') {
    diagnostic.value = activityRuntime.error || errorMessage(runtimeResult.reason)
  }
  if (toolRuntimeResult.status === 'rejected') {
    diagnostic.value = `MCP tools could not start: ${errorMessage(toolRuntimeResult.reason)}`
  }

  const savedWorkspace = String(settings.mimWorkspaceFolder || '').trim()
  if (savedWorkspace) await openWorkspace(savedWorkspace, { persist: false, revealFiles: false })

  const savedActivity = settings.workbenchLayout?.activeActivityId
  if (savedActivity && activities.byId(savedActivity)) workbench.openActivity(savedActivity)
  else if (!activities.byId(workbench.activeActivityId)) workbench.openActivity('files')
  initialized.value = true
  persistWorkbench()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true)
  resize.dispose()
  workspaceFiles.dispose()
  activityRuntime.dispose()
  toolRuntime.stop()
  if (window.__mim_terminalPaste === pasteToActiveTerminal) {
    delete window.__mim_terminalPaste
  }
  activitySurfaces.clear()
})

function ensureCoreActivities(workspacePath = workspaceFiles.workspacePath) {
  const timestamp = new Date(0).toISOString()
  for (const core of CORE_ACTIVITIES) {
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
  if (!saved || typeof saved !== 'object') return
  workbench.restoreLayout(saved)
}

function persistWorkbench(layout = workbench.layoutSnapshot()) {
  if (!initialized.value) return
  settings.set('workbenchLayout', {
    ...layout,
    activeActivityId: workbench.activeActivityId || 'files',
  })
}

async function chooseWorkspace() {
  if (!window.__TAURI_INTERNALS__) {
    diagnostic.value = 'Folder selection is available in the Mim desktop app.'
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
    workspaceFiles.startAutoRefresh()
    ensureCoreActivities(path)
    if (persist) settings.set('mimWorkspaceFolder', path)
    diagnostic.value = ''
    if (revealFiles) openCoreActivity('files')
    return true
  } catch (cause) {
    diagnostic.value = `Workspace index failed: ${errorMessage(cause)}`
    return false
  }
}

async function onLaunch(id) {
  if (id === 'core:files') return openCoreActivity('files')
  if (id === 'core:apps') return openCoreActivity('apps')
  if (id === 'core:routines') return openCoreActivity('routines')
  if (!id.startsWith('preset:')) return

  const preset = launchers.byId(id.slice('preset:'.length))
  if (!preset) {
    diagnostic.value = `Launcher '${id.slice('preset:'.length)}' is missing from ${launchers.configPath || 'the launcher configuration'}.`
    return
  }
  if (!preset.available) {
    diagnostic.value = `${preset.title} is unavailable: ${preset.unavailableReason || 'binary not found'}.`
    return
  }
  if (!workspaceFiles.workspacePath && preset.cwd?.mode === 'workspace') {
    diagnostic.value = `Open a workspace before launching ${preset.title}.`
    return
  }

  try {
    diagnostic.value = ''
    await activityRuntime.launchPreset(preset, workspaceFiles.workspacePath)
    workbench.setPaneState('activity', 'expanded')
  } catch (cause) {
    diagnostic.value = `${preset.title} did not launch: ${errorMessage(cause)}`
  }
}

function openCoreActivity(id) {
  ensureCoreActivities()
  selectActivity(id)
}

function selectActivity(id) {
  const activity = activities.byId(id)
  if (!activity) {
    diagnostic.value = `Activity '${id}' is no longer available.`
    return
  }
  if (activity.unread || !activity.lastViewedAt) {
    activities.upsert({
      ...activity,
      lastViewedAt: new Date().toISOString(),
      unread: false,
    })
  }
  workbench.openActivity(id)
  workbench.setPaneState('activity', 'expanded')
}

function toggleSidebar() {
  workbench.togglePane('sidebar')
  persistWorkbench()
}

async function openFileInEditor(path) {
  if (!path) return
  try {
    await editorRef.value?.mimOpen(path)
    workbench.setPaneState('editor', 'expanded')
    diagnostic.value = ''
  } catch (cause) {
    diagnostic.value = `${basename(path)} could not be opened: ${errorMessage(cause)}`
  }
}

async function stopActivity(id) {
  try {
    await activityRuntime.stop(id)
  } catch (cause) {
    diagnostic.value = `Activity could not be stopped: ${errorMessage(cause)}`
  }
}

async function renameActivity({ id, title }) {
  try {
    await activityRuntime.rename(id, title)
  } catch (cause) {
    diagnostic.value = `Activity could not be renamed: ${errorMessage(cause)}`
  }
}

async function archiveActivity(id) {
  try {
    await activityRuntime.setArchived(id, true)
    if (workbench.activeActivityId === id) openCoreActivity('files')
  } catch (cause) {
    diagnostic.value = `Activity could not be archived: ${errorMessage(cause)}`
  }
}

async function restoreActivity(id) {
  try {
    await activityRuntime.setArchived(id, false)
    selectActivity(id)
  } catch (cause) {
    diagnostic.value = `Activity could not be restored: ${errorMessage(cause)}`
  }
}

async function clearActivity(id) {
  try {
    const wasActive = workbench.activeActivityId === id
    await activityRuntime.clear(id)
    if (wasActive) openCoreActivity('files')
  } catch (cause) {
    diagnostic.value = `Activity could not be cleared: ${errorMessage(cause)}`
  }
}

async function restartActivity(payload) {
  const activity = payload?.activity
  const presetId = activity?.source?.presetId || activity?.source?.launcherId
  const preset = presetId ? launchers.byId(presetId) : null
  if (!preset) {
    diagnostic.value = `${activity?.title || 'Activity'} cannot restart because its launcher preset is missing.`
    return
  }
  await onLaunch(`preset:${preset.id}`)
}

function surfaceFor(activity) {
  if (activity.kind === 'files') return FilesActivity
  if (activity.kind === 'app') return activity.id === 'apps'
    ? (AppsActivity || UnavailableActivity)
    : (AppActivity || UnavailableActivity)
  return optionalSurfaces[activity.kind] || UnavailableActivity
}

function surfaceDiagnostic(activity) {
  if (activity.kind === 'app' && activity.id === 'apps' && !AppsActivity) {
    return 'The Apps surface is not installed. Check local app definitions and restart Mim.'
  }
  if (activity.kind === 'routine' && activity.id === 'routines' && !optionalSurfaces.routine) {
    return 'The Routines surface is not installed. Check local routine definitions and restart Mim.'
  }
  return ''
}

function launchApp(payload) {
  if (!payload?.activity?.id) {
    diagnostic.value = 'The app did not provide a valid Activity.'
    return
  }
  activities.upsert(payload.activity)
  selectActivity(payload.activity.id)
}

async function listAppsForTool() {
  await appsCatalog.load()
  return {
    directory: appsCatalog.directory,
    apps: appsCatalog.apps,
    diagnostics: appsCatalog.diagnostics,
  }
}

async function launchAppFromTool(appId, requestedMode) {
  await appsCatalog.load()
  const app = appsCatalog.apps.find(candidate => candidate.id === appId)
  if (!app) throw new Error(`App '${appId}' is not installed.`)
  const payload = await appsCatalog.prepareActivity(app, workspaceFiles.workspacePath || '')
  if (requestedMode && payload.launch.mode !== requestedMode) {
    throw new Error(
      `App '${appId}' uses '${payload.launch.mode}', not requested mode '${requestedMode}'.`,
    )
  }
  launchApp(payload)
  return {
    activityId: payload.activity.id,
    appId,
    mode: payload.launch.mode,
  }
}

async function launchAppPlan(payload) {
  const { app, plan, activity, onStarted, onComplete, onError } = payload || {}
  try {
    if (!app?.id || !plan?.mode) throw new Error('The app launch plan is incomplete.')

    if (plan.mode === 'terminal') {
      const preset = launchers.byId(plan.preset)
      if (!preset) throw new Error(`Launcher preset '${plan.preset}' is not configured.`)
      const record = await activityRuntime.launchPreset(
        preset,
        activity?.workspacePath || workspaceFiles.workspacePath,
        {
          title: app.title,
          args: plan.args || [],
          source: { type: 'app', appId: app.id },
          retention: 'durable',
        },
      )
      onStarted?.({ activityId: record.id, label: record.title })
      onComplete?.({ activityId: record.id, label: 'Activity opened' })
      return
    }

    if (plan.mode === 'process') {
      const record = await activityRuntime.launchCommand({
        title: app.title,
        command: plan.command,
        args: plan.args || [],
        cwd: plan.cwd || activity?.workspacePath || workspaceFiles.workspacePath,
        env: plan.env || {},
        source: { type: 'app', appId: app.id },
        retention: plan.launchOnly ? 'ephemeral' : 'durable',
      })
      onStarted?.({ activityId: record.id, label: record.title })
      onComplete?.({ activityId: record.id, label: 'Process started' })
      return
    }

    if (plan.mode === 'window') {
      onStarted?.({ label: 'Opening window' })
      await openAppWindow(app.id, activity?.workspacePath || workspaceFiles.workspacePath)
      onComplete?.({ label: 'Window opened' })
      return
    }

    if (plan.mode === 'action') {
      onStarted?.({ label: 'Calling tool' })
      const response = await callAppAction(
        app.id,
        plan.tool,
        {},
        activity?.workspacePath || workspaceFiles.workspacePath,
      )
      if (response?.error) throw new Error(response.error.message || 'App action failed.')
      onComplete?.({ label: response?.result?.displayText || 'Action complete' })
      return
    }

    if (plan.mode === 'rust-helper') {
      throw new Error(
        `Native helper '${plan.helper}' is not registered in this build. ` +
        'Add its Rust implementation to the host helper registry.',
      )
    }

    throw new Error(`Unsupported app launch mode '${plan.mode}'.`)
  } catch (cause) {
    onError?.(cause)
    showDiagnostic(`${app?.title || 'App'} failed: ${errorMessage(cause)}`)
  }
}

function showDiagnostic(message) {
  diagnostic.value = String(message || '')
}

function setActivitySurface(id, surface) {
  if (surface) activitySurfaces.set(id, surface)
  else activitySurfaces.delete(id)
}

async function pasteToActiveTerminal(text) {
  const activity = activities.byId(workbench.activeActivityId)
  if (!activity || !['terminal', 'agent'].includes(activity.kind)) return false
  return Boolean(await activitySurfaces.get(activity.id)?.pasteText?.(text))
}

function onKeydown(event) {
  const primary = event.metaKey || event.ctrlKey
  if (!primary || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'p' && !event.shiftKey) {
    event.preventDefault()
    event.stopImmediatePropagation()
    quickOpen.value = true
    return
  }
  if (key === 'b' && !event.shiftKey) {
    event.preventDefault()
    event.stopImmediatePropagation()
    toggleSidebar()
  }
}

function shortcut(key) {
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  return /mac/i.test(platform) ? `⌘${key}` : `Ctrl+${key}`
}

function basename(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || ''
}

function humanStatus(status) {
  return String(status || 'ready')
    .replace(/-/g, ' ')
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure')
}
</script>
