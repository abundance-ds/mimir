<template>
  <aside
    ref="sidebar"
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
    <div ref="body" class="sidebar-body flex min-h-0 flex-1 flex-col" :class="{ 'sidebar-resizing': filesSize.resizing.value }">
    <div class="sidebar-navigation flex min-h-0 flex-1 flex-col" data-sidebar-navigation>
      <div data-tools-heading class="flex h-[28px] shrink-0 items-center bg-chrome text-[11px] text-ink-3">
        <button v-if="collapsed" type="button" data-sidebar-restore class="flex h-full w-full items-center px-[12px] hover:bg-chrome-mid"
          aria-label="Expand sidebar" title="Expand sidebar" @click="restoreSidebar">
          <span class="grid size-[28px] shrink-0 place-items-center"><IconLayoutSidebarLeftExpand :size="15" :stroke-width="1.8" /></span>
        </button>
        <span v-else class="px-3">Tools</span>
      </div>
      <div ref="navigationScroll" data-sidebar-navigation-scroll class="sidebar-navigation-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <nav
        ref="toolRoot"
        aria-label="Tools"
        class="shrink-0"
      >
        <template v-for="tool in tools" :key="tool.id">
          <SidebarRow
            compact
            :data-tool-key="tool.id"
            :class="{
              'tool-drop-before': reorder.dropIndicator.value?.beforeId === tool.id,
              'tool-drop-after': reorder.dropIndicator.value?.afterId === tool.id,
            }"
            :data-sidebar-row="`tool:${tool.id}`"
            :label="tool.title"
            :title="collapsed && meetingCapture && tool.id === 'app:scribe' ? `${tool.title} · ${meetingCaptureLabel}` : tool.title"
            :aria-label="collapsed && meetingCapture && tool.id === 'app:scribe' ? `${tool.title}, ${meetingCaptureLabel}` : ''"
            :collapsed="collapsed"
            :active="activeToolId === tool.id"
            @pointerdown="reorder.onPointerDown($event, tool.id)"
            @keydown="moveTool($event, tool.id)"
            @click="launch(tool.id)"
          >
            <span class="sidebar-tool-icon">
              <component
                :is="iconFor(tool.icon)"
                data-sidebar-tool-icon
                :size="16"
                :stroke-width="1.7"
                :monochrome="true"
              />
              <span
                v-if="collapsed && meetingCapture && tool.id === 'app:scribe'"
                data-sidebar-recording-badge
                class="sidebar-recording-badge"
                aria-hidden="true"
              >
                <IconPlayerRecordFilled v-if="meetingRecording && !meetingCapture.stopPending" :size="6" class="text-rem" />
                <IconLoader2 v-else :size="10" class="motion-safe:animate-spin" />
              </span>
            </span>
          </SidebarRow>
          <div
            v-if="meetingCapture && tool.id === 'app:scribe'"
            data-sidebar-meeting-capture
            class="sidebar-recording"
            role="group"
            aria-label="Meeting recording controls"
          >
            <button
              type="button"
              data-sidebar-meeting-open
              class="sidebar-recording-open"
              :title="`${meetingCapture.title || 'Meeting'} · ${meetingCaptureLabel} ${meetingElapsed}`"
              :aria-label="`Open recording: ${meetingCaptureLabel}, ${meetingElapsed}`"
              @click="$emit('openMeeting')"
            >
              <span v-if="!collapsed" class="sidebar-recording-icon" aria-hidden="true">
                <IconPlayerRecordFilled v-if="meetingRecording && !meetingCapture.stopPending" :size="10" class="text-rem" />
                <IconLoader2 v-else :size="12" class="motion-safe:animate-spin" />
              </span>
              <span class="sidebar-recording-label" :class="{ 'sr-only': collapsed }" role="status">{{ meetingCaptureLabel }}</span>
              <span data-sidebar-meeting-elapsed class="sidebar-recording-time">{{ meetingElapsed }}</span>
            </button>
            <div class="sidebar-recording-actions">
              <button
                type="button"
                data-sidebar-meeting-microphone
                class="sidebar-recording-action"
                :class="{ 'is-muted': meetingCapture.micMuted }"
                :title="meetingCapture.micMuted ? 'Unmute microphone' : 'Mute microphone'"
                :aria-label="meetingCapture.micMuted ? 'Unmute microphone' : 'Mute microphone'"
                :aria-pressed="meetingCapture.micMuted"
                :disabled="!meetingRecording || meetingCapture.micPending || meetingCapture.stopPending"
                @click="$emit('setMeetingMicMuted', !meetingCapture.micMuted)"
              >
                <IconMicrophoneOff v-if="meetingCapture.micMuted" :size="14" aria-hidden="true" /><IconMicrophone v-else :size="14" aria-hidden="true" />
              </button>
              <button
                type="button"
                data-sidebar-meeting-stop
                class="sidebar-recording-action"
                title="Stop recording"
                aria-label="Stop recording"
                :disabled="!meetingRecording || meetingCapture.stopPending"
                @click="$emit('stopMeeting')"
              >
                <IconPlayerStopFilled :size="12" class="text-rem" aria-hidden="true" />
              </button>
            </div>
          </div>
        </template>
      </nav>
      <SidebarActivities
        :tabs="activities"
        :active-id="activeActivityId"
        :blocking-ids="blockingIds"
        :restoring-ids="restoringIds"
        :rail="collapsed"
        @select="$emit('selectActivity', $event)"
        @close="$emit('closeActivity', $event)"
        @rename="$emit('renameActivity', $event)"
        @reorder="$emit('reorderActivities', $event)"
        @new="$emit('newActivity')"
      />
      </div>
    </div>
    <div data-sidebar-files class="sidebar-files-dock relative flex shrink-0 flex-col overflow-visible border-t border-rule"
      :style="{ height: `${filesHidden ? 28 : filesSize.height.value + 28}px` }">
      <div v-if="!filesCollapsed && !filesHidden" data-sidebar-files-resize role="separator" tabindex="0"
        aria-label="Resize Files" aria-orientation="horizontal"
        :aria-valuemin="filesSize.minimum.value" :aria-valuemax="filesSize.maximum.value" :aria-valuenow="filesSize.height.value"
        class="sidebar-files-resize" @pointerdown="filesSize.start" @keydown="filesSize.keydown" />
      <div v-show="!filesHidden" data-sidebar-files-content class="min-h-0 min-w-0 flex-1 overflow-hidden"
        :inert="filesHidden || filesSize.opening.value || undefined">
        <slot name="files" :collapse="collapseFiles" />
      </div>
      <button v-if="filesHidden" type="button" data-sidebar-files-toggle :data-sidebar-files-restore="collapsed ? '' : undefined"
        class="flex h-[28px] w-full shrink-0 items-center overflow-hidden text-left text-[12px] text-ink-2 hover:bg-chrome-mid"
        :class="{ 'cursor-ns-resize touch-none': !collapsed }"
        aria-label="Expand Files" :aria-expanded="false" :title="collapsed ? 'Expand Files' : 'Expand Files · drag up to resize'"
        @pointerdown="filesSize.startCollapsed" @click="toggleFiles">
        <span class="ml-[12px] grid size-[28px] shrink-0 place-items-center"><IconFolderOpen :size="14" :stroke-width="1.75" /></span>
        <span :class="{ invisible: collapsed }" :aria-hidden="collapsed" class="ml-2 min-w-0 flex-1 truncate">Files</span>
        <span v-if="!collapsed" class="mr-3 grid size-[28px] shrink-0 place-items-center"><IconChevronUp :size="14" :stroke-width="1.75" /></span>
      </button>
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

