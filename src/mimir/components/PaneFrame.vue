<template>
  <section class="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
    <div
      :data-pane-content="pane"
      class="flex h-full min-h-0 w-full min-w-0 flex-col"
      :class="{ 'pointer-events-none invisible': collapsed }"
      :aria-hidden="collapsed"
    >
      <PaneBand as="header" kind="header"
        :data-pane-header="pane"
        class="drag-region pr-2 text-ink"
        :class="workbench.paneLayout.sidebar.state === 'rail' ? 'pl-6' : 'pl-2'"
        data-tauri-drag-region="deep"
      >
        <PaneRestoreControls :pane="pane" />

        <slot name="leading" />
        <slot name="tabs">
          <div data-pane-title class="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
            <slot name="title">
              <div class="truncate text-[12px] font-semibold leading-none">{{ title }}</div>
            </slot>
            <div v-if="metaLine" class="truncate font-mono text-[9px] uppercase tracking-[0.08em] text-ink-4">
              {{ metaLine }}
            </div>
          </div>
        </slot>

        <div
          :data-pane-actions="pane"
          class="no-drag flex shrink-0 items-center"
        >
          <span ref="actionsHost" class="contents" />
          <slot name="actions" />
        </div>

        <PaneSizeControls :pane="pane" :title="title" />
      </PaneBand>

      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <slot />
      </div>
    </div>
  </section>
</template>

<script setup>
import PaneBand from '../../shared/ui/chrome/PaneBand.vue'

import { computed } from 'vue'
import { useWorkbenchStore } from '../../stores/workbench.js'
import { providePaneChrome } from '../composables/usePaneChrome.js'

import PaneRestoreControls from './PaneRestoreControls.vue'
import PaneSizeControls from './PaneSizeControls.vue'

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
</script>
