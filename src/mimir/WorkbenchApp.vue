<template>
  <WorkbenchShell
    :dragging="resize.dragging.value"
    :activity-title="activityTitle"
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
        :recent-workspaces="recentWorkspaces"
        :tools="toolRows"
        :new-activity="newActivityRows"
        :activities="sidebarActivities"
        :chat-targets="chat.targets"
        :chat-enabled="chat.config.enabled"
        :chat-members="chat.members"
        :active-chat-target="chat.activeTarget"
        :chat-unread-total="chat.unreadTotal"
        :chat-section-collapsed="settings.sidebarChatsCollapsed"
        :active-activity-id="workbench.activeActivityId || ''"
        :activity-sort="activityNavigator.mode"
        @launch="onLaunch"
        @select-activity="selectActivity"
        @select-chat="openChatTarget"
        @new-chat="openNewChat"
        @choose-workspace="chooseWorkspace"
        @open-workspace="openWorkspace"
        @toggle-collapse="toggleSidebar"
        @rename-activity="renameActivity"
        @stop-activity="stopActivity"
        @archive-activity="archiveActivity"
        @clear-activity="clearActivity"
        @reorder-tools="reorderTools"
        @reorder-activities="reorderActivities"
        @sort-activities="sortActivities"
        @toggle-chat-collapse="settings.set('sidebarChatsCollapsed', !settings.sidebarChatsCollapsed)"
        @settings="openSettings"
      />
    </template>

    <template #activity>
      <PaneFrame
        pane="activity"
        :title="activityTitle"
        :meta="activityMeta"
      >
        <template #actions>
          <ChatPaneActions
            v-if="chat.config.enabled && activeActivity?.id === 'chats'"
            :agents="chatAgentRows"
            @start-agent="startChatAgent"
          />
          <button
            v-else-if="activeActivity?.source?.chatTarget"
            type="button"
            data-chat-return
            :title="`Return to ${activeActivity.source.chatTarget}`"
            class="no-drag flex h-7 items-center gap-1 px-2 text-[9px] font-medium text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="openChatTarget(activeActivity.source.chatTarget)"
          >
            <IconMessages :size="14" :stroke-width="1.8" />
            <span>Return to chat</span>
          </button>
        </template>
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
                :font-size="settings.mimirTerminalFontSize"
                :diagnostic="surfaceDiagnostic(hostedActivity)"
                @open-file="openFileInEditor"
                @choose-workspace="chooseWorkspace"
                @request-stop="stopActivity"
                @restart="restartActivity"
                @launch-app="launchApp"
                @launch-plan="launchAppPlan"
                @open-activity="openActivityRecord"
                @start-work="startGraphWork"
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
    :tools="toolRows"
    :chats="chat.config.enabled ? chat.targets : []"
    :new-activity="newActivityRows"
    :history="historyActivities"
    @close="quickOpen = false"
    @activate="activateQuickOpenResult"
  />
</template>

<script setup>
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { IconAlertTriangle, IconX } from '@tabler/icons-vue'
import { IconMessages } from '@tabler/icons-vue'
import EditorApp from '../editor/App.vue'
import { useActivitiesStore } from '../stores/activities.js'
import { useActivityRuntimeStore } from '../stores/activityRuntime.js'
import { useAppsCatalogStore } from '../stores/appsCatalog.js'
import { useChatStore } from '../stores/chat.js'
import { useFileStore } from '../stores/files.js'
import { useLaunchersStore } from '../stores/launchers.js'
import { useSettingsStore } from '../stores/settings.js'
import { useWorkbenchStore } from '../stores/workbench.js'
import { useWorkspaceFilesStore } from '../stores/workspaceFiles.js'
import { createToolRuntime } from '../services/toolRuntime.js'
import { callAppAction, loadAppData, openAppWindow } from '../services/appsCatalog.js'
import FilesActivity from './activities/FilesActivity.vue'
import RoutinesActivity from './activities/RoutinesActivity.vue'
import ChatActivity from './activities/ChatActivity.vue'
import UnavailableActivity from './activities/UnavailableActivity.vue'
import ActivityHost from './components/ActivityHost.vue'
import PaneFrame from './components/PaneFrame.vue'
import QuickOpen from './components/QuickOpen.vue'
import WorkbenchShell from './components/WorkbenchShell.vue'
import WorkbenchSidebar from './components/WorkbenchSidebar.vue'
import ChatPaneActions from './components/ChatPaneActions.vue'
import { useActivityLifecycle } from './composables/useActivityLifecycle.js'
import { useWorkbenchKeyboardRouting } from './composables/useWorkbenchKeyboardRouting.js'
import { useWorkbenchResize } from './composables/useWorkbenchResize.js'
import { useWorkspaceBootstrap } from './composables/useWorkspaceBootstrap.js'
import { ACTIVITY_SORT_MODES, orderActivities } from './activityOrdering.js'

