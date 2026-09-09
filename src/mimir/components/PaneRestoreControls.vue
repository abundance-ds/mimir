<template>
  <nav v-if="controls.leading.length" :data-editor-restore-cluster="pane === 'editor' ? '' : undefined" class="no-drag flex shrink-0 items-center" :class="pane === 'editor' ? 'mr-1 border-r border-rule pr-1' : ''">
    <button v-for="target in controls.leading" :key="target" type="button" class="pane-icon-button"
      :data-pane-action="pane === 'activity' ? `restore-${target}` : undefined"
      :data-editor-action="pane === 'editor' ? `restore-${target}` : undefined"
      :title="`Restore ${target}`" :aria-label="`Restore ${target}`" @click="restore(target)">
      <IconLayoutSidebarLeftExpand v-if="target === 'sidebar'" :size="15" :stroke-width="1.8" />
      <IconArrowBarRight v-else :size="15" :stroke-width="1.8" />
    </button>
  </nav>
</template>
<script setup>
import { IconLayoutSidebarLeftExpand, IconArrowBarRight } from '@tabler/icons-vue'
import { usePaneControls } from '../composables/usePaneControls.js'
const props = defineProps({ pane: { type: String, required: true } })
const { controls, restore } = usePaneControls(() => props.pane)
</script>
