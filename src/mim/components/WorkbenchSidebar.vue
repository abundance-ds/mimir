<template>
  <aside
    ref="sidebarRoot"
    class="flex h-full min-h-0 flex-col overflow-hidden bg-chrome"
    :class="collapsed ? 'w-[52px]' : 'w-full'"
    :data-sidebar-state="collapsed ? 'rail' : 'expanded'"
  >
    <div
      data-sidebar-header
      class="drag-region flex h-11 shrink-0 items-center justify-end border-b border-rule px-2"
      data-tauri-drag-region="deep"
    >
      <button
        v-if="!collapsed"
        type="button"
        data-sidebar-collapse
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
        class="no-drag grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('toggleCollapse')"
      >
        <IconLayoutSidebarLeftCollapse :size="15" :stroke-width="1.8" />
      </button>
    </div>

    <WorkspaceSwitcher
      :collapsed="collapsed"
      :workspace-name="workspaceName"
      :workspace-path="workspacePath"
      :recent-workspaces="recentWorkspaces"
      @choose-workspace="$emit('chooseWorkspace')"
      @open-workspace="$emit('openWorkspace', $event)"
    />

    <nav class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1" aria-label="Launchers and activities">
      <div
        class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3"
        :class="{ invisible: collapsed }"
        :aria-hidden="collapsed"
      >
        Launch
      </div>
      <SidebarRow
        v-for="launcher in launchers"
        :key="`launcher:${launcher.id}`"
        :data-sidebar-row="`launcher:${launcher.id}`"
        :data-launcher-available="launcher.available === false ? 'false' : 'true'"
        :aria-disabled="launcher.available === false ? 'true' : undefined"
        :title="launcherTitle(launcher)"
        :label="launcher.title"
        :meta="launcher.available === false ? 'missing' : launcher.shortcut"
        :collapsed="collapsed"
        :active="false"
        :muted="launcher.available === false"
        @click="$emit('launch', launcher.id)"
      >
        <span :data-launcher-identity="launcher.icon" class="grid size-7 place-items-center">
          <component
            :is="iconFor(launcher.icon)"
            :size="16"
            :stroke-width="1.7"
            :monochrome="true"
          />
        </span>
      </SidebarRow>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div data-sidebar-apps-header class="flex h-7 items-center px-3">
        <template v-if="!collapsed">
          <button
            type="button"
            data-sidebar-apps-toggle
            :aria-expanded="!appsCollapsed"
            title="Toggle Apps"
            class="flex h-6 min-w-0 flex-1 items-center gap-1 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="appsCollapsed = !appsCollapsed"
            @keydown.right.prevent="appsCollapsed = false"
            @keydown.left.prevent="appsCollapsed = true"
          >
            <IconChevronRight v-if="appsCollapsed" :size="12" :stroke-width="2" />
            <IconChevronDown v-else :size="12" :stroke-width="2" />
            <span>Apps</span>
          </button>
          <button
            type="button"
            data-sidebar-manage-apps
            title="Manage apps"
            aria-label="Manage apps"
            class="ml-1 grid size-6 place-items-center text-ink-4 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('manageApps')"
          >
            <IconSettings :size="13" :stroke-width="1.8" />
          </button>
        </template>
        <span v-else class="h-px w-7 bg-rule-light" aria-hidden="true" />
      </div>
      <template v-if="collapsed || !appsCollapsed">
        <SidebarRow
          v-for="app in apps"
          :key="`app:${app.id}`"
          :data-sidebar-row="`launcher:${app.id}`"
          :data-launcher-available="app.available === false ? 'false' : 'true'"
          :aria-disabled="app.available === false ? 'true' : undefined"
          :title="launcherTitle(app)"
          :label="app.title"
          :meta="app.available === false ? 'missing' : app.shortcut"
          :collapsed="collapsed"
          :active="false"
          :muted="app.available === false"
          @click="$emit('launch', app.id)"
        >
          <span :data-launcher-identity="app.icon" class="grid size-7 place-items-center">
            <component
              :is="iconFor(app.icon)"
              :size="16"
              :stroke-width="1.7"
              :monochrome="true"
            />
          </span>
        </SidebarRow>
      </template>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div
        class="relative flex h-7 items-center px-3"
      >
        <span v-if="collapsed" class="h-px w-7 bg-rule-light" aria-hidden="true" />
        <template v-else>
          <button
            type="button"
            data-sidebar-activities-toggle
            :aria-expanded="!activitiesCollapsed"
            title="Toggle Activities"
            class="flex h-6 min-w-0 flex-1 items-center gap-1 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="activitiesCollapsed = !activitiesCollapsed"
            @keydown.right.prevent="activitiesCollapsed = false"
            @keydown.left.prevent="activitiesCollapsed = true"
          >
            <IconChevronRight v-if="activitiesCollapsed" :size="12" :stroke-width="2" />
            <IconChevronDown v-else :size="12" :stroke-width="2" />
            <span>Activities</span>
          </button>
          <span class="ml-1 flex items-center gap-1">
          <span class="font-mono text-[9px] tabular-nums text-ink-4">{{ activities.length }}</span>
          <button
            type="button"
            data-activity-sort-button
            data-no-reorder
            :aria-expanded="sortMenuOpen"
            aria-haspopup="menu"
            :title="`Sort Activities: ${sortLabel(activitySort)}`"
            aria-label="Sort Activities"
            class="grid size-6 place-items-center text-ink-4 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @pointerdown.stop
            @click.stop="toggleSortMenu"
            @keydown.down.stop.prevent="openSortMenu"
          >
            <IconArrowsSort :size="13" :stroke-width="1.8" />
          </button>
          <div
            v-if="sortMenuOpen"
            data-activity-sort-menu
            class="absolute right-0 top-6 z-50 w-36 border border-rule bg-surface py-1 shadow-lg"
            role="menu"
            @pointerdown.stop
            @click.stop
            @keydown="onMenuKeydown($event, 'sort')"
          >
            <button
              v-for="option in SORT_OPTIONS"
              :key="option.id"
              class="activity-menu-item"
              :class="{ 'text-accent': activitySort === option.id }"
              role="menuitemradio"
              tabindex="-1"
              :aria-checked="activitySort === option.id"
              @click="selectSort(option.id)"
            >
              <IconCheck v-if="activitySort === option.id" :size="12" />
              <span v-else class="size-3" />
              {{ option.label }}
            </button>
          </div>
          </span>
        </template>
      </div>
      <template v-if="collapsed || !activitiesCollapsed">
      <SidebarRow
        v-for="activity in activities"
        :key="`activity:${activity.id}`"
        :data-sidebar-row="`activity:${activity.id}`"
        :data-activity-key="activity.id"
        :data-drop-position="dropPosition(activity.id)"
        :title="activityTitle(activity)"
        :label="activity.title"
        :meta="activity.status"
        :collapsed="collapsed"
        :active="activeActivityId === activity.id"
        :copy-id="`activity:${activity.id}`"
        @pointerdown="onActivityPointerDown($event, activity.id)"
        @dblclick.stop="beginRename(activity)"
        @contextmenu.prevent="openActivityMenu(activity.id)"
        @keydown="onActivityKeydown($event, activity)"
        @click="selectActivity(activity.id)"
      >
        <span
          :data-sidebar-monogram="activity.id"
          :data-activity-identity="activityIdentity(activity)"
          class="relative grid size-7 place-items-center font-mono text-[10px] font-semibold"
        >
          <component
            :is="activityIcon(activity)"
            :size="15"
            :stroke-width="1.7"
            :monochrome="true"
            aria-hidden="true"
          />
          <span
            :data-activity-status="activity.status"
            class="absolute -bottom-px -right-px size-2 rounded-full border-2 border-chrome"
            :class="statusClass(activity.status)"
            :title="activity.status"
          />
          <span
            v-if="activity.unread"
            :data-activity-unread="activity.id"
            class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent"
            aria-label="Unread activity"
          />
        </span>
        <template #label>
          <input
            v-if="renamingId === activity.id"
            :data-activity-rename="activity.id"
            v-model="renameDraft"
            class="h-6 w-full min-w-0 border border-accent bg-surface px-1.5 text-[11px] text-ink outline-none"
            aria-label="Activity name"
            @click.stop
            @keydown.enter.prevent="commitRename(activity)"
            @keydown.escape.prevent="cancelRename"
            @blur="commitRename(activity)"
          />
          <span v-else>{{ activity.title }}</span>
        </template>
        <template #trailing>
          <button
            type="button"
            :data-activity-menu-button="activity.id"
            :aria-expanded="activityMenuId === activity.id"
            aria-haspopup="menu"
            aria-label="Activity actions"
            title="Activity actions"
            data-no-reorder
            class="grid size-7 place-items-center text-ink-4 opacity-60 hover:bg-chrome-high hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @pointerdown.stop
            @click.stop="toggleActivityMenu(activity.id)"
          >
            <IconDots :size="14" :stroke-width="1.8" />
          </button>
          <div
            v-if="activityMenuId === activity.id"
            :data-activity-menu="activity.id"
            class="absolute right-1 top-8 z-50 w-36 border border-rule bg-surface py-1 shadow-lg"
            role="menu"
            @pointerdown.stop
            @click.stop
            @keydown="onMenuKeydown($event, 'activity', activity.id)"
          >
            <button class="activity-menu-item" role="menuitem" tabindex="-1" @click="beginRename(activity)">
              <IconPencil :size="12" /> Rename
            </button>
            <button
              v-if="canStop(activity)"
              class="activity-menu-item text-rem"
              role="menuitem"
              tabindex="-1"
              @click="runAction('stopActivity', activity.id)"
            >
              <IconPlayerStop :size="12" /> Stop / kill
            </button>
            <button
              v-if="activity.retention === 'durable'"
              class="activity-menu-item"
              :class="{ 'cursor-not-allowed opacity-45': canStop(activity) }"
              role="menuitem"
              tabindex="-1"
              :disabled="canStop(activity)"
              :title="canStop(activity) ? 'Stop this Activity before archiving it' : 'Archive Activity'"
              @click="runAction('archiveActivity', activity.id)"
            >
              <IconArchive :size="12" /> Archive
            </button>
            <button
              v-if="!canStop(activity)"
              class="activity-menu-item text-rem"
              role="menuitem"
              tabindex="-1"
              @click="runAction('clearActivity', activity.id)"
            >
              <IconTrash :size="12" /> Delete
            </button>
            <div class="my-1 h-px bg-rule-light" role="separator" />
            <button
              class="activity-menu-item"
              role="menuitem"
              tabindex="-1"
              :disabled="activityIndex(activity.id) === 0"
              @click="moveActivity(activity.id, -1)"
            >
              <IconArrowUp :size="12" /> Move up
            </button>
            <button
              class="activity-menu-item"
              role="menuitem"
              tabindex="-1"
              :disabled="activityIndex(activity.id) === activities.length - 1"
              @click="moveActivity(activity.id, 1)"
            >
              <IconArrowDown :size="12" /> Move down
            </button>
          </div>
        </template>
      </SidebarRow>

      <div v-if="activities.length === 0 && !collapsed" class="px-3 py-3 text-[10px] leading-relaxed text-ink-3">
        Runs stay here while you work.
      </div>

      <template v-if="archivedActivities.length">
        <div class="mx-3 my-2 h-px bg-rule" />
        <button
          type="button"
          data-sidebar-archived-toggle
          :aria-expanded="archivedOpen"
          :title="archivedOpen ? 'Hide archived Activities' : `Show ${archivedActivities.length} archived Activities`"
          class="group relative flex h-8 w-full items-center text-left text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          @click="archivedOpen = !archivedOpen"
          @keydown.right.prevent="archivedOpen = true"
          @keydown.left.prevent="archivedOpen = false"
        >
          <span class="ml-3 grid size-7 shrink-0 place-items-center">
            <IconArchive :size="14" :stroke-width="1.7" />
          </span>
          <template v-if="!collapsed">
            <span class="ml-2 min-w-0 flex-1 font-sans text-[10px]">Archived</span>
            <span class="mr-2 font-mono text-[9px] tabular-nums text-ink-4">{{ archivedActivities.length }}</span>
            <IconChevronDown
              v-if="archivedOpen"
              :size="12"
              :stroke-width="2"
              class="mr-3 shrink-0"
            />
            <IconChevronRight
              v-else
              :size="12"
              :stroke-width="2"
              class="mr-3 shrink-0"
            />
          </template>
          <span
            v-else
            class="absolute ml-7 mt-[-18px] min-w-3 rounded-full bg-chrome-high px-0.5 text-center font-mono text-[7px] leading-3 text-ink-2"
          >{{ archivedActivities.length }}</span>
        </button>
        <SidebarRow
          v-for="activity in (archivedOpen ? archivedActivities : [])"
          :key="`archived:${activity.id}`"
          :data-sidebar-row="`archived:${activity.id}`"
          :title="`${activity.title} — archived`"
          :label="activity.title"
          meta="archived"
          :collapsed="collapsed"
          muted
          @dblclick.stop="beginRename(activity)"
          @contextmenu.prevent="openActivityMenu(activity.id)"
          @keydown="onActivityKeydown($event, activity)"
        >
          <span
            class="grid size-7 place-items-center font-mono text-[10px] font-semibold"
            :data-activity-identity="activityIdentity(activity)"
          >
            <component
              :is="activityIcon(activity)"
              :size="15"
              :stroke-width="1.7"
              :monochrome="true"
            />
          </span>
          <template #label>
            <input
              v-if="renamingId === activity.id"
              :data-activity-rename="activity.id"
              v-model="renameDraft"
              class="h-6 w-full min-w-0 border border-accent bg-surface px-1.5 text-[11px] text-ink outline-none"
              aria-label="Activity name"
              @click.stop
              @keydown.enter.prevent="commitRename(activity)"
              @keydown.escape.prevent="cancelRename"
              @blur="commitRename(activity)"
            />
            <span v-else>{{ activity.title }}</span>
          </template>
          <template #trailing>
            <button
              type="button"
              :data-activity-menu-button="activity.id"
              :aria-expanded="activityMenuId === activity.id"
              aria-haspopup="menu"
              title="Archived Activity actions"
              aria-label="Archived Activity actions"
              class="grid size-7 place-items-center text-ink-4 opacity-60 hover:bg-chrome-high hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              @pointerdown.stop
              @click.stop="toggleActivityMenu(activity.id)"
            >
              <IconDots :size="14" />
            </button>
            <div
              v-if="activityMenuId === activity.id"
              :data-activity-menu="activity.id"
              class="absolute right-1 top-8 z-50 w-36 border border-rule bg-surface py-1 shadow-lg"
              role="menu"
              @pointerdown.stop
              @click.stop
              @keydown="onMenuKeydown($event, 'activity', activity.id)"
            >
              <button class="activity-menu-item" role="menuitem" tabindex="-1" @click="beginRename(activity)">
                <IconPencil :size="12" /> Rename
              </button>
              <button class="activity-menu-item" role="menuitem" tabindex="-1" @click="runAction('restoreActivity', activity.id)">
                <IconArchiveOff :size="12" /> Restore
              </button>
              <button class="activity-menu-item text-rem" role="menuitem" tabindex="-1" @click="runAction('clearActivity', activity.id)">
                <IconTrash :size="12" /> Delete
              </button>
            </div>
          </template>
        </SidebarRow>
      </template>
      </template>
    </nav>

    <footer
      data-sidebar-footer
      class="shrink-0 border-t border-rule-light px-3 py-2"
    >
      <button
        type="button"
        data-sidebar-settings
        title="Settings"
        aria-label="Settings"
        class="group flex h-8 w-full items-center text-left text-[11px] text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('settings')"
      >
        <span class="grid size-7 shrink-0 place-items-center text-ink-3 group-hover:text-ink">
          <IconSettings :size="16" :stroke-width="1.8" />
        </span>
        <span v-if="!collapsed" class="ml-1 min-w-0 flex-1 truncate pr-2">Settings</span>
      </button>
    </footer>
  </aside>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconArrowDown,
  IconArrowUp,
  IconArchive,
  IconArchiveOff,
  IconApps,
  IconArrowsSort,
  IconBrandGit,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFileStack,
  IconLayoutSidebarLeftCollapse,
  IconMathPi,
  IconSettings,
  IconRobot,
  IconTerminal2,
  IconClockPlay,
  IconSparkles,
  IconPencil,
  IconPlayerStop,
  IconTrash,
} from '@tabler/icons-vue'
import SidebarRow from './SidebarRow.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import { moveActivityId } from '../activityOrdering.js'
import { usePointerReorder } from '../composables/usePointerReorder.js'
import IconProviderAnthropic from '../../shared/icons/IconProviderAnthropic.vue'
import IconProviderOpenAI from '../../shared/icons/IconProviderOpenAI.vue'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  recentWorkspaces: { type: Array, default: () => [] },
  launchers: { type: Array, default: () => [] },
  apps: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  archivedActivities: { type: Array, default: () => [] },
  activeActivityId: { type: String, default: '' },
  activitySort: { type: String, default: 'manual' },
})