const TerminalActivity = defineAsyncComponent(
  () => import('./activities/TerminalActivity.vue').then(module => module.default),
)
const AppActivity = defineAsyncComponent(
  () => import('./activities/AppActivity.vue').then(module => module.default),
)
const optionalSurfaces = {
  terminal: TerminalActivity,
  agent: TerminalActivity,
  routine: RoutinesActivity,
  chat: ChatActivity,
}

const CORE_ACTIVITIES = Object.freeze([
  { id: 'files', kind: 'files', title: 'Files' },
  { id: 'routines', kind: 'routine', title: 'Routines' },
  { id: 'chats', kind: 'chat', title: 'Chats' },
])
const CORE_ACTIVITY_IDS = new Set(CORE_ACTIVITIES.map((activity) => activity.id))

const workbench = useWorkbenchStore()
const activities = useActivitiesStore()
const activityRuntime = useActivityRuntimeStore()
const appsCatalog = useAppsCatalogStore()
const chat = useChatStore()
const launchers = useLaunchersStore()
const workspaceFiles = useWorkspaceFilesStore()
const settings = useSettingsStore()
const releaseSettingsSync = settings.startSync()
const editorFiles = useFileStore()
const editorRef = ref(null)
const quickOpen = ref(false)
const diagnostic = ref('')
const activitySurfaces = new Map()

