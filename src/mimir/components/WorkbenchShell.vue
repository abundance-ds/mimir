<template>
  <main
    data-pane-shell="workbench"
    class="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-chrome text-ink"
    :class="{ 'is-dragging select-none': dragging }"
  >
    <section
      data-pane="sidebar"
      :data-pane-state="layout.sidebar.state"
      class="relative h-full min-h-0 shrink-0 overflow-hidden bg-chrome"
      :style="{ width: `${paneWidth('sidebar')}px` }"
    >
      <div
        data-pane-stage="sidebar"
        class="h-full min-h-0"
      >
        <slot name="sidebar" :collapsed="isRail('sidebar')" />
      </div>
    </section>

    <div
      v-if="!isRail('sidebar')"
      data-resize-boundary="sidebar"
      class="relative z-20 -mx-1.5 h-full w-3 shrink-0"
    >
      <button
        type="button"
        data-resize-handle="sidebar"
        aria-label="Resize sidebar"
        class="pane-resize-handle group block h-full w-full touch-none focus-visible:outline-none"
        @pointerdown="startResize('sidebar', $event)"
      >
        <span
          data-resize-line
          class="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-rule transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
        />
      </button>
    </div>

    <section
      data-pane="activity"
      :data-pane-state="layout.activity.state"
      class="relative h-full min-h-0 min-w-0 overflow-hidden border-r border-rule bg-chrome-mid"
      :class="isRail('activity') ? 'shrink-0' : 'flex-1'"
      :style="activityStyle"
    >
      <div
        data-pane-stage="activity"
        class="h-full min-h-0"
        :class="{ 'pointer-events-none invisible': isRail('activity') }"
        :aria-hidden="isRail('activity')"
      >
        <slot name="activity" :collapsed="isRail('activity')" />
      </div>
      <RailRestore
        v-if="isRail('activity')"
        pane="activity"
        :title="activityTitle"
        :meta="activityMeta"
        @restore="restorePane('activity')"
      />
    </section>

    <div
      v-if="canResizeEditor"
      data-resize-boundary="editor"
      class="relative z-20 -mx-1.5 h-full w-3 shrink-0"
    >
      <button
        type="button"
        data-resize-handle="editor"
        aria-label="Resize editor"
        class="pane-resize-handle group block h-full w-full touch-none focus-visible:outline-none"
        @pointerdown="startResize('editor', $event)"
      >
        <span
          data-resize-line
          class="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-rule-light transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
        />
      </button>
    </div>

    <section
      data-pane="editor"
      :data-pane-state="layout.editor.state"
      class="relative h-full min-h-0 min-w-0 overflow-hidden bg-surface"
      :class="editorClass"
      :style="editorStyle"
    >
      <div
        data-pane-stage="editor"
        class="h-full min-h-0"
        :class="{ 'pointer-events-none invisible': isRail('editor') }"
        :aria-hidden="isRail('editor')"
      >
        <slot name="editor" :collapsed="isRail('editor')" />
      </div>
      <RailRestore
        v-if="isRail('editor')"
        pane="editor"
        :title="editorTitle"
        :meta="editorMeta"
        @restore="restorePane('editor')"
      />
    </section>
  </main>
</template>

<script setup>
import { computed, nextTick, watch } from 'vue'
import RailRestore from './RailRestore.vue'
import { CONTENT_PANE_MIN_WIDTH, FOCUS_WORKBENCH_WIDTH, fittedEditorWidth, fittedSidebarWidth } from '../responsiveLayout.js'
import {
  ACTIVITY_RAIL_WIDTH,
  EDITOR_RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  useWorkbenchStore,
} from '../../stores/workbench.js'

const props = defineProps({
  dragging: { type: Boolean, default: false },
  activityTitle: { type: String, default: 'Activity' },
  activityMeta: { type: String, default: '' },
  editorTitle: { type: String, default: 'Editor' },
  editorMeta: { type: String, default: '' },
  viewportWidth: { type: Number, default: 1280 },
})

const emit = defineEmits(['resizeStart', 'restore'])
const workbench = useWorkbenchStore()
const layout = workbench.paneLayout

// A manual Sidebar restore can leave less space than the window's zone allows.
// Fit the live panes without replacing any saved width or reopening a pane.
watch(() => [props.viewportWidth, layout.sidebar.width, layout.sidebar.state], () => {
  const sidebar = layout.sidebar.state === 'rail' ? SIDEBAR_RAIL_WIDTH : fittedSidebarWidth(props.viewportWidth, layout.sidebar.width)
  const single = props.viewportWidth < FOCUS_WORKBENCH_WIDTH || props.viewportWidth - sidebar < CONTENT_PANE_MIN_WIDTH * 2
  if (single && layout.activity.state === 'expanded' && layout.editor.state === 'expanded'
    && document.activeElement?.closest('[data-pane]')?.dataset.pane === 'activity') {
    workbench.setPaneState('editor', 'rail')
  }
  workbench.setSinglePaneMode(single)
}, { immediate: true })

const railWidths = {
  sidebar: SIDEBAR_RAIL_WIDTH,
  activity: ACTIVITY_RAIL_WIDTH,
  editor: EDITOR_RAIL_WIDTH,
}

const canResizeEditor = computed(
  () => !isRail('activity') && !isRail('editor'),
)

const activityStyle = computed(() => (
  isRail('activity')
    ? { width: `${ACTIVITY_RAIL_WIDTH}px` }
    : { minWidth: `${isRail('editor') ? singleContentWidth.value : CONTENT_PANE_MIN_WIDTH}px` }
))

const singleContentWidth = computed(() => Math.min(CONTENT_PANE_MIN_WIDTH,
  Math.max(0, props.viewportWidth - paneWidth('sidebar') - ACTIVITY_RAIL_WIDTH)))

const editorClass = computed(() => (
  isRail('editor')
    ? 'shrink-0'
    : (isRail('activity') ? 'flex-1' : 'shrink-0')
))

const editorStyle = computed(() => {
  if (isRail('editor')) return { width: `${EDITOR_RAIL_WIDTH}px` }
  if (isRail('activity')) return { minWidth: `${singleContentWidth.value}px` }
  return {
    minWidth: `${CONTENT_PANE_MIN_WIDTH}px`,
    width: `${fittedEditorWidth(
      props.viewportWidth,
      layout.editor.width,
      paneWidth('sidebar'),
    )}px`,
  }
})

function isRail(pane) {
  return layout[pane].state === 'rail'
}

function paneWidth(pane) {
  if (isRail(pane)) return railWidths[pane]
  return pane === 'sidebar' ? fittedSidebarWidth(props.viewportWidth, layout.sidebar.width) : layout[pane].width
}

function startResize(pane, event) {
  emit('resizeStart', pane, event)
}

async function restorePane(pane) {
  workbench.setPaneState(pane, 'expanded')
  emit('restore', pane)
  await nextTick()
  const target = pane === 'activity'
    ? document.querySelector('[data-pane-header="activity"] button:not(:disabled)')
    : (
        document.querySelector('[data-pane="editor"] [data-editor-tabs-region] button:not(:disabled)')
        || document.querySelector('[data-pane="editor"] button:not(:disabled)')
      )
  target?.focus({ preventScroll: true })
}
</script>

<style scoped>
.is-dragging > section {
  transition: none;
}

.pane-resize-handle,
.pane-resize-handle * {
  cursor: ew-resize !important;
}

.is-dragging,
.is-dragging * {
  cursor: ew-resize !important;
}
</style>