const emit = defineEmits([
  'launch',
  'selectActivity',
  'chooseWorkspace',
  'openWorkspace',
  'toggleCollapse',
  'renameActivity',
  'stopActivity',
  'archiveActivity',
  'restoreActivity',
  'clearActivity',
  'reorderActivities',
  'sortActivities',
  'settings',
  'manageApps',
])
const activityMenuId = ref('')
const sortMenuOpen = ref(false)
const appsCollapsed = ref(false)
const activitiesCollapsed = ref(false)
const archivedOpen = ref(false)
const renamingId = ref('')
const renameDraft = ref('')
const sidebarRoot = ref(null)
const LIVE_STATUSES = new Set(['ready', 'starting', 'working', 'needs-input', 'idle'])
const SORT_OPTIONS = Object.freeze([
  { id: 'manual', label: 'Manual' },
  { id: 'recent', label: 'Most recent' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'name', label: 'Name' },
])

onMounted(() => document.addEventListener('pointerdown', closeMenus))
onUnmounted(() => document.removeEventListener('pointerdown', closeMenus))

const {
  dropIndicator,
  suppressClick,
  onPointerDown: onActivityPointerDown,
} = usePointerReorder({
  root: sidebarRoot,
  rowSelector: '[data-activity-key]',
  keyAttribute: 'data-activity-key',
  keys: () => props.activities.map((activity) => activity.id),
  onReorder: (ids) => emit('reorderActivities', ids),
})

