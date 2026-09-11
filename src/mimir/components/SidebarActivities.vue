<template>
  <section class="sidebar-activities shrink-0 overflow-hidden" aria-label="Activities">
    <div class="flex h-[28px] items-center">
      <div data-activities-heading class="flex min-w-0 flex-1 items-center gap-1 px-3 text-[11px] text-ink-3" :class="{ invisible: rail }" :aria-hidden="rail">
        Activities
        <span v-if="tabs.some(rowNeedsAttention)" aria-label="Activities need attention">!</span>
      </div>
      <button type="button" class="pane-icon-button" :class="{ invisible: rail }" :aria-hidden="rail" :tabindex="rail ? -1 : undefined"
        title="New Activity (⌘T)" aria-label="New Activity" @click="$emit('new')"><IconPlus :size="14" /></button>
    </div>
    <nav
      ref="rows"
      aria-label="Open Activities"
      class="min-w-0"
      @keydown="onKeydown"
    >
      <SidebarRow
        v-for="tab in tabs"
        :key="tab.id"
        compact
        :data-activity-key="tab.id"
        :data-activity-state="rowState(tab)"
        :data-sidebar-row="`activity:${tab.id}`"
        :label="tab.title"
        :title="rowTitle(tab)"
        :aria-label="rowTitle(tab)"
        :active="activeId === tab.id"
        :collapsed="rail"
        :editing="renaming === tab.id"
        :class="{
          'activity-drop-before': reorder.dropIndicator.value?.beforeId === tab.id,
          'activity-drop-after': reorder.dropIndicator.value?.afterId === tab.id,
        }"
        @pointerdown="reorder.onPointerDown($event, tab.id)"
        @click="renaming !== tab.id && select(tab.id)"
        @dblclick="beginRename(tab)"
        @contextmenu.prevent="showContext(tab, $event)"
      >
        <span class="relative grid size-full place-items-center">
          <component :is="activityIcon(tab)" :size="16" :stroke-width="1.7" :monochrome="true" />
          <ActivityRowStatus v-if="rail" class="absolute -right-1 bottom-0"
            :activity-id="tab.id" :state="rowState(tab)" rail
          />
        </span>
        <template #label>
          <input
            v-if="renaming === tab.id"
            ref="renameInput"
            v-model="draft"
            data-tab-rename
            aria-label="Session name"
            maxlength="160"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            class="w-full min-w-0 border border-accent bg-surface px-1 text-ink"
            @click.stop
            @dblclick.stop
            @keydown="renameKey"
            @blur="cancelRename"
          />
          <span v-else>{{ tab.title }}</span>
        </template>
        <template #meta>
          <ActivityRowStatus v-if="!rail" :activity-id="tab.id"
            :state="rowState(tab)" :time="rowTime(tab)"
          />
        </template>
      </SidebarRow>
      <div v-if="!tabs.length" class="h-[24px] px-3 text-[11px] leading-[24px] text-ink-3" :class="{ invisible: rail }" :aria-hidden="rail">
        No open activities
      </div>
    </nav>
    <span class="hidden"><WorkbenchMenu ref="context" label="Activity actions" compact :items="contextItems" @select="contextAction" /></span>
  </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { IconPlus } from '@tabler/icons-vue'
import { activityIcon } from '../activityIcons.js'
import { useActivityNavigation } from '../composables/useActivityNavigation.js'
import SidebarRow from './SidebarRow.vue'
import WorkbenchMenu from './WorkbenchMenu.vue'
import ActivityRowStatus from './ActivityRowStatus.vue'
import { relativeTime } from '../../shared/time.js'

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  blockingIds: { type: Set, default: () => new Set() },
  restoringIds: { type: Set, default: () => new Set() },
  rail: Boolean,
})
const emit = defineEmits(['select', 'close', 'rename', 'new', 'reorder'])
const rows = ref(null)
const {
  context, renaming, draft, renameInput,
  contextItems, reorder, select, beginRename, cancelRename,
  renameKey, showContext, contextAction, onKeydown,
} = useActivityNavigation(props, emit, {
  root: rows,
  axis: 'y',
  rowSelector: '[data-activity-key]',
  keyAttribute: 'data-activity-key',
  buttonSelector: '[data-activity-key] > button',
})
// Restore the Sidebar's pre-tab status treatment (3ddccda / e2fd7b4).
// A normal prompt is not a blocking input request. Output does not prove work.
function rowState(activity) {
  if (activity.status === 'error' || activity.error) return 'error'
  if (props.restoringIds.has(activity.id)) return 'resuming'
  if (['starting', 'working'].includes(activity.status)) return activity.status
  if (activity.id !== props.activeId) {
    if (activity.status === 'needs-input' && props.blockingIds.has(activity.id)) return 'attention'
    if (activity.unread) return 'unread'
  }
  return 'quiet'
}
function rowNeedsAttention(activity) {
  return ['error', 'attention', 'unread'].includes(rowState(activity))
}
const now = ref(Date.now())
let clock
onMounted(() => { clock = window.setInterval(() => { now.value = Date.now() }, 60_000) })
onUnmounted(() => window.clearInterval(clock))
function rowTime(activity) {
  return relativeTime(activity.updatedAt, now.value, { compact: true })
}
function rowTitle(activity) {
  const label = {
    error: 'Error', working: 'Working', starting: 'Starting',
    attention: 'Needs input', unread: 'Unread', resuming: 'Resuming',
  }[rowState(activity)]
  return `${activity.title}${label ? ` — ${label}` : ''}${rowTime(activity) ? ` · ${rowTime(activity)}` : ''}`
}
</script>

<style scoped>
.activity-drop-before::before,
.activity-drop-after::after {
  content: '';
  position: absolute;
  pointer-events: none;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--color-accent);
}
.activity-drop-before::before { top: 0; }
.activity-drop-after::after { bottom: 0; }
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
