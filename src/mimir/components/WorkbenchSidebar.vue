<template>
  <aside
    class="flex h-full min-h-0 flex-col overflow-hidden bg-chrome"
    :class="collapsed ? 'w-[52px]' : 'w-full'"
    :data-sidebar-state="collapsed ? 'rail' : 'expanded'"
  >
    <PaneBand as="div" kind="header"
      data-sidebar-header
      class="drag-region justify-end px-2"
      data-tauri-drag-region="deep"
    >
      <button
        v-if="!collapsed"
        type="button"
        data-sidebar-collapse
        aria-label="Collapse sidebar"
        title="Collapse sidebar"
        class="pane-icon-button no-drag"
        @click="$emit('toggleCollapse')"
      >
        <IconLayoutSidebarLeftCollapse :size="15" :stroke-width="1.8" />
      </button>
    </PaneBand>
    <WorkspaceSwitcher
      :collapsed="collapsed"
      :workspace-name="workspaceName"
      :workspace-path="workspacePath"
      :workspace-missing="workspaceMissing"
      :recent-workspaces="recentWorkspaces"
      @choose-workspace="$emit('chooseWorkspace')"
      @create-workspace="$emit('createWorkspace')"
      @dismiss-missing-workspaces="$emit('dismissMissingWorkspaces', $event)"
      @open-workspace="$emit('openWorkspace', $event)"
      @reconcile-workspaces="$emit('reconcileWorkspaces')"
    />
    <button
      type="button"
      data-tools-disclosure
      class="flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] text-ink-3 hover:bg-chrome-mid"
      :class="{ 'invisible pointer-events-none': collapsed }"
      :aria-hidden="collapsed"
      :tabindex="collapsed ? -1 : undefined"
      :aria-expanded="!toolsCollapsed"
      @click="$emit('toggleTools')"
    >
      <IconChevronRight v-if="toolsCollapsed" :size="12" /><IconChevronDown
        v-else
        :size="12"
      />Tools
    </button>
    <nav
      v-show="!toolsCollapsed"
      ref="toolRoot"
      aria-label="Tools"
      class="max-h-[30%] shrink-0 overflow-x-hidden overflow-y-auto"
    >
      <SidebarRow
        v-for="tool in tools"
        :key="tool.id"
        :data-tool-key="tool.id"
        :class="{
          'tool-drop-before': reorder.dropIndicator.value?.beforeId === tool.id,
          'tool-drop-after': reorder.dropIndicator.value?.afterId === tool.id,
        }"
        :data-sidebar-row="`tool:${tool.id}`"
        :label="tool.title"
        :title="tool.title"
        :collapsed="collapsed"
        :active="activeToolId === tool.id"
        @pointerdown="reorder.onPointerDown($event, tool.id)"
        @keydown="moveTool($event, tool.id)"
        @click="launch(tool.id)"
        ><component
          :is="iconFor(tool.icon)"
          :size="16"
          :stroke-width="1.7"
          :monochrome="true"
      /></SidebarRow>
    </nav>
    <div
      v-if="meetingCapture"
      data-sidebar-meeting-capture
      class="shrink-0 border-y border-rule text-[11px]"
      role="group"
      aria-label="Meeting recording controls"
    >
      <button
        type="button"
        class="sidebar-recording-control"
        title="Open recording"
        aria-label="Open recording"
        @click="$emit('openMeeting')"
      >
        <span class="sidebar-recording-icon"><IconPlayerRecordFilled :size="12" class="text-rem" /></span>
        <span :class="{ invisible: collapsed }" :aria-hidden="collapsed" class="truncate pr-2">
          {{ meetingCapture.lifecycle === 'capturing' ? 'Recording' : 'Finalizing' }}
        </span>
      </button>
      <button
        type="button"
        data-sidebar-meeting-microphone
        class="sidebar-recording-control"
        :title="meetingCapture.micMuted ? 'Unmute microphone' : 'Mute microphone'"
        :aria-label="meetingCapture.micMuted ? 'Unmute microphone' : 'Mute microphone'"
        @click="$emit('setMeetingMicMuted', !meetingCapture.micMuted)"
      >
        <span class="sidebar-recording-icon">
          <IconMicrophoneOff v-if="meetingCapture.micMuted" :size="14" /><IconMicrophone v-else :size="14" />
        </span>
        <span :class="{ invisible: collapsed }" :aria-hidden="collapsed" class="truncate pr-2">
          {{ meetingCapture.micMuted ? 'Unmute microphone' : 'Mute microphone' }}
        </span>
      </button>
      <button
        type="button"
        class="sidebar-recording-control"
        title="Stop recording"
        aria-label="Stop recording"
        @click="$emit('stopMeeting')"
      >
        <span class="sidebar-recording-icon"><IconPlayerStopFilled :size="12" /></span>
        <span :class="{ invisible: collapsed }" :aria-hidden="collapsed" class="truncate pr-2">Stop recording</span>
      </button>
    </div>
    <div
      data-sidebar-files
      class="min-h-0 min-w-0 flex-1 overflow-hidden border-t border-rule-light"
    >
      <button
        v-if="collapsed"
        type="button"
        data-sidebar-files-restore
        class="flex h-[32px] w-full items-center px-[12px] text-ink-3 hover:bg-chrome-mid hover:text-ink"
        aria-label="Open Files"
        title="Files"
        @click="$emit('toggleCollapse')"
      >
        <span class="grid size-[28px] shrink-0 place-items-center">
          <IconFolderOpen :size="14" :stroke-width="1.75" />
        </span>
      </button>
      <div v-show="!collapsed" class="h-full min-h-0 min-w-0">
        <slot name="files" />
      </div>
    </div>
    <PaneBand as="footer" kind="footer"
      data-sidebar-footer
      class="!px-0"
    >
      <button
        type="button"
        data-sidebar-settings
        title="Settings"
        aria-label="Settings"
        class="group flex h-full w-full items-center px-[12px] text-left font-sans text-[12px] text-ink-2 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('settings')"
      >
        <span class="grid h-[24px] w-[28px] shrink-0 place-items-center text-ink-3 group-hover:text-ink">
          <IconSettings :size="16" :stroke-width="1.8" />
        </span>
        <span v-if="!collapsed" class="ml-1 min-w-0 flex-1 truncate pr-2">Settings</span>
      </button>
    </PaneBand>
  </aside>
