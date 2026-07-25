<template>
  <WorkbenchShell
    :dragging="resize.dragging.value"
    :activity-title="activeActivity?.title || 'Activity'"
    :activity-meta="activityMeta"
    :editor-title="editorTitle"
    :editor-meta="editorMeta"
    :viewport-width="viewportWidth"
    @resize-start="resize.start"
  >
    <template #sidebar="{ collapsed }">
      <WorkbenchSidebar
        :collapsed="collapsed"
        :workspace-name="workspaceName"
        :workspace-path="workspaceFiles.workspacePath"
        :launchers="surfaceLauncherRows"
        :apps="appLauncherRows"
        :activities="sidebarActivities"
        :archived-activities="archivedSidebarActivities"
        :active-activity-id="workbench.activeActivityId || ''"
        :activity-sort="activityNavigator.mode"
        @launch="onLaunch"
        @select-activity="selectActivity"
        @choose-workspace="chooseWorkspace"
        @toggle-collapse="toggleSidebar"
        @rename-activity="renameActivity"
        @stop-activity="stopActivity"
        @archive-activity="archiveActivity"
        @restore-activity="restoreActivity"
        @clear-activity="clearActivity"
        @reorder-activities="reorderActivities"
        @sort-activities="sortActivities"
        @manage-apps="openAppsSettings"
        @settings="openSettings"
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
                @open-activity="openActivityRecord"
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
      <EditorApp
        ref="editorRef"
        hide-sidebar
        embedded
        @close-request="closeNativeFocusedSurface"
        @empty="collapseEmptyEditor"
        @navigate-editor="onEditorNavigate"
        @launch-app="dispatchAppPayload"
      />
    </template>
  </WorkbenchShell>

  <QuickOpen
    :open="quickOpen"
    @close="quickOpen = false"
    @open-file="openFileInEditor"
  />
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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
import { runRoutineNow } from '../services/routines.js'
import FilesActivity from './activities/FilesActivity.vue'
import UnavailableActivity from './activities/UnavailableActivity.vue'
import ActivityHost from './components/ActivityHost.vue'
import PaneFrame from './components/PaneFrame.vue'
import QuickOpen from './components/QuickOpen.vue'
import WorkbenchShell from './components/WorkbenchShell.vue'
import WorkbenchSidebar from './components/WorkbenchSidebar.vue'
import { useWorkbenchResize } from './composables/useWorkbenchResize.js'
import { applyResponsiveZone, responsiveZoneFor } from './responsiveLayout.js'
import { ACTIVITY_SORT_MODES, orderActivities } from './activityOrdering.js'
import { routeWorkbenchKey } from './workbenchKeyboard.js'

const activityModules = import.meta.glob('./activities/*Activity.vue', { eager: true })
const optionalSurfaces = {
  terminal: activityModules['./activities/TerminalActivity.vue']?.default || null,
  agent: activityModules['./activities/TerminalActivity.vue']?.default || null,
  routine: activityModules['./activities/RoutinesActivity.vue']?.default || null,
}
const AppActivity = activityModules['./activities/AppActivity.vue']?.default || null