const toolRuntime = createToolRuntime({
  getEditor: () => editorRef.value,
  getWorkspacePath: () => workspaceFiles.workspacePath || null,
  getToday: async () => {
    for (const [id, surface] of activitySurfaces) {
      const activity = activities.byId(id)
      if (activity?.source?.appId !== 'scratch') continue
      const live = surface.todayState?.()
      if (live && !live.loading) return live
    }
    try {
      const raw = await loadAppData('scratch', 'scratch')
      if (raw == null) return { text: '', updatedAt: null }
      const saved = JSON.parse(raw)
      return typeof saved === 'string'
        ? { text: saved, updatedAt: null }
        : {
            text: String(saved?.text || ''),
            updatedAt: saved?.updatedAt || null,
          }
    } catch {
      return { text: '', updatedAt: null, unavailable: true }
    }
  },
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

const workspaceBootstrap = useWorkspaceBootstrap({
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
  coreActivities: CORE_ACTIVITIES,
  openCoreActivity,
  getFocusOwner: () => lastWorkbenchFocus.value.owner,
})
const {
  chooseWorkspace,
  ensureCoreActivities,
  focusNarrowPane,
  initialized,
  openWorkspace,
  persistWorkbench,
  responsiveZone,
  syncResponsiveLayout,
  viewportWidth,
} = workspaceBootstrap

const resize = useWorkbenchResize(workbench, {
  persist: (layout) => persistWorkbench(layout),
})

const activityLifecycle = useActivityLifecycle({
  activities,
  activityRuntime,
  launchers,
  workbench,
  workspacePath: computed(() => workspaceFiles.workspacePath),
  diagnostic,
  coreActivityIds: CORE_ACTIVITY_IDS,
  isStableActivity: isToolActivity,
  getSidebarActivities: () => sidebarActivities.value,
  openCoreActivity,
  selectActivity,
  openActivityRecord,
})
const {
  archiveActivity,
  clearActivity,
  closeActivity,
  closingActivityIds,
  renameActivity,
  restartActivity,
  restoreActivity,
  stopActivity,
} = activityLifecycle

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
      && !isToolActivity(activity)
      && !closingActivityIds.value.has(activity.id)
    )),
    {
      mode: activityNavigator.value.mode,
      manualOrder: activityNavigator.value.order,
    },
  )
))
const historyActivities = computed(() => (
  activities.archivedActivities
    .filter(activity => !isToolActivity(activity))
    .map(activity => ({
      ...activity,
      resumeAvailable: Boolean(
        ['agent', 'routine'].includes(activity.kind)
        && !activity.source?.appId
        && activity.session?.cliSessionId
        && activity.host?.type === 'pty'
        && activity.host?.resumeStrategy
        && activity.host.resumeStrategy !== 'none'
        && launchers.byId(activity.source?.presetId || activity.source?.launcherId),
      ),
    }))
))
const activeActivity = computed(() => (
  activities.byId(workbench.activeActivityId) || null
))
const activityTitle = computed(() => {
  if (activeActivity.value?.id !== 'chats') return activeActivity.value?.title || 'Activity'
  const target = chat.activeRecord
  if (!target) return 'Chats'
  return target.kind === 'channel'
    ? target.id
    : target.title || target.id
})
const activityMeta = computed(() => {
  const activity = activeActivity.value
  if (!activity) return 'Unavailable'
  if (activity.id === 'chats') {
    if (chat.status.state !== 'connected') {
      return chat.status.state.replace('_', ' ')
    }
    const target = chat.activeRecord
    if (!target) return 'No chats'
    const topic = String(target.topic || '').trim()
    const members = target.kind === 'channel'
      ? `${target.memberCount} ${target.memberCount === 1 ? 'member' : 'members'}`
      : ''
    return [topic, members].filter(Boolean).join(' · ')
  }
  if (activity.source?.chatTarget) {
    return `${humanStatus(activity.status)} · ${activity.source.chatTarget}`
  }
  return humanStatus(activity.status)
})
const workspaceName = computed(() => basename(workspaceFiles.workspacePath))
const recentWorkspaces = computed(() => (
  (Array.isArray(settings.recentWorkspaceFolders) ? settings.recentWorkspaceFolders : [])
    .map(path => ({ path, name: basename(path) }))
))
const editorTitle = computed(() => {
  const path = editorFiles.currentFile?.path
  return path ? basename(path) : 'Editor'
})
const editorMeta = computed(() => {
  const file = editorFiles.currentFile
  if (!file) return 'No document'
  return file.dirty ? 'Unsaved' : `${editorFiles.openFiles.length} tab${editorFiles.openFiles.length === 1 ? '' : 's'}`
})

const stableApps = computed(() => appsCatalog.apps.filter(
  app => !createsFreshActivity(app),
))
const freshActivityApps = computed(() => appsCatalog.apps.filter(createsFreshActivity))
const toolAppIds = computed(() => new Set(stableApps.value.map(app => app.id)))

const toolRows = computed(() => orderSidebarRows([
  {
    id: 'core:files',
    activityId: 'files',
    title: 'Files',
    icon: 'files',
    shortcut: '',
    available: true,
  },
  {
    id: 'core:routines',
    activityId: 'routines',
    title: 'Routines',
    icon: 'routines',
    shortcut: '',
    available: true,
  },
  ...stableApps.value.map(appRow),
], settings.sidebarToolOrder))

