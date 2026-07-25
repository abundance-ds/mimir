<template>
  <main
    data-pane-shell="workbench"
    class="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-chrome text-ink"
    :class="{ 'is-dragging select-none': dragging }"
  >
    <section
      data-pane="sidebar"
      :data-pane-state="layout.sidebar.state"
      class="relative h-full min-h-0 shrink-0 overflow-hidden border-r border-rule bg-chrome motion-safe:transition-[width] motion-safe:duration-150 motion-reduce:transition-none"
      :style="{ width: `${paneWidth('sidebar')}px` }"
    >
      <div
        data-pane-stage="sidebar"
        class="h-full min-h-0"
      >
        <slot name="sidebar" :collapsed="isRail('sidebar')" />
      </div>
      <button
        v-if="!isRail('sidebar')"
        type="button"
        data-resize-handle="sidebar"
        aria-label="Resize sidebar"
        class="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
        @pointerdown="startResize('sidebar', $event)"
      />
    </section>

    <section
      data-pane="activity"
      :data-pane-state="layout.activity.state"
      class="relative h-full min-h-0 min-w-0 overflow-hidden border-r border-rule bg-chrome-mid motion-safe:transition-[width] motion-safe:duration-150 motion-reduce:transition-none"
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
        @restore="workbench.setPaneState('activity', 'expanded')"
      />
    </section>

    <section
      data-pane="editor"
      :data-pane-state="layout.editor.state"
      class="relative h-full min-h-0 min-w-0 shrink-0 overflow-hidden bg-surface motion-safe:transition-[width] motion-safe:duration-150 motion-reduce:transition-none"
      :style="{ width: `${paneWidth('editor')}px` }"
    >
      <button
        v-if="canResizeEditor"
        type="button"
        data-resize-handle="editor"
        aria-label="Resize editor"
        class="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none"
        @pointerdown="startResize('editor', $event)"
      />
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
        @restore="workbench.setPaneState('editor', 'expanded')"
      />
    </section>
  </main>
</template>

<script setup>
import { computed } from 'vue'
import RailRestore from './RailRestore.vue'
import {
  ACTIVITY_RAIL_WIDTH,
  EDITOR_RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  useWorkbenchStore,
} from '../../stores/workbench.js'

defineProps({
  dragging: { type: Boolean, default: false },
  activityTitle: { type: String, default: 'Activity' },
  activityMeta: { type: String, default: '' },
  editorTitle: { type: String, default: 'Editor' },
  editorMeta: { type: String, default: '' },
})

const emit = defineEmits(['resizeStart'])
const workbench = useWorkbenchStore()
const layout = workbench.paneLayout

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
    : { minWidth: '336px' }
))

function isRail(pane) {
  return layout[pane].state === 'rail'
}

function paneWidth(pane) {
  return isRail(pane) ? railWidths[pane] : layout[pane].width
}

function startResize(pane, event) {
  emit('resizeStart', pane, event)
}
</script>

<style scoped>
.is-dragging > section {
  transition: none;
}
</style>