</template>
<script setup>
import PaneBand from '../../shared/ui/chrome/PaneBand.vue'

import { ref } from 'vue'
import {
  IconChevronDown,
  IconChevronRight,
  IconFolderOpen,
  IconLayoutSidebarLeftCollapse,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlayerRecordFilled,
  IconPlayerStopFilled,
  IconSettings,
} from '@tabler/icons-vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import SidebarRow from './SidebarRow.vue'
import { iconFor } from '../activityIcons.js'
import { usePointerReorder } from '../composables/usePointerReorder.js'
const props = defineProps({
  collapsed: Boolean,
  toolsCollapsed: Boolean,
  workspaceName: { type: String, default: '' },
  workspacePath: { type: String, default: '' },
  workspaceMissing: Boolean,
  recentWorkspaces: { type: Array, default: () => [] },
  tools: { type: Array, default: () => [] },
  activeToolId: { type: String, default: '' },
  meetingCapture: { type: Object, default: null },
})
const emit = defineEmits([
  'toggleCollapse',
  'toggleTools',
  'chooseWorkspace',
  'createWorkspace',
  'dismissMissingWorkspaces',
  'openWorkspace',
  'reconcileWorkspaces',
  'launch',
  'reorderTools',
  'settings',
  'openMeeting',
  'setMeetingMicMuted',
  'stopMeeting',
])
const toolRoot = ref(null)
const reorder = usePointerReorder({
  root: toolRoot,
  rowSelector: '[data-tool-key]',
  keyAttribute: 'data-tool-key',
  keys: () => props.tools.map((t) => t.id),
  onReorder: (ids) => emit('reorderTools', ids),
})
function moveTool(event, id) {
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const rows = [...(toolRoot.value?.querySelectorAll('[data-tool-key]') || [])]
    const index = rows.findIndex(row => row.dataset.toolKey === id)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    event.stopPropagation()
    rows[next]?.querySelector('button')?.focus()
    return
  }
  if (
    !event.altKey ||
    !event.shiftKey ||
    !['ArrowUp', 'ArrowDown'].includes(event.key)
  )
    return
  event.preventDefault()
  const ids = props.tools.map((t) => t.id),
    from = ids.indexOf(id),
    to = from + (event.key === 'ArrowDown' ? 1 : -1)
  if (to >= 0 && to < ids.length) {
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    emit('reorderTools', ids)
  }
}
function launch(id) {
  if (!reorder.suppressClick.value) emit('launch', id)
}
</script>
<style scoped>
.tool-drop-before::before,
.tool-drop-after::after {
  content: '';
  position: absolute;
  pointer-events: none;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--color-accent);
}
.tool-drop-before::before { top: 0; }
.tool-drop-after::after { bottom: 0; }
.sidebar-recording-control {
  display: flex;
  width: 100%;
  height: 28px;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-align: left;
  color: var(--color-ink-3);
}
.sidebar-recording-icon {
  display: grid;
  width: 28px;
  height: 28px;
  margin-left: 12px;
  flex: 0 0 auto;
  place-items: center;
}
.sidebar-recording-control:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