const newActivityRows = computed(() => orderSidebarRows([
  ...launchers.decoratedPresets.filter(
    preset => preset.enabled && preset.available,
  ).map((preset) => ({
    id: `preset:${preset.id}`,
    title: preset.title,
    icon: launcherIcon(preset),
    shortcut: '',
    available: preset.available,
    unavailableReason: preset.unavailableReason,
  })),
  ...freshActivityApps.value.map(appRow),
], settings.sidebarNewActivityOrder))
const chatAgentRows = computed(() => launchers.decoratedPresets.filter(
  preset => preset.kind === 'agent',
))

function appRow(app) {
  return {
    id: `app:${app.id}`,
    title: app.title,
    icon: app.id === 'scratch'
      ? 'today'
      : app.id === 'business-graph'
        ? 'graph'
        : (app.mode === 'terminal' ? 'terminal' : 'apps'),
    shortcut: '',
    available: true,
  }
}

function createsFreshActivity(app) {
  return ['terminal', 'process'].includes(app?.mode)
}

function isToolActivity(activity) {
  return activity?.kind === 'app'
    && toolAppIds.value.has(activity.source?.appId)
}

const {
  closeNativeFocusedSurface,
  lastFocus: lastWorkbenchFocus,
  onKeydown,
  rememberWorkbenchFocus,
} = useWorkbenchKeyboardRouting({
  quickOpen,
  settings,
  editorRef,
  editorFiles,
  workbench,
  sidebarActivities,
  toggleSidebar,
  selectActivity,
  closeActivity,
  collapseEmptyEditor,
})

function launcherIcon(preset) {
  if (preset.kind === 'terminal') return 'terminal'
  const source = String(preset.agentId || preset.id || '').toLowerCase()
  if (source.includes('codex')) return 'codex'
  if (source.includes('claude')) return 'claude'
  if (source === 'pi' || source.includes('pi-')) return 'pi'
  if (source.includes('gemini')) return 'gemini'
  return 'agent'
}

function orderSidebarRows(rows, savedOrder) {
  const orderIndex = new Map(
    (Array.isArray(savedOrder) ? savedOrder : [])
      .map((id, index) => [id, index]),
  )
  return rows
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .sort((left, right) => {
      const leftIndex = orderIndex.get(left.row.id)
      const rightIndex = orderIndex.get(right.row.id)
      if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
      if (leftIndex !== undefined) return -1
      if (rightIndex !== undefined) return 1
      return left.sourceIndex - right.sourceIndex
    })
    .map(({ row }) => row)
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
  () => chat.config.enabled,
  enabled => {
    if (!enabled && workbench.activeActivityId === 'chats') {
      openCoreActivity('files')
    }
  },
)

onMounted(async () => {
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', rememberWorkbenchFocus, true)
  // focusin alone misses Sidebar clicks: WebKit does not focus buttons on
  // click, so the pane must be remembered at pointerdown.
  document.addEventListener('pointerdown', rememberWorkbenchFocus, true)
  window.addEventListener('resize', syncResponsiveLayout)
  window.__mimir_activityPaste = pasteToActiveTerminal
  await Promise.all([
    workspaceBootstrap.start(),
    chat.initialize().catch((cause) => {
      if (!diagnostic.value) diagnostic.value = `Chat could not initialize: ${errorMessage(cause)}`
    }),
  ])
})

onUnmounted(() => {
  persistWorkbench()
  void settings.flush()
  releaseSettingsSync()
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('focusin', rememberWorkbenchFocus, true)
  document.removeEventListener('pointerdown', rememberWorkbenchFocus, true)
  window.removeEventListener('resize', syncResponsiveLayout)
  resize.dispose()
  activityLifecycle.dispose()
  workspaceBootstrap.dispose()
  workspaceFiles.dispose()
  activityRuntime.dispose()
  toolRuntime.stop()
  chat.dispose()
  if (window.__mimir_activityPaste === pasteToActiveTerminal) {
    delete window.__mimir_activityPaste
  }
  activitySurfaces.clear()
})

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

