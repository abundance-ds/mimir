<template>
  <section class="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
    <div
      :data-pane-content="pane"
      class="flex h-full min-h-0 w-full min-w-0 flex-col"
      :class="{ 'pointer-events-none invisible': collapsed }"
      :aria-hidden="collapsed"
    >
      <header
        :data-pane-header="pane"
        class="pane-header drag-region gap-2 pr-2 text-ink"
        :class="workbench.paneLayout.sidebar.state === 'rail' ? 'pl-6' : 'pl-2'"
        data-tauri-drag-region="deep"
      >
        <nav v-if="pane === 'activity'" class="no-drag flex shrink-0 items-center">
          <button
            v-if="workbench.paneLayout.sidebar.state === 'rail'"
            type="button"
            data-pane-action="restore-sidebar"
            title="Restore sidebar"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="restoreSidebar"
          >
            <IconLayoutSidebarLeftExpand :size="15" :stroke-width="1.8" />
          </button>
          <button
            type="button"
            data-pane-action="previous"
            title="Previous activity"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-30"
            :disabled="!workbench.canGoPreviousActivity"
            @click="workbench.previousActivity()"
          >
            <IconChevronLeft :size="15" :stroke-width="1.8" />
          </button>
          <button
            type="button"
            data-pane-action="next"
            title="Next activity"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-30"
            :disabled="!workbench.canGoNextActivity"
            @click="workbench.nextActivity()"
          >
            <IconChevronRight :size="15" :stroke-width="1.8" />
          </button>
        </nav>

        <div class="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
          <div class="truncate text-[12px] font-semibold leading-none">{{ title }}</div>
          <div v-if="metaLine" class="truncate font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4">
            {{ metaLine }}
          </div>
        </div>

        <div
          :data-pane-actions="pane"
          class="no-drag flex shrink-0 items-center"
        >
          <span ref="actionsHost" class="contents" />
          <slot name="actions" />
        </div>

        <button
          type="button"
          data-pane-action="expand"
          :title="activityExpanded ? 'Restore split' : 'Expand Activity'"
          class="no-drag grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
          :class="{ 'bg-chrome-mid text-ink': activityExpanded }"
          @click="workbench.setActivityExpanded(!activityExpanded)"
        >
          <IconArrowsMinimize v-if="activityExpanded" :size="15" :stroke-width="1.8" />
          <IconArrowsMaximize v-else :size="15" :stroke-width="1.8" />
        </button>

        <button
          type="button"
          data-pane-action="collapse"
          :data-collapse-direction="pane === 'activity' ? 'left' : 'right'"
          :title="`Collapse ${title}`"
          class="no-drag grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
          @click="collapsePane"
        >
          <IconArrowBarToLeft v-if="pane === 'activity'" :size="15" :stroke-width="1.8" />
          <IconArrowBarToRight v-else :size="15" :stroke-width="1.8" />
        </button>
      </header>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <slot />
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick } from 'vue'
import {
  IconArrowBarToLeft,
  IconArrowBarToRight,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutSidebarLeftExpand,
} from '@tabler/icons-vue'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { providePaneChrome } from '../composables/usePaneChrome.js'

const props = defineProps({
  pane: {
    type: String,
    required: true,
    validator: (value) => ['activity', 'editor'].includes(value),
  },
  title: { type: String, required: true },
  meta: { type: String, default: '' },
})

const workbench = useWorkbenchStore()
const { actionsHost, meta: contributedMeta } = providePaneChrome()
const metaLine = computed(() => contributedMeta.value || props.meta)
const collapsed = computed(() => workbench.paneLayout[props.pane].state === 'rail')
const activityExpanded = computed(
  () => workbench.paneLayout.activity.state === 'expanded'
    && workbench.paneLayout.editor.state === 'rail',
)

async function collapsePane() {
  workbench.setPaneState(props.pane, 'rail')
  await nextTick()
  document.querySelector(`[data-pane-restore="${props.pane}"]`)?.focus()
}

async function restoreSidebar() {
  workbench.setPaneState('sidebar', 'expanded')
  await nextTick()
  document.querySelector('[data-sidebar-collapse], [data-sidebar-workspace]')?.focus()
}
</script>