const icons = {
  files: IconFileStack,
  agent: IconRobot,
  codex: IconProviderOpenAI,
  claude: IconProviderAnthropic,
  pi: IconMathPi,
  terminal: IconTerminal2,
  apps: IconApps,
  changes: IconBrandGit,
  routines: IconClockPlay,
  default: IconSparkles,
}

function iconFor(name) {
  return icons[name] || icons.default
}

function launcherTitle(launcher) {
  if (launcher.available !== false) return launcher.title
  return `${launcher.title} — ${launcher.unavailableReason || 'Unavailable'}`
}

function activityTitle(activity) {
  return `${activity.title} — ${activityIdentity(activity)} · ${String(activity.status).replace('-', ' ')}`
}

function statusClass(status) {
  return {
    working: 'bg-accent',
    starting: 'bg-accent',
    'needs-input': 'bg-rem',
    error: 'bg-rem',
    done: 'bg-add',
    ready: 'bg-ink-3',
    idle: 'bg-ink-3',
    stopped: 'bg-ink-4',
    interrupted: 'bg-ink-4',
  }[status] || 'bg-ink-4'
}

function canStop(activity) {
  return activity?.host?.type === 'pty' && LIVE_STATUSES.has(activity.status)
}

async function toggleActivityMenu(id) {
  sortMenuOpen.value = false
  activityMenuId.value = activityMenuId.value === id ? '' : id
  if (activityMenuId.value) {
    await nextTick()
    focusFirstMenuItem(`[data-activity-menu="${id}"]`)
  }
}