async function openChatTarget(target = '') {
  if (!chat.config.enabled) return
  ensureCoreActivities()
  if (target) {
    try {
      await chat.selectTarget(target)
    } catch (cause) {
      diagnostic.value = `Could not open ${target}: ${errorMessage(cause)}`
    }
  }
  workbench.openActivity('chats')
  focusNarrowPane('activity')
  workbench.setPaneState('activity', 'expanded')
  requestEntryFocus('chats')
}

async function openNewChat() {
  await openChatTarget(chat.activeTarget)
  chat.requestNewChat('menu')
}

async function startChatAgent(presetId) {
  const preset = launchers.byId(presetId)
    || launchers.availablePresets.find(candidate => candidate.kind === 'agent')
  const target = chat.activeTarget
  if (!target || !preset) {
    diagnostic.value = preset
      ? 'Open a chat before starting an agent.'
      : 'No agent launcher is configured. Add Codex, Claude, Pi, or Gemini in Settings.'
    return
  }
  if (!preset.available) {
    diagnostic.value = `${preset.title} is unavailable: ${preset.unavailableReason || 'binary not found'}.`
    return
  }
  if (!workspaceFiles.workspacePath && preset.cwd?.mode === 'workspace') {
    diagnostic.value = `Open a workspace before starting ${preset.title}.`
    return
  }
  const agentLabel = String(preset.agentId || preset.id || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 16) || 'agent'
  const prompt = [
    `You are joining the Mimir team chat ${target}.`,
    'The chat tools are `mimir` CLI commands, not native tools, and default to this room; pass target to reach another room (`mimir call chat_rooms \'{}\'` lists them).',
    `Read the recent transcript first: \`mimir call chat_read '{"limit":20}'\`.`,
    `Post with \`mimir call chat_send '{"text":"..."}'\`; \`mimir call chat_search '{"query":"..."}'\` finds older context and \`mimir call chat_download '{"file_id":"..."}'\` fetches an attachment.`,
    'Be explicit about what you know, what you changed, and what you need from the team.',
  ].join(' ')
  try {
    diagnostic.value = ''
    await activityRuntime.launchPreset(preset, workspaceFiles.workspacePath, {
      title: `${preset.title} · ${target}`,
      seedInput: `${prompt} Task: `,
      retention: 'durable',
      source: {
        type: 'chat-agent',
        chatServerId: 'chat.shoulde.rs',
        chatTarget: target,
      },
      beforeSpawn: record => chat.linkActivity(record.id, target, agentLabel),
    })
    workbench.setPaneState('activity', 'expanded')
  } catch (cause) {
    diagnostic.value = `Could not start ${preset.title} in ${target}: ${errorMessage(cause)}`
  }
}

