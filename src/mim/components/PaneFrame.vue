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
        class="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-rule bg-chrome-mid px-2 text-ink"
        data-tauri-drag-region="deep"
      >
        <nav v-if="pane === 'activity'" class="no-drag flex shrink-0 items-center">
          <button
            type="button"
            data-pane-action="previous"
            title="Previous activity"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink disabled:opacity-30"
            :disabled="!workbench.canGoPreviousActivity"
            @click="workbench.previousActivity()"
          >
            <IconChevronLeft :size="15" :stroke-width="1.8" />
          </button>
          <button
            type="button"
            data-pane-action="next"
            title="Next activity"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink disabled:opacity-30"
            :disabled="!workbench.canGoNextActivity"
            @click="workbench.nextActivity()"
          >
            <IconChevronRight :size="15" :stroke-width="1.8" />
          </button>
        </nav>

        <div class="min-w-0 flex-1" data-tauri-drag-region>
          <div class="truncate text-[12px] font-semibold leading-none">{{ title }}</div>
          <div v-if="meta" class="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
            {{ meta }}
          </div>
        </div>

        <slot name="actions" />

        <button
          type="button"
          data-pane-action="collapse"
          :title="`Collapse ${title}`"
          class="no-drag grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink"
          @click="workbench.setPaneState(pane, 'rail')"
        >
          <IconLayoutSidebarLeftCollapse
            v-if="pane !== 'editor'"
            :size="15"
            :stroke-width="1.8"
          />
          <IconLayoutSidebarRightCollapse
            v-else
            :size="15"
            :stroke-width="1.8"
          />
        </button>
      </header>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <slot />
      </div>
    </div>

    <button
      v-if="collapsed"
      type="button"
      :data-pane-rail="pane"
      :title="`Restore ${title}`"
      class="absolute inset-0 flex h-full w-full flex-col items-center gap-3 overflow-hidden border-r border-rule bg-chrome py-3 text-ink-3 hover:bg-chrome-mid hover:text-ink"
      @click="workbench.setPaneState(pane, 'expanded')"
    >
      <span
        v-if="meta"
        class="size-1.5 shrink-0 rounded-full bg-accent"
        aria-hidden="true"
      />
      <span class="truncate font-mono text-[9px] uppercase tracking-[0.16em] [writing-mode:vertical-rl]">
        {{ title }}
      </span>
      <span
        v-if="meta"
        class="truncate text-[9px] text-ink-4 [writing-mode:vertical-rl]"
      >
        {{ meta }}
      </span>
    </button>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import {
  IconChevronLeft,
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarRightCollapse,
} from '@tabler/icons-vue'
import { useWorkbenchStore } from '../../stores/workbench.js'

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
const collapsed = computed(() => workbench.paneLayout[props.pane].state === 'rail')
</script>
