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

    <nav class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1" aria-label="Tools, new activities, and activity history">
      <div
        class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3"
        :class="{ invisible: collapsed }"
        :aria-hidden="collapsed"
      >
        Tools
      </div>
      <SidebarRow
        v-for="tool in tools"
        :key="`tool:${tool.id}`"
        :data-sidebar-row="`tool:${tool.id}`"
        :data-tool-key="tool.id"
        :data-drop-position="toolDropPosition(tool.id)"
        :data-launcher-available="tool.available === false ? 'false' : 'true'"
        :aria-disabled="tool.available === false ? 'true' : undefined"
        :title="launcherTitle(tool)"
        :label="tool.title"
        :meta="tool.available === false ? 'missing' : tool.shortcut"
        :collapsed="collapsed"
        :active="toolIsActive(tool)"
        :muted="tool.available === false"
        @pointerdown="onToolPointerDown($event, tool.id)"
        @keydown="onToolKeydown($event, tool)"
        @click="openTool(tool.id)"
      >
        <span :data-launcher-identity="tool.icon" class="grid size-7 place-items-center">
          <component
            :is="iconFor(tool.icon)"
            :size="16"
            :stroke-width="1.7"
            :monochrome="true"
          />
        </span>
      </SidebarRow>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div data-sidebar-new-activity-header class="flex h-7 items-center px-3">
        <template v-if="!collapsed">
          <button
            type="button"
            data-sidebar-new-activity-toggle
            :aria-expanded="!newActivityCollapsed"
            title="Toggle New activity"
            class="flex h-6 min-w-0 flex-1 items-center gap-1 text-left font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="newActivityCollapsed = !newActivityCollapsed"
            @keydown.right.prevent="newActivityCollapsed = false"
            @keydown.left.prevent="newActivityCollapsed = true"
          >
            <IconChevronRight v-if="newActivityCollapsed" :size="12" :stroke-width="2" />
            <IconChevronDown v-else :size="12" :stroke-width="2" />
            <span>New activity</span>
          </button>
        </template>
        <span v-else class="h-px w-7 bg-rule-light" aria-hidden="true" />
      </div>
      <template v-if="collapsed || !newActivityCollapsed">
        <SidebarRow
          v-for="launcher in newActivity"
          :key="`launcher:${launcher.id}`"
          :data-sidebar-row="`launcher:${launcher.id}`"
          :data-new-activity-key="launcher.id"
          :data-drop-position="launcherDropPosition(launcher.id)"
          :data-launcher-available="launcher.available === false ? 'false' : 'true'"
          :aria-disabled="launcher.available === false ? 'true' : undefined"
          :title="launcherTitle(launcher)"
          :label="launcher.title"
          :meta="launcher.available === false ? 'missing' : launcher.shortcut"
          :collapsed="collapsed"
          :active="false"
          :muted="launcher.available === false"
          @pointerdown="onLauncherPointerDown($event, launcher.id)"
          @keydown="onLauncherKeydown($event, launcher)"
          @click="launchNewActivity(launcher.id)"
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
      </template>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div
        class="relative flex h-7 items-center px-3"
      >
        <template v-if="!collapsed">
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
        <button
          ref="activityCreateButtonRef"
          type="button"
          data-activity-create-button
          data-no-reorder
          :aria-expanded="activityCreateMenuOpen"
          aria-haspopup="menu"
          aria-label="New Activity"
          title="New Activity"
          class="grid place-items-center text-ink-3 hover:bg-chrome-high hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
          :class="collapsed ? 'size-7' : 'size-6'"
          :disabled="!activityCreateOptions.length"
          @pointerdown.stop
          @click.stop="toggleActivityCreateMenu"
          @keydown.down.stop.prevent="openActivityCreateMenu"
        >
          <IconPlus :size="13" :stroke-width="1.8" />
        </button>
      </div>

      <Teleport to="body">
        <div
          v-if="activityCreateMenuOpen"
          ref="activityCreateMenuRef"
          data-activity-create-menu
          role="menu"
          aria-label="New Activity"
          class="fixed z-[220] max-h-[min(360px,calc(100vh-16px))] w-52 overflow-y-auto border border-rule bg-surface p-1 shadow-lg"
          :style="activityCreateMenuStyle"
          @pointerdown.stop
          @click.stop
          @keydown="onActivityCreateMenuKeydown"
        >
          <template v-for="(option, index) in activityCreateOptions" :key="option.id">
            <div
              v-if="index === activityCreateAppStart"
              data-activity-create-divider
              class="my-1 border-t border-rule-light"
              role="separator"
            />
            <button
              type="button"
              data-activity-create-option
              :data-activity-create-id="option.id"
              role="menuitem"
              class="activity-create-item"
              @click="launchActivityOption(option.id)"
            >
              <span class="grid size-5 shrink-0 place-items-center text-ink-3">
                <component
                  :is="iconFor(option.icon)"
                  :size="14"
                  :stroke-width="1.8"
                  :monochrome="true"
                />
              </span>
              <span class="min-w-0 flex-1 truncate">{{ option.title }}</span>
            </button>
          </template>
        </div>
      </Teleport>

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
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconArrowDown,
  IconArrowUp,
  IconArchive,
  IconApps,
  IconArrowsSort,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFileStack,
  IconFocus2,
  IconLayoutSidebarLeftCollapse,
  IconMathPi,
  IconPlus,
  IconSettings,
  IconRobot,
  IconTerminal2,
  IconTopologyStar3,
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
import IconProviderGoogle from '../../shared/icons/IconProviderGoogle.vue'
import IconProviderOpenAI from '../../shared/icons/IconProviderOpenAI.vue'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  recentWorkspaces: { type: Array, default: () => [] },
  tools: { type: Array, default: () => [] },
  newActivity: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
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
  'clearActivity',
  'reorderTools',
  'reorderLaunchers',
  'reorderActivities',
  'sortActivities',
  'settings',
])
const activityMenuId = ref('')
const sortMenuOpen = ref(false)
const newActivityCollapsed = ref(false)
const activitiesCollapsed = ref(false)
const renamingId = ref('')
const renameDraft = ref('')
const sidebarRoot = ref(null)
const activityCreateButtonRef = ref(null)
const activityCreateMenuRef = ref(null)
const activityCreateMenuOpen = ref(false)
const activityCreateMenuStyle = ref({})
const LIVE_STATUSES = new Set(['ready', 'starting', 'working', 'needs-input', 'idle'])
const SORT_OPTIONS = Object.freeze([
  { id: 'manual', label: 'Manual' },
  { id: 'recent', label: 'Most recent' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'name', label: 'Name' },
])
const activityCreateOptions = computed(() => {
  const available = props.newActivity.filter(
    option => option?.id && option.available !== false,
  )
  return [
    ...available.filter(option => !String(option.id).startsWith('app:')),
    ...available.filter(option => String(option.id).startsWith('app:')),
  ]
})
const activityCreateAppStart = computed(() => {
  const index = activityCreateOptions.value.findIndex(
    option => String(option.id).startsWith('app:'),
  )
  return index > 0 ? index : -1
})