async function startGraphWork(request) {
  const requestedPresetId = String(request?.presetId || '')
  const preset = launchers.availablePresets.find(candidate => (
    candidate.kind === 'agent'
    && (!requestedPresetId || candidate.id === requestedPresetId)
  ))
  if (!preset) {
    diagnostic.value = requestedPresetId
      ? `The selected agent preset '${requestedPresetId}' is not available. Choose another agent or update Settings.`
      : 'Start work needs one available agent launcher. Configure Codex, Claude, Pi, or Gemini in Launchers.'
    return
  }
  if (!workspaceFiles.workspacePath) {
    diagnostic.value = `Open a workspace before starting work on ${request?.title || 'this graph item'}.`
    return
  }
  try {
    diagnostic.value = ''
    const title = request.sourceType === 'business-graph-summary'
      ? request.title || 'Change summary'
      : request.background
        ? request.title || 'Dispatch'
        : `Work · ${request.title || request.nodeId}`
    await activityRuntime.launchPreset(preset, workspaceFiles.workspacePath, {
      title,
      args: [String(request.prompt || '')],
      retention: 'durable',
      open: !request.background,
      source: {
        type: request.sourceType
          || (request.background ? 'business-graph-dispatch' : 'business-graph-work'),
        graphNodeId: request.nodeId,
        graphNodeKind: request.nodeKind,
        graphScopeIds: request.scopeIds || [],
        graphRevision: request.graphRevision,
        ...(request.sourceType === 'business-graph-summary'
          ? {
              graphEventSince: request.graphEventSince,
              graphEventCount: request.graphEventCount,
              graphContextShortened: Boolean(request.graphContextShortened),
              graphContextBytes: request.graphContextBytes,
            }
          : {}),
      },
    })
    if (!request.background) workbench.setPaneState('activity', 'expanded')
  } catch (cause) {
    diagnostic.value = `Could not start work on ${request?.title || request?.nodeId || 'graph item'}: ${errorMessage(cause)}`
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
  requestEntryFocus(id)
}

// Selecting an Activity must land keyboard focus inside its surface: WebKit
// leaves focus on <body> after Sidebar clicks, so surfaces that expose
// focusEntry are focused explicitly. Lazily mounted surfaces are not
// registered yet at selection time; setActivitySurface consumes the pending
// id once the surface appears.
let pendingEntryFocusId = ''

function requestEntryFocus(id) {
  const surface = activitySurfaces.get(id)
  pendingEntryFocusId = surface ? '' : id
  if (surface) void nextTick(() => surface.focusEntry?.())
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

function reorderTools(ids) {
  const visible = new Set(toolRows.value.map((row) => row.id))
  const retained = (Array.isArray(settings.sidebarToolOrder)
    ? settings.sidebarToolOrder
    : []
  ).filter((id) => !visible.has(id))
  settings.set('sidebarToolOrder', [...ids, ...retained])
}

function sortActivities(mode) {
  settings.set('activityNavigator', {
    mode: ACTIVITY_SORT_MODES.includes(mode) ? mode : 'manual',
    order: activityNavigator.value.order,
  })
}

function openSettings() {
  editorRef.value?.mimirOpenSettings?.('appearance')
}

function activateQuickOpenResult(result) {
  if (!result?.type) return
  if (result.type === 'file') {
    void openFileInEditor(result.path)
    return
  }
  if (result.type === 'chat') {
    void openChatTarget(result.target)
    return
  }
  if (result.type === 'tool' || result.type === 'new-activity') {
    void onLaunch(result.targetId)
    return
  }
  if (result.type === 'history') {
    void restoreActivity(result.activityId)
  }
}

async function openFileInEditor(request) {
  const path = typeof request === 'string' ? request : request?.path
  if (!path) return
  try {
    await editorRef.value?.mimirOpen(path, {
      preview: Boolean(typeof request === 'object' && request?.preview),
      entry: typeof request === 'object' ? request?.entry || null : null,
    })
    focusNarrowPane('editor')
    workbench.setPaneState('editor', 'expanded')
    diagnostic.value = ''
  } catch (cause) {
    diagnostic.value = `${basename(path)} could not be opened: ${errorMessage(cause)}`
  }
}

function collapseEmptyEditor() {
  workbench.setPaneState('editor', 'rail')
}

function onEditorNavigate() {
  focusNarrowPane('editor')
  workbench.setPaneState('editor', 'expanded')
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
    return 'The Routines surface is not installed. Check local routine definitions and restart Mimir.'
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
  if (typeof activity === 'string') {
    if (activities.byId(activity)) selectActivity(activity)
    else diagnostic.value = `Activity '${activity}' is no longer available.`
    return
  }
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
  if (surface) {
    activitySurfaces.set(id, surface)
    if (pendingEntryFocusId === id && workbench.activeActivityId === id) {
      pendingEntryFocusId = ''
      void nextTick(() => surface.focusEntry?.())
    }
  } else {
    activitySurfaces.delete(id)
  }
}

async function pasteToActiveTerminal(text) {
  const activity = activities.byId(workbench.activeActivityId)
  if (!activity || activity.host?.type !== 'pty') return false
  return Boolean(await activitySurfaces.get(activity.id)?.pasteText?.(text))
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
