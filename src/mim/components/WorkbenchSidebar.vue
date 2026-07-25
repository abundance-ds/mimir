<template>
  <aside
    class="flex h-full min-h-0 flex-col overflow-hidden bg-chrome"
    :class="collapsed ? 'w-[52px]' : 'w-full'"
    :data-sidebar-state="collapsed ? 'rail' : 'expanded'"
  >
    <div
      class="drag-region flex h-11 shrink-0 items-center border-b border-rule"
      data-tauri-drag-region="deep"
    >
      <div class="w-3 shrink-0" aria-hidden="true" />
      <div class="grid size-7 shrink-0 place-items-center bg-ink font-mono text-[10px] font-semibold tracking-[-0.06em] text-chrome-high">
        MM
      </div>
      <div v-if="!collapsed" class="ml-2 min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-2">
        Mim
      </div>
    </div>

    <button
      type="button"
      data-sidebar-workspace
      :title="workspacePath || 'Choose workspace'"
      class="group flex h-11 shrink-0 items-center border-b border-rule text-left hover:bg-chrome-mid"
      @click="$emit('chooseWorkspace')"
    >
      <span class="ml-3 grid size-7 shrink-0 place-items-center text-ink-3 group-hover:text-ink">
        <IconFolder :size="16" :stroke-width="1.7" />
      </span>
      <span v-if="!collapsed" class="ml-2 min-w-0 flex-1 pr-2">
        <span class="block truncate text-[11px] font-semibold text-ink">
          {{ workspaceName || 'Open workspace' }}
        </span>
        <span class="block truncate font-mono text-[9px] text-ink-3">
          {{ workspacePath || 'Choose a folder' }}
        </span>
      </span>
    </button>

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
        <component
          :is="iconFor(launcher.icon)"
          :size="16"
          :stroke-width="1.7"
        />
      </SidebarRow>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div
        class="flex items-center justify-between px-3 pb-1 pt-1"
        :class="{ invisible: collapsed }"
        :aria-hidden="collapsed"
      >
        <span class="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">Activities</span>
        <span class="font-mono text-[9px] tabular-nums text-ink-4">{{ activities.length }}</span>
      </div>
      <SidebarRow
        v-for="activity in activities"
        :key="`activity:${activity.id}`"
        :data-sidebar-row="`activity:${activity.id}`"
        :title="activityTitle(activity)"
        :label="activity.title"
        :meta="activity.status"
        :collapsed="collapsed"
        :active="activeActivityId === activity.id"
        :copy-id="`activity:${activity.id}`"
        @click="$emit('selectActivity', activity.id)"
      >
        <span
          :data-sidebar-monogram="activity.id"
          class="relative grid size-7 place-items-center font-mono text-[10px] font-semibold"
        >
          {{ monogram(activity.title) }}
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
            aria-label="Activity actions"
            title="Activity actions"
            class="grid size-7 place-items-center text-ink-4 opacity-0 hover:bg-chrome-high hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click.stop="toggleActivityMenu(activity.id)"
          >
            <IconDots :size="14" :stroke-width="1.8" />
          </button>
          <div
            v-if="activityMenuId === activity.id"
            :data-activity-menu="activity.id"
            class="absolute right-1 top-8 z-50 w-36 border border-rule bg-surface py-1 shadow-lg"
            role="menu"
            @click.stop
          >
            <button class="activity-menu-item" role="menuitem" @click="beginRename(activity)">
              <IconPencil :size="12" /> Rename
            </button>
            <button
              v-if="isLive(activity.status)"
              class="activity-menu-item text-rem"
              role="menuitem"
              @click="runAction('stopActivity', activity.id)"
            >
              <IconPlayerStop :size="12" /> Stop
            </button>
            <button
              v-if="activity.retention === 'durable' && !isLive(activity.status)"
              class="activity-menu-item"
              role="menuitem"
              @click="runAction('archiveActivity', activity.id)"
            >
              <IconArchive :size="12" /> Archive
            </button>
            <button
              v-if="!isLive(activity.status)"
              class="activity-menu-item text-rem"
              role="menuitem"
              @click="runAction('clearActivity', activity.id)"
            >
              <IconTrash :size="12" /> Clear
            </button>
          </div>
        </template>
      </SidebarRow>

      <div v-if="activities.length === 0 && !collapsed" class="px-3 py-3 text-[10px] leading-relaxed text-ink-3">
        Runs stay here while you work.
      </div>

      <template v-if="archivedActivities.length">
        <div class="mx-3 my-2 h-px bg-rule" />
        <div
          class="flex items-center justify-between px-3 pb-1 pt-1"
          :class="{ invisible: collapsed }"
          :aria-hidden="collapsed"
        >
          <span class="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">Archived</span>
          <span class="font-mono text-[9px] tabular-nums text-ink-4">{{ archivedActivities.length }}</span>
        </div>
        <SidebarRow
          v-for="activity in archivedActivities"
          :key="`archived:${activity.id}`"
          :title="`${activity.title} — archived`"
          :label="activity.title"
          meta="archived"
          :collapsed="collapsed"
          muted
          @click="runAction('restoreActivity', activity.id)"
        >
          <span class="grid size-7 place-items-center font-mono text-[10px] font-semibold">
            {{ monogram(activity.title) }}
          </span>
          <template #trailing>
            <button
              type="button"
              title="Restore Activity"
              aria-label="Restore Activity"
              class="grid size-7 place-items-center text-ink-4 opacity-0 hover:bg-chrome-high hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              @click.stop="runAction('restoreActivity', activity.id)"
            >
              <IconArchiveOff :size="13" />
            </button>
          </template>
        </SidebarRow>
      </template>
    </nav>

    <button
      type="button"
      data-sidebar-collapse
      :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      class="flex h-10 shrink-0 items-center border-t border-rule text-ink-3 hover:bg-chrome-mid hover:text-ink"
      @click="$emit('toggleCollapse')"
    >
      <span class="ml-3 grid size-7 shrink-0 place-items-center">
        <IconLayoutSidebarLeftExpand v-if="collapsed" :size="16" :stroke-width="1.7" />
        <IconLayoutSidebarLeftCollapse v-else :size="16" :stroke-width="1.7" />
      </span>
      <span v-if="!collapsed" class="ml-2 text-[10px]">Collapse</span>
    </button>
  </aside>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  IconArchive,
  IconArchiveOff,
  IconApps,
  IconDots,
  IconFileStack,
  IconFolder,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconRobot,
  IconTerminal2,
  IconClockPlay,
  IconSparkles,
  IconPencil,
  IconPlayerStop,
  IconTrash,
} from '@tabler/icons-vue'
import SidebarRow from './SidebarRow.vue'

defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  launchers: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  archivedActivities: { type: Array, default: () => [] },
  activeActivityId: { type: String, default: '' },
})

const emit = defineEmits([
  'launch',
  'selectActivity',
  'chooseWorkspace',
  'toggleCollapse',
  'renameActivity',
  'stopActivity',
  'archiveActivity',
  'restoreActivity',
  'clearActivity',
])
const activityMenuId = ref('')
const renamingId = ref('')
const renameDraft = ref('')
const LIVE_STATUSES = new Set(['ready', 'starting', 'working', 'needs-input', 'idle'])

onMounted(() => document.addEventListener('pointerdown', closeActivityMenu))
onUnmounted(() => document.removeEventListener('pointerdown', closeActivityMenu))

const icons = {
  files: IconFileStack,
  agent: IconRobot,
  terminal: IconTerminal2,
  apps: IconApps,
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

function monogram(title) {
  const words = String(title || '')
    .trim()
    .split(/[\s/_.:-]+/)
    .filter(Boolean)
  if (!words.length) return '—'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

function activityTitle(activity) {
  return `${activity.title} — ${String(activity.status).replace('-', ' ')}`
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

function isLive(status) {
  return LIVE_STATUSES.has(status)
}

function toggleActivityMenu(id) {
  activityMenuId.value = activityMenuId.value === id ? '' : id
}

function closeActivityMenu() {
  activityMenuId.value = ''
}

async function beginRename(activity) {
  closeActivityMenu()
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
  closeActivityMenu()
  emit(event, id)
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
</style>