async function openActivityMenu(id) {
  sortMenuOpen.value = false
  activityMenuId.value = id
  await nextTick()
  focusFirstMenuItem(`[data-activity-menu="${id}"]`)
}

async function toggleSortMenu() {
  activityMenuId.value = ''
  sortMenuOpen.value = !sortMenuOpen.value
  if (sortMenuOpen.value) {
    await nextTick()
    focusFirstMenuItem('[data-activity-sort-menu]')
  }
}

async function openSortMenu() {
  activityMenuId.value = ''
  sortMenuOpen.value = true
  await nextTick()
  focusFirstMenuItem('[data-activity-sort-menu]')
}

function closeMenus(event) {
  if (event?.target?.closest?.(
    '[data-activity-menu], [data-activity-menu-button], [data-activity-sort-menu], [data-activity-sort-button]',
  )) return
  activityMenuId.value = ''
  sortMenuOpen.value = false
}

async function beginRename(activity) {
  activityMenuId.value = ''
  renamingId.value = activity.id
  renameDraft.value = activity.title
  await nextTick()
  const field = document.querySelector('[data-activity-rename]')
  field?.focus()
  field?.select()
}

function commitRename(activity) {
  if (renamingId.value !== activity.id) return
  const title = renameDraft.value.trim()
  renamingId.value = ''
  if (title && title !== activity.title) {
    emit('renameActivity', { id: activity.id, title })
  }
}