onMounted(() => document.addEventListener('pointerdown', closeMenus))
onUnmounted(() => {
  document.removeEventListener('pointerdown', closeMenus)
  closeActivityCreateMenu()
})

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

const {
  dropIndicator: toolDropIndicator,
  suppressClick: suppressToolClick,
  onPointerDown: onToolPointerDown,
} = usePointerReorder({
  root: sidebarRoot,
  rowSelector: '[data-tool-key]',
  keyAttribute: 'data-tool-key',
  keys: () => props.tools.map((tool) => tool.id),
  onReorder: (ids) => emit('reorderTools', ids),
})

const {
  dropIndicator: launcherDropIndicator,
  suppressClick: suppressLauncherClick,
  onPointerDown: onLauncherPointerDown,
} = usePointerReorder({
  root: sidebarRoot,
  rowSelector: '[data-new-activity-key]',
  keyAttribute: 'data-new-activity-key',
  keys: () => props.newActivity.map((launcher) => launcher.id),
  onReorder: (ids) => emit('reorderLaunchers', ids),
})

const icons = {
  files: IconFileStack,
  agent: IconRobot,
  codex: IconProviderOpenAI,
  claude: IconProviderAnthropic,
  pi: IconMathPi,
  gemini: IconProviderGoogle,
  terminal: IconTerminal2,
  apps: IconApps,
  today: IconFocus2,
  graph: IconTopologyStar3,
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

function openTool(id) {
  if (!suppressToolClick.value) emit('launch', id)
}

function toolIsActive(tool) {
  return props.activeActivityId === (tool.activityId || tool.id)
}

function launchNewActivity(id) {
  if (!suppressLauncherClick.value) emit('launch', id)
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
  closeActivityCreateMenu()
  sortMenuOpen.value = false
  activityMenuId.value = activityMenuId.value === id ? '' : id
  if (activityMenuId.value) {
    await nextTick()
    focusFirstMenuItem(`[data-activity-menu="${id}"]`)
  }
}

async function openActivityMenu(id) {
  closeActivityCreateMenu()
  sortMenuOpen.value = false
  activityMenuId.value = id
  await nextTick()
  focusFirstMenuItem(`[data-activity-menu="${id}"]`)
}

async function toggleSortMenu() {
  closeActivityCreateMenu()
  activityMenuId.value = ''
  sortMenuOpen.value = !sortMenuOpen.value
  if (sortMenuOpen.value) {
    await nextTick()
    focusFirstMenuItem('[data-activity-sort-menu]')
  }
}

async function openSortMenu() {
  closeActivityCreateMenu()
  activityMenuId.value = ''
  sortMenuOpen.value = true
  await nextTick()
  focusFirstMenuItem('[data-activity-sort-menu]')
}

function closeMenus(event) {
  if (event?.target?.closest?.(
    '[data-activity-menu], [data-activity-menu-button], [data-activity-sort-menu], [data-activity-sort-button], [data-activity-create-menu], [data-activity-create-button]',
  )) return
  activityMenuId.value = ''
  sortMenuOpen.value = false
  closeActivityCreateMenu()
}

async function toggleActivityCreateMenu() {
  if (activityCreateMenuOpen.value) {
    closeActivityCreateMenu()
    return
  }
  await openActivityCreateMenu()
}

async function openActivityCreateMenu() {
  activityMenuId.value = ''
  sortMenuOpen.value = false
  if (!activityCreateOptions.value.length) return
  if (!activityCreateMenuOpen.value) {
    activityCreateMenuOpen.value = true
    window.addEventListener('resize', positionActivityCreateMenu)
    window.addEventListener('scroll', positionActivityCreateMenu, true)
  }
  await nextTick()
  positionActivityCreateMenu()
  activityCreateItems()[0]?.focus()
}

function closeActivityCreateMenu() {
  activityCreateMenuOpen.value = false
  window.removeEventListener('resize', positionActivityCreateMenu)
  window.removeEventListener('scroll', positionActivityCreateMenu, true)
}

function positionActivityCreateMenu() {
  const trigger = activityCreateButtonRef.value
  const menu = activityCreateMenuRef.value
  if (!trigger || !menu) return
  const rect = trigger.getBoundingClientRect()
  const width = 208
  const margin = 8
  const left = Math.max(
    margin,
    Math.min(rect.right - width, window.innerWidth - width - margin),
  )
  const below = rect.bottom + 4
  const menuHeight = menu.offsetHeight
  const top = below + menuHeight <= window.innerHeight - margin
    ? below
    : Math.max(margin, rect.top - menuHeight - 4)
  activityCreateMenuStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
  }
}