const CORE_ACTIVITIES = Object.freeze([
  { id: 'files', kind: 'files', title: 'Files' },
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
const releaseSettingsSync = settings.startSync()
const editorFiles = useFileStore()
const editorRef = ref(null)
const quickOpen = ref(false)
const diagnostic = ref('')
const initialized = ref(false)
const responsiveZone = ref('wide')
const viewportWidth = ref(window.innerWidth)
const activitySurfaces = new Map()
const closingActivityIds = ref(new Set())
const finalizingClosures = new Set()
let desktopLayout = null
let lastWorkbenchFocus = { owner: 'none', activityId: '' }

const toolRuntime = createToolRuntime({
  getEditor: () => editorRef.value,
  getWorkspacePath: () => workspaceFiles.workspacePath || null,
  settings,
  listActivities: () => activities.activities,
  stopActivity: async (id) => {
    await activityRuntime.stop(id)
    return { activity_id: id, status: 'stopping' }
  },
  renameActivity: async (id, title) => {
    await activityRuntime.rename(id, title)
    return activities.byId(id)
  },
  archiveActivity: async (id, archived) => {
    await activityRuntime.setArchived(id, archived)
    return activities.byId(id)
  },
  clearActivity: async (id) => {
    await activityRuntime.clear(id)
    return { activity_id: id, status: 'cleared' }
  },
  listApps: listAppsForTool,
  launchApp: launchAppFromTool,
  reloadApps: () => appsCatalog.reload(),
  createApp: input => appsCatalog.create(input),
  duplicateApp: (appId, input) => appsCatalog.duplicate(appId, input),
  updateApp: (appId, title) => appsCatalog.updateTitle(appId, title),
  trashApp: appId => appsCatalog.trash(appId),
})

const resize = useWorkbenchResize(workbench, {
  persist: (layout) => persistWorkbench(layout),
})

const hostActivities = computed(() => activities.visibleActivities)
const activityNavigator = computed(() => {
  const saved = settings.activityNavigator
  return {
    mode: ACTIVITY_SORT_MODES.includes(saved?.mode) ? saved.mode : 'manual',
    order: Array.isArray(saved?.order) ? saved.order.map(String) : [],
  }
})
const sidebarActivities = computed(() => (
  orderActivities(
    activities.visibleActivities.filter((activity) => (
      !CORE_ACTIVITY_IDS.has(activity.id)
      && !closingActivityIds.value.has(activity.id)
    )),
    {
      mode: activityNavigator.value.mode,
      manualOrder: activityNavigator.value.order,
    },
  )
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

const surfaceLauncherRows = computed(() => [
  {
    id: 'core:files',
    title: 'Files',
    icon: 'files',
    shortcut: shortcut('P'),
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

const appLauncherRows = computed(() => [
  ...launchers.decoratedPresets.map((preset) => ({
    id: `preset:${preset.id}`,
    title: preset.title,
    icon: launcherIcon(preset),
    shortcut: '',
    available: preset.available,
    unavailableReason: preset.unavailableReason,
  })),
  ...appsCatalog.apps.map((app) => ({
    id: `app:${app.id}`,
    title: app.title,
    icon: app.id === 'changes'
      ? 'changes'
      : (app.id === 'scratch' ? 'scratch' : (app.mode === 'terminal' ? 'terminal' : 'apps')),
    shortcut: '',
    available: true,
  })),
])

function launcherIcon(preset) {
  if (preset.kind === 'terminal') return 'terminal'
  const source = String(preset.agentId || preset.id || '').toLowerCase()
  if (source.includes('codex')) return 'codex'
  if (source.includes('claude')) return 'claude'
  if (source === 'pi' || source.includes('pi-')) return 'pi'
  return 'agent'
}

watch(
  () => [
    workbench.paneLayout.sidebar.state,
    workbench.paneLayout.activity.state,
    workbench.paneLayout.editor.state,
    workbench.activeActivityId,
  ],
  () => persistWorkbench(),
)

watch(
  () => activities.records.map((activity) => `${activity.id}:${activity.status}`).join('|'),
  () => {
    for (const id of closingActivityIds.value) {
      const activity = activities.byId(id)
      if (activity && !isLiveActivity(activity)) void finalizeClosedActivity(activity)
    }
  },
)

onMounted(async () => {
  ensureCoreActivities()
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', rememberWorkbenchFocus, true)
  window.addEventListener('resize', syncResponsiveLayout)
  window.__mim_activityPaste = pasteToActiveTerminal

  if (!settings.settingsReady) await settings.load()
  restoreWorkbench()
  // Editor is a first-class startup surface. A stale saved rail must never
  // boot into a shell that appears to have no right pane.
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

  const savedWorkspace = String(settings.mimWorkspaceFolder || '').trim()
  if (savedWorkspace) await openWorkspace(savedWorkspace, { persist: false, revealFiles: false })

  const savedActivity = settings.workbenchLayout?.activeActivityId
  if (savedActivity && activities.byId(savedActivity)) workbench.openActivity(savedActivity)
  else if (!activities.byId(workbench.activeActivityId)) workbench.openActivity('files')
  initialized.value = true
  persistWorkbench()
})

onUnmounted(() => {
  persistWorkbench()
  void settings.flush()
  releaseSettingsSync()
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('focusin', rememberWorkbenchFocus, true)
  window.removeEventListener('resize', syncResponsiveLayout)
  resize.dispose()
  workspaceFiles.dispose()
  activityRuntime.dispose()
  toolRuntime.stop()
  if (window.__mim_activityPaste === pasteToActiveTerminal) {
    delete window.__mim_activityPaste
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
  if (lastWorkbenchFocus.owner === 'editor') return true
  if (lastWorkbenchFocus.owner === 'activity' || lastWorkbenchFocus.owner === 'sidebar') {
    return false
  }
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
  if (id === 'core:routines') return openCoreActivity('routines')
  if (id.startsWith('app:')) {
    const appId = id.slice('app:'.length)
    const app = appsCatalog.apps.find((candidate) => candidate.id === appId)
    if (!app) {
      diagnostic.value = `App '${appId}' is no longer installed. Reload Apps in Settings.`
      return
    }
    try {
      const payload = await appsCatalog.prepareActivity(app, workspaceFiles.workspacePath || '')
      await dispatchAppPayload(payload)
    } catch (cause) {
      diagnostic.value = `${app.title} did not open: ${errorMessage(cause)}`
    }
    return
  }
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
  focusNarrowPane('activity')
  workbench.setPaneState('activity', 'expanded')
}

async function toggleSidebar() {
  workbench.togglePane('sidebar')
  persistWorkbench()
  await nextTick()
  const target = workbench.paneLayout.sidebar.state === 'rail'
    ? (
        document.querySelector('[data-pane-action="restore-sidebar"]')
        || document.querySelector('[data-editor-action="restore-sidebar"]')
        || document.querySelector('[data-sidebar-workspace]')
      )
    : (
        document.querySelector('[data-sidebar-collapse]')
        || document.querySelector('[data-sidebar-workspace]')
      )
  target?.focus()
}

function reorderActivities(ids) {
  const visible = new Set(sidebarActivities.value.map((activity) => activity.id))
  const retained = activityNavigator.value.order.filter((id) => !visible.has(id))
  settings.set('activityNavigator', {
    mode: 'manual',
    order: [...ids, ...retained],
  })
}

function sortActivities(mode) {
  settings.set('activityNavigator', {
    mode: ACTIVITY_SORT_MODES.includes(mode) ? mode : 'manual',
    order: activityNavigator.value.order,
  })
}

function openAppsSettings() {
  editorRef.value?.mimOpenSettings?.('apps')
}

function openSettings() {
  editorRef.value?.mimOpenSettings?.('appearance')
}

async function openFileInEditor(path) {
  if (!path) return
  try {
    await editorRef.value?.mimOpen(path)
    focusNarrowPane('editor')
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

async function closeActivity(id = workbench.activeActivityId) {
  const activity = activities.byId(id)
  if (!activity || CORE_ACTIVITY_IDS.has(activity.id)) {
    if (workbench.paneLayout.activity.state === 'expanded') {
      workbench.setPaneState('activity', 'rail')
    }
    return false
  }
  if (closingActivityIds.value.has(activity.id)) return true

  const currentOrder = sidebarActivities.value.map((item) => item.id)
  closingActivityIds.value = new Set([...closingActivityIds.value, activity.id])
  moveAfterClosing(activity.id, currentOrder)

  if (!isLiveActivity(activity)) {
    await finalizeClosedActivity(activity)
    return true
  }

  try {
    await activityRuntime.stop(activity.id)
    return true
  } catch (cause) {
    unmarkClosing(activity.id)
    diagnostic.value = `Activity could not be closed: ${errorMessage(cause)}`
    return false
  }
}

function moveAfterClosing(id, currentOrder) {
  if (workbench.activeActivityId !== id) return
  const index = currentOrder.indexOf(id)
  const remaining = currentOrder.filter((activityId) => activityId !== id)
  const nextId = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
  if (nextId) {
    selectActivity(nextId)
    return
  }
  workbench.openActivity('files')
  workbench.setPaneState('activity', 'rail')
}

async function finalizeClosedActivity(activity) {
  if (finalizingClosures.has(activity.id)) return
  finalizingClosures.add(activity.id)
  try {
    if (activity.retention === 'durable') {
      await activityRuntime.setArchived(activity.id, true)
    } else {
      await activityRuntime.clear(activity.id)
    }
    unmarkClosing(activity.id)
  } catch (cause) {
    unmarkClosing(activity.id)
    diagnostic.value = `Activity could not be closed: ${errorMessage(cause)}`
  } finally {
    finalizingClosures.delete(activity.id)
  }
}

function unmarkClosing(id) {
  const next = new Set(closingActivityIds.value)
  next.delete(id)
  closingActivityIds.value = next
}

function collapseEmptyEditor() {
  workbench.setPaneState('editor', 'rail')
}

function onEditorNavigate() {
  focusNarrowPane('editor')
  workbench.setPaneState('editor', 'expanded')
}

async function restartActivity(payload) {
  const activity = payload?.activity
  if (activity?.kind === 'routine' && activity.source?.routineId) {
    try {
      const result = await runRoutineNow(activity.source.routineId)
      openActivityRecord(result.activity)
    } catch (cause) {
      diagnostic.value = `${activity.title || 'Routine'} could not restart: ${errorMessage(cause)}`
    }
    return
  }

  const presetId = activity?.source?.presetId || activity?.source?.launcherId
  const preset = presetId ? launchers.byId(presetId) : null
  try {
    if (activity?.kind === 'agent' && !activity.source?.appId) {
      if (!preset) {
        throw new Error('its launcher preset is missing')
      }
      await activityRuntime.launchPreset(
        preset,
        activity.workspacePath || workspaceFiles.workspacePath,
        {
          kind: activity.kind,
          resume: Boolean(activity.host?.resumeStrategy),
          resumeStrategy: activity.host?.resumeStrategy,
          title: activity.title,
        },
      )
      return
    }
    if (activity?.host?.type !== 'pty' || !activity.launch?.command) {
      throw new Error('its original command is unavailable')
    }
    await activityRuntime.launchCommand({
      title: activity.title,
      command: activity.launch.command,
      args: activity.launch.args || [],
      cwd: activity.launch.cwd || activity.workspacePath || workspaceFiles.workspacePath,
      env: activity.launch.env || {},
      kind: activity.kind || 'terminal',
      retention: activity.retention || 'durable',
      source: activity.source || {},
    })
  } catch (cause) {
    diagnostic.value = `${activity?.title || 'Activity'} could not restart: ${errorMessage(cause)}`
  }
}

function surfaceFor(activity) {
  if (activity.kind === 'files') return FilesActivity
  if (activity.kind === 'app') return AppActivity || UnavailableActivity
  if (activity.kind === 'routine' && activity.id !== 'routines' && activity.host?.type === 'pty') {
    return optionalSurfaces.terminal || UnavailableActivity
  }
  return optionalSurfaces[activity.kind] || UnavailableActivity
}

function surfaceDiagnostic(activity) {
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
  const existing = activities.byId(payload.activity.id)
  activities.upsert({
    ...payload.activity,
    createdAt: existing?.createdAt || payload.activity.createdAt,
    archivedAt: null,
  })
  selectActivity(payload.activity.id)
}

async function dispatchAppPayload(payload, { throwOnError = false } = {}) {
  if (['terminal', 'process'].includes(payload?.launch?.mode)) {
    return launchAppPlan(payload, { throwOnError })
  }
  launchApp(payload)
  return payload?.activity || null
}

function openActivityRecord(activity) {
  if (!activity?.id) {
    diagnostic.value = 'The runtime did not return a valid Activity.'
    return
  }
  activities.upsert(activity)
  selectActivity(activity.id)
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
  const record = await dispatchAppPayload(payload, { throwOnError: true })
  return {
    activityId: record?.id || payload.activity.id,
    appId,
    mode: payload.launch.mode,
  }
}

async function launchAppPlan(payload, { throwOnError = false } = {}) {
  const {
    app,
    activity,
    onStarted,
    onComplete,
    onError,
  } = payload || {}
  const plan = payload?.plan || payload?.launch
  try {
    if (!app?.id || !plan?.mode) throw new Error('The app launch plan is incomplete.')

    if (plan.mode === 'terminal') {
      const record = await launchExternalAppActivity(app, plan, activity)
      onStarted?.({ activityId: record.id, label: record.title })
      onComplete?.({ activityId: record.id, label: 'Activity opened' })
      return record
    }

    if (plan.mode === 'process') {
      const record = await launchExternalAppActivity(app, plan, activity)
      onStarted?.({ activityId: record.id, label: record.title })
      onComplete?.({ activityId: record.id, label: 'Process started' })
      return record
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
    if (throwOnError) throw cause
    return null
  }
}

async function launchExternalAppActivity(app, plan, activity) {
  let record
  if (plan.mode === 'terminal') {
    const preset = launchers.byId(plan.preset)
    if (!preset) throw new Error(`Launcher preset '${plan.preset}' is not configured.`)
    record = await activityRuntime.launchPreset(
      preset,
      activity?.workspacePath || workspaceFiles.workspacePath,
      {
        title: app.title,
        args: plan.args || [],
        env: plan.env || {},
        source: { type: 'app', appId: app.id },
        retention: 'durable',
      },
    )
  } else if (plan.mode === 'process') {
    record = await activityRuntime.launchCommand({
      title: app.title,
      command: plan.command,
      args: plan.args || [],
      cwd: plan.cwd || activity?.workspacePath || workspaceFiles.workspacePath,
      env: plan.env || {},
      source: { type: 'app', appId: app.id },
      retention: plan.launchOnly ? 'ephemeral' : 'durable',
    })
  } else {
    throw new Error(`Launch mode '${plan.mode}' does not create a terminal Activity.`)
  }
  selectActivity(record.id)
  return record
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
  if (!activity || activity.host?.type !== 'pty') return false
  return Boolean(await activitySurfaces.get(activity.id)?.pasteText?.(text))
}

function onKeydown(event) {
  if (
    quickOpen.value
    && (
      event.key === 'Escape'
      || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w')
    )
  ) {
    event.preventDefault()
    event.stopImmediatePropagation()
    quickOpen.value = false
    return
  }
  if (quickOpen.value) return
  if (document.querySelector('[aria-modal="true"]')) return
  const focus = keyboardFocus(event.target)
  const result = routeWorkbenchKey({
    key: event.key,
    primary: event.metaKey || event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    focusOwner: focus.owner,
    sidebarActivityId: focus.activityId,
  })
  if (!result) return

  event.preventDefault()
  event.stopImmediatePropagation()
  if (result.action === 'quick-open') {
    quickOpen.value = true
    return
  }
  if (result.action === 'toggle-sidebar') {
    toggleSidebar()
    return
  }
  if (result.action === 'cycle-editor') {
    editorRef.value?.mimCycleTab?.(result.direction)
    return
  }
  if (result.action === 'cycle-activity') {
    cycleActivity(result.direction, {
      focusSidebar: focus.owner === 'sidebar',
      fromId: focus.activityId,
    })
    return
  }
  if (result.action === 'close-editor') {
    closeForFocus({ owner: 'editor', activityId: '' })
    return
  }
  if (result.action === 'close-activity') {
    closeForFocus({
      owner: result.activityId ? 'sidebar' : 'activity',
      activityId: result.activityId,
    })
  }
}

function keyboardFocus(target) {
  const element = typeof target?.closest === 'function' ? target : document.activeElement
  if (!element) return { owner: 'none', activityId: '' }
  if (element.closest('[data-pane="editor"]')) {
    return { owner: 'editor', activityId: '' }
  }
  if (element.closest('[data-pane="activity"]')) {
    return { owner: 'activity', activityId: '' }
  }
  if (element.closest('[data-pane="sidebar"]')) {
    const row = element.closest('[data-sidebar-row^="activity:"]')
    const value = row?.getAttribute('data-sidebar-row') || ''
    return {
      owner: 'sidebar',
      activityId: value.startsWith('activity:') ? value.slice('activity:'.length) : '',
    }
  }
  return { owner: 'none', activityId: '' }
}

function rememberWorkbenchFocus(event) {
  const focus = keyboardFocus(event.target)
  if (focus.owner !== 'none') lastWorkbenchFocus = focus
}

function closeNativeFocusedSurface() {
  if (quickOpen.value) {
    quickOpen.value = false
    return
  }
  const current = keyboardFocus(document.activeElement)
  closeForFocus(current.owner === 'none' ? lastWorkbenchFocus : current)
}

function closeForFocus(focus) {
  if (focus.owner === 'editor') {
    if (!editorFiles.openFiles.length) collapseEmptyEditor()
    else void editorRef.value?.mimCloseActiveTab?.()
    return
  }
  if (focus.owner === 'activity') {
    void closeActivity(workbench.activeActivityId)
    return
  }
  if (focus.owner === 'sidebar' && focus.activityId) {
    void closeActivity(focus.activityId)
  }
}

function cycleActivity(direction, { focusSidebar = false, fromId = '' } = {}) {
  const rows = sidebarActivities.value
  if (!rows.length) return
  const index = rows.findIndex((activity) => (
    activity.id === (fromId || workbench.activeActivityId)
  ))
  const start = index < 0 ? (direction > 0 ? -1 : 0) : index
  const next = (start + direction + rows.length) % rows.length
  const nextId = rows[next].id
  selectActivity(nextId)
  if (focusSidebar) {
    void nextTick(() => {
      const row = [...document.querySelectorAll('[data-sidebar-row]')]
        .find((element) => element.getAttribute('data-sidebar-row') === `activity:${nextId}`)
      row?.querySelector('button')?.focus()
    })
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

function isLiveActivity(activity) {
  return activity?.host?.type === 'pty'
    && ['ready', 'starting', 'working', 'needs-input', 'idle'].includes(activity?.status)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown failure')
}
</script>
