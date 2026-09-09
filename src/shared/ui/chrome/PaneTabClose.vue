<template><button type="button" data-no-reorder class="tab-close" :title="action" :aria-label="`${action} ${label}`" @click.stop="$emit('close')"><IconX :size="12" :stroke-width="1.8" /></button></template>
<script setup>
import { IconX } from '@tabler/icons-vue'
defineProps({ action: { type: String, default: 'Close' }, label: { type: String, default: '' } })
defineEmits(['close'])
</script>
<style>
.pane-tab .tab-close {
  position: absolute;
  right: 6px;
  top: 6px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--color-ink-3);
  opacity: 1;
}

.pane-tab .tab-close:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}


</style>