function activityCreateItems() {
  return Array.from(
    activityCreateMenuRef.value?.querySelectorAll('[data-activity-create-option]') || [],
  )
}

function launchActivityOption(id) {
  closeActivityCreateMenu()
  emit('launch', id)
  nextTick(() => activityCreateButtonRef.value?.focus())
}

function onActivityCreateMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeActivityCreateMenu()
    nextTick(() => activityCreateButtonRef.value?.focus())
    return
  }
  if (event.key === 'Tab') {
    closeActivityCreateMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const items = activityCreateItems()
  if (!items.length) return
  let index = items.indexOf(document.activeElement)
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = items.length - 1
  else {
    const direction = event.key === 'ArrowDown' ? 1 : -1
    index = (Math.max(index, 0) + direction + items.length) % items.length
  }
  items[index]?.focus()
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
  if (source.includes('gemini')) return 'Gemini'
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
    Gemini: IconProviderGoogle,
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

function moveTool(id, direction) {
  emit('reorderTools', moveActivityId(
    props.tools.map((tool) => tool.id),
    id,
    direction,
  ))
}

function onToolKeydown(event, tool) {
  if (navigateSidebarRows(event)) return
  if (
    event.altKey
    && event.shiftKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault()
    moveTool(tool.id, event.key === 'ArrowUp' ? -1 : 1)
  }
}

function moveLauncher(id, direction) {
  emit('reorderLaunchers', moveActivityId(
    props.newActivity.map((launcher) => launcher.id),
    id,
    direction,
  ))
}

function onLauncherKeydown(event, launcher) {
  if (navigateSidebarRows(event)) return
  if (
    event.altKey
    && event.shiftKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    event.preventDefault()
    moveLauncher(launcher.id, event.key === 'ArrowUp' ? -1 : 1)
  }
}

function onActivityKeydown(event, activity) {
  if (event.target?.tagName === 'INPUT') return
  if (navigateSidebarRows(event)) return
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

function navigateSidebarRows(event) {
  if (
    event.metaKey
    || event.ctrlKey
    || event.altKey
    || event.shiftKey
    || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
  ) return false
  const currentRow = event.target?.closest?.('[data-sidebar-row]')
  if (!currentRow) return false
  const rows = [...(sidebarRoot.value?.querySelectorAll('[data-sidebar-row]') || [])]
  const index = rows.indexOf(currentRow)
  if (index < 0 || !rows.length) return false
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? rows.length - 1
      : Math.min(
          Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0),
          rows.length - 1,
        )
  event.preventDefault()
  event.stopPropagation()
  rows[nextIndex]?.querySelector('button')?.focus()
  return true
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

function toolDropPosition(id) {
  if (toolDropIndicator.value?.beforeId === id) return 'before'
  if (toolDropIndicator.value?.afterId === id) return 'after'
  return undefined
}

function launcherDropPosition(id) {
  if (launcherDropIndicator.value?.beforeId === id) return 'before'
  if (launcherDropIndicator.value?.afterId === id) return 'after'
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

.activity-create-item {
  display: flex;
  width: 100%;
  min-height: 30px;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  text-align: left;
  font-size: 11px;
  color: var(--color-ink-2);
}

.activity-create-item:hover,
.activity-create-item:focus-visible {
  background: var(--color-chrome-high);
  color: var(--color-ink);
  outline: none;
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
