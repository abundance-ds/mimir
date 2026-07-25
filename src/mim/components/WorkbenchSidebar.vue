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
      <div v-if="!collapsed" class="px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-3">
        Launch
      </div>
      <SidebarRow
        v-for="launcher in launchers"
        :key="`launcher:${launcher.id}`"
        :data-sidebar-row="`launcher:${launcher.id}`"
        :title="launcher.title"
        :label="launcher.title"
        :meta="launcher.shortcut"
        :collapsed="collapsed"
        :active="false"
        @click="$emit('launch', launcher.id)"
      >
        <component
          :is="iconFor(launcher.icon)"
          :size="16"
          :stroke-width="1.7"
        />
      </SidebarRow>

      <div class="mx-3 my-2 h-px bg-rule" />

      <div v-if="!collapsed" class="flex items-center justify-between px-3 pb-1 pt-1">
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
      </SidebarRow>

      <div v-if="activities.length === 0 && !collapsed" class="px-3 py-3 text-[10px] leading-relaxed text-ink-3">
        Runs stay here while you work.
      </div>
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
import {
  IconApps,
  IconFileStack,
  IconFolder,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconRobot,
  IconTerminal2,
  IconClockPlay,
  IconSparkles,
} from '@tabler/icons-vue'
import SidebarRow from './SidebarRow.vue'

defineProps({
  collapsed: { type: Boolean, default: false },
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  launchers: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  activeActivityId: { type: String, default: '' },
})

defineEmits(['launch', 'selectActivity', 'chooseWorkspace', 'toggleCollapse'])

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
</script>