import { computed, nextTick, ref, watch } from 'vue'
import {
  IconChevronUp,
  IconFolderOpen,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlayerRecordFilled,
  IconPlayerStopFilled,
  IconSettings,
} from '@tabler/icons-vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import SidebarRow from './SidebarRow.vue'
import SidebarActivities from './SidebarActivities.vue'
import { iconFor } from '../activityIcons.js'
import { usePointerReorder } from '../composables/usePointerReorder.js'
import { useSidebarFilesSize, DEFAULT_SIDEBAR_FILES_HEIGHT } from '../composables/useSidebarFilesSize.js'
const props = defineProps({
  collapsed: Boolean,
  filesCollapsed: Boolean,
  filesHeight: { type: Number, default: DEFAULT_SIDEBAR_FILES_HEIGHT },
  activities: { type: Array, default: () => [] },
  activeActivityId: { type: String, default: '' },
  blockingIds: { type: Set, default: () => new Set() },
  restoringIds: { type: Set, default: () => new Set() },
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
  'toggleFiles',
  'resizeFiles',
  'selectActivity',
  'closeActivity',
  'renameActivity',
  'reorderActivities',
  'newActivity',
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
const sidebar = ref(null)
const body = ref(null)
const navigationScroll = ref(null)
const meetingNow = ref(Date.now())
const meetingRecording = computed(() => props.meetingCapture?.lifecycle === 'capturing')
const meetingCaptureLabel = computed(() => (
  props.meetingCapture?.stopPending || props.meetingCapture?.lifecycle === 'stopping'
    ? 'Stopping…'
    : meetingRecording.value ? 'Recording' : 'Finalizing'
))
const meetingElapsed = computed(() => {
  const meeting = props.meetingCapture
  const runStartedAt = Date.parse(meeting?.recordingStartedAt || meeting?.startedAt || '')
  const currentRunMs = meetingRecording.value && Number.isFinite(runStartedAt)
    ? Math.max(0, meetingNow.value - runStartedAt)
    : 0
  const seconds = Math.floor(Math.max(0, (Number(meeting?.durationMs) || 0) + currentRunMs) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const remainder = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`
})
watch([() => props.meetingCapture?.id, meetingRecording], ([, recording], _previous, onCleanup) => {
  meetingNow.value = Date.now()
  if (!recording) return
  const timer = window.setInterval(() => { meetingNow.value = Date.now() }, 1000)
  onCleanup(() => window.clearInterval(timer))
}, { immediate: true })
let expandedScroll = 0
watch(() => props.collapsed, rail => {
  if (rail) expandedScroll = navigationScroll.value?.scrollTop || 0
  else nextTick(() => {
    if (navigationScroll.value) navigationScroll.value.scrollTop = expandedScroll
  })
})
const filesSize = useSidebarFilesSize(props, emit, body)
const filesHidden = computed(() => props.collapsed || filesSize.closing.value || (props.filesCollapsed && !filesSize.opening.value))
async function restoreSidebar() {
  emit('toggleCollapse')
  await nextTick()
  sidebar.value?.querySelector('[data-sidebar-collapse]')?.focus({ preventScroll: true })
}
async function toggleFiles() {
  if (props.collapsed) {
    if (props.filesCollapsed) emit('toggleFiles')
    emit('toggleCollapse')
    await nextTick()
    sidebar.value?.querySelector('[data-files-search]')?.focus({ preventScroll: true })
  } else {
    emit('toggleFiles')
    await nextTick()
    sidebar.value?.querySelector('[data-files-collapse]')?.focus({ preventScroll: true })
  }
}
async function collapseFiles() {
  emit('toggleFiles')
  await nextTick()
  sidebar.value?.querySelector('[data-sidebar-files-toggle]')?.focus({ preventScroll: true })
}
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
.sidebar-navigation-scroll { scrollbar-width: thin; }
[data-sidebar-state="rail"] .sidebar-navigation-scroll { scrollbar-width: none; }
[data-sidebar-state="rail"] .sidebar-navigation-scroll::-webkit-scrollbar { display: none; }
.sidebar-files-dock { box-sizing: content-box; border-top-color: color-mix(in srgb, var(--color-ink-3) 45%, var(--color-rule)); }
.sidebar-files-resize {
  position: absolute;
  z-index: 20;
  inset: -4px 0 auto;
  height: 8px;
  cursor: ns-resize;
  touch-action: none;
}
.sidebar-files-resize::after { content: ''; position: absolute; inset: 3px 0 auto; height: 2px; }
.sidebar-files-resize:hover::after, .sidebar-files-resize:focus-visible::after { background: var(--color-accent); }
.sidebar-files-resize:focus-visible { outline: none; }
.sidebar-resizing, .sidebar-resizing * { cursor: ns-resize !important; user-select: none !important; }
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
.sidebar-tool-icon {
  position: relative;
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
}
.sidebar-recording-badge {
  position: absolute;
  right: -4px;
  bottom: -3px;
  display: grid;
  width: 10px;
  height: 10px;
  place-items: center;
  border-radius: 50%;
  background: var(--color-chrome);
}
.sidebar-recording {
  display: flex;
  flex: 0 0 48px;
  height: 48px;
  align-items: center;
  border-block: 1px solid var(--color-rule);
  padding-right: 8px;
  color: var(--color-ink-2);
}
.sidebar-recording-open {
  display: grid;
  min-width: 0;
  height: 46px;
  flex: 1;
  grid-template-columns: 52px minmax(0, 1fr);
  grid-template-rows: 14px 16px;
  align-content: center;
  align-items: center;
  text-align: left;
}
.sidebar-recording-icon {
  display: grid;
  grid-column: 1;
  grid-row: 1;
  place-items: center;
}
.sidebar-recording-label {
  grid-column: 2;
  grid-row: 1;
  font-size: 11px;
  line-height: 14px;
}
.sidebar-recording-time {
  grid-column: 2;
  grid-row: 2;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  white-space: nowrap;
}
.sidebar-recording-actions {
  display: flex;
  flex: 0 0 auto;
}
.sidebar-recording-action {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  color: var(--color-ink-3);
}
.sidebar-recording-action.is-muted { color: var(--color-rem); }
.sidebar-recording-action:disabled { opacity: 0.4; }
.sidebar-recording-open:hover,
.sidebar-recording-action:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}
[data-sidebar-state="rail"] .sidebar-recording {
  flex-direction: column;
  border: 0;
  padding-right: 0;
}
[data-sidebar-state="rail"] .sidebar-recording-open {
  width: 100%;
  height: 24px;
  flex: 0 0 24px;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: 1fr;
  text-align: center;
}
[data-sidebar-state="rail"] .sidebar-recording-time { grid-column: 1; grid-row: 1; }
[data-sidebar-state="rail"] .sidebar-recording-action { width: 24px; height: 24px; }
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