function cancelRename() {
  renamingId.value = ''
}

function runAction(event, id) {
  activityMenuId.value = ''
  emit(event, id)
  nextTick(() => {
    sidebarRoot.value?.querySelector(`[data-activity-menu-button="${id}"]`)?.focus()
  })
}

function selectActivity(id) {
  if (!suppressClick.value) emit('selectActivity', id)
}

function activityIdentity(activity) {
  const source = String(
    activity.source?.presetId
    || activity.source?.launcherId
    || activity.source?.appId
    || activity.kind
    || '',
  ).toLowerCase()
  if (source.includes('codex')) return 'Codex'
  if (source.includes('claude')) return 'Claude'
  if (source === 'pi' || source.includes('pi-')) return 'Pi'
  if (activity.kind === 'terminal') return 'Terminal'
  if (activity.kind === 'app') return 'App'
  if (activity.kind === 'routine') return 'Routine'
  return 'Agent'
}

function activityIcon(activity) {
  return {
    Codex: IconProviderOpenAI,
    Claude: IconProviderAnthropic,
    Pi: IconMathPi,
    Terminal: IconTerminal2,
    App: IconApps,
    Routine: IconClockPlay,
    Agent: IconRobot,
  }[activityIdentity(activity)]
}

function activityIndex(id) {
  return props.activities.findIndex((activity) => activity.id === id)
}

