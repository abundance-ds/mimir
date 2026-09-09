<template>
  <button
    type="button"
    :data-pane-restore="pane"
    :title="`Restore ${title}`"
    :aria-label="`Restore ${pane === 'activity' ? 'Activity' : 'Editor'}: ${title}`"
    class="group absolute inset-0 z-30 flex h-full w-full flex-col items-center overflow-hidden bg-chrome-high text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    @click="$emit('restore')"
  >
    <PaneBand as="span" kind="header"
      data-rail-header
      class="w-full justify-center"
      aria-hidden="true"
    >
      <IconArrowBarRight v-if="!controls.quietRail && pane === 'activity'" :size="15" :stroke-width="1.8" />
      <IconArrowBarLeft v-else-if="!controls.quietRail" :size="15" :stroke-width="1.8" />
    </PaneBand>

    <span class="flex min-h-0 flex-1 items-center justify-center py-3">
      <span class="flex max-h-full min-h-0 items-center gap-2 [writing-mode:vertical-rl]">
        <span class="max-h-[220px] truncate text-[11px] font-semibold text-ink-2 group-hover:text-ink">
          {{ title }}
        </span>
        <span v-if="meta" class="max-h-[160px] truncate font-mono text-[9px] text-ink-4">
          {{ meta }}
        </span>
      </span>
    </span>

    <PaneBand as="span" kind="footer" data-rail-footer class="w-full justify-center !px-0">
      <span class="max-w-full truncate font-mono text-[9px] font-semibold uppercase text-ink-4">
        {{ pane === 'activity' ? 'Work' : 'Editor' }}
      </span>
    </PaneBand>
  </button>
</template>

<script setup>
import PaneBand from '../../shared/ui/chrome/PaneBand.vue'

import { usePaneControls } from '../composables/usePaneControls.js'
import { IconArrowBarLeft, IconArrowBarRight } from '@tabler/icons-vue'

const props = defineProps({
  pane: {
    type: String,
    required: true,
    validator: (value) => ['activity', 'editor'].includes(value),
  },
  title: { type: String, required: true },
  meta: { type: String, default: '' },
})

const { controls } = usePaneControls(() => props.pane)
defineEmits(['restore'])
</script>
