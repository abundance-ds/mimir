<template>
  <div class="no-drag flex shrink-0 items-center">
    <button type="button" class="pane-icon-button" :class="{ 'bg-chrome-mid text-ink': controls.expanded }"
      :data-pane-action="pane === 'activity' ? 'expand' : undefined" :data-editor-action="pane === 'editor' ? 'expand' : undefined"
      :title="controls.expanded ? 'Restore split' : `Expand ${pane === 'activity' ? 'Activity' : 'Editor'}`"
      :aria-label="controls.expanded ? 'Restore split' : `Expand ${pane === 'activity' ? 'Activity' : 'Editor'}`" @click="expand">
      <IconArrowsMinimize v-if="controls.expanded" :size="15" :stroke-width="1.8" />
      <IconArrowsMaximize v-else :size="15" :stroke-width="1.8" />
    </button>
    <button type="button" class="pane-icon-button" :data-pane-action="pane === 'activity' ? 'collapse' : undefined"
      :data-editor-action="pane === 'editor' ? 'collapse' : undefined" :data-collapse-direction="pane === 'activity' ? 'left' : 'right'"
      :title="`Collapse ${title || pane}`" :aria-label="`Collapse ${title || pane}`" @click="collapse">
      <IconArrowBarToLeft v-if="pane === 'activity'" :size="15" :stroke-width="1.8" />
      <IconArrowBarToRight v-else :size="15" :stroke-width="1.8" />
    </button>
  </div>
</template>
<script setup>
import { IconArrowsMinimize, IconArrowsMaximize, IconArrowBarToLeft, IconArrowBarToRight } from '@tabler/icons-vue'
import { usePaneControls } from '../composables/usePaneControls.js'
const props = defineProps({ pane: { type: String, required: true }, title: { type: String, default: '' } })
const { controls, expand, collapse } = usePaneControls(() => props.pane)
</script>