function moveActivity(id, direction) {
  const reordered = moveActivityId(
    props.activities.map((activity) => activity.id),
    id,
    direction,
  )
  activityMenuId.value = ''
  emit('reorderActivities', reordered)
  nextTick(() => {
    sidebarRoot.value?.querySelector(`[data-activity-menu-button="${id}"]`)?.focus()
  })
}

function onActivityKeydown(event, activity) {
  if (event.target?.tagName === 'INPUT') return
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    event.stopPropagation()
    openActivityMenu(activity.id)
    return
  }
  if (event.key === 'F2') {
    event.preventDefault()
    beginRename(activity)
    return
  }
  if (
    event.altKey
    && event.shiftKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault()
    moveActivity(activity.id, event.key === 'ArrowUp' ? -1 : 1)
  }
}

function onMenuKeydown(event, kind, activityId = '') {
  const menu = event.currentTarget
  const items = [...menu.querySelectorAll(
    '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
  )]
  if (!items.length) return
  const current = Math.max(items.indexOf(document.activeElement), 0)
  let nextIndex = null
  if (event.key === 'ArrowDown') nextIndex = (current + 1) % items.length
  else if (event.key === 'ArrowUp') nextIndex = (current - 1 + items.length) % items.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = items.length - 1
  else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    activityMenuId.value = ''
    sortMenuOpen.value = false
    nextTick(() => {
      const selector = kind === 'sort'
        ? '[data-activity-sort-button]'
        : `[data-activity-menu-button="${activityId}"]`
      sidebarRoot.value?.querySelector(selector)?.focus()
    })
    return
  } else if (event.key === 'Tab') {
    activityMenuId.value = ''
    sortMenuOpen.value = false
    return
  } else {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  items[nextIndex]?.focus()
}

function focusFirstMenuItem(selector) {
  sidebarRoot.value
    ?.querySelector(selector)
    ?.querySelector('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')
    ?.focus()
}

function dropPosition(id) {
  if (dropIndicator.value?.beforeId === id) return 'before'
  if (dropIndicator.value?.afterId === id) return 'after'
  return undefined
}

function selectSort(mode) {
  sortMenuOpen.value = false
  emit('sortActivities', mode)
  nextTick(() => sidebarRoot.value?.querySelector('[data-activity-sort-button]')?.focus())
}

function sortLabel(mode) {
  return SORT_OPTIONS.find((option) => option.id === mode)?.label || 'Manual'
}
</script>

<style scoped>
.activity-menu-item {
  display: flex;
  width: 100%;
  height: 28px;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  text-align: left;
  font-size: 10px;
}

.activity-menu-item:hover,
.activity-menu-item:focus-visible {
  background: var(--color-chrome);
  outline: none;
}

.activity-menu-item:disabled {
  pointer-events: none;
  opacity: 0.45;
}

[data-drop-position='before']::before,
[data-drop-position='after']::after {
  position: absolute;
  right: 8px;
  left: 8px;
  z-index: 20;
  height: 2px;
  background: var(--color-accent);
  content: '';
}

[data-drop-position='before']::before {
  top: -1px;
}

[data-drop-position='after']::after {
  bottom: -1px;
}
</style>
