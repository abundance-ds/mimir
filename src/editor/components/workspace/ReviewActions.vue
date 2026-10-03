<template>
  <div class="review-actions" role="group" :aria-label="`Changes ${scope}`">
    <button type="button" class="review-accept" :disabled="disabled || !pending"
      :aria-label="`Accept remaining changes ${scope}`" :title="`Accept remaining changes ${scope}`"
      @mousedown.prevent @click="emit('accept')"><IconCheck :size="12" :stroke-width="2" aria-hidden="true" />{{ compact ? 'Accept' : 'Accept all' }}</button>
    <button type="button" class="review-reject" :disabled="disabled || !pending"
      :aria-label="`Reject remaining changes ${scope}`" :title="`Reject remaining changes ${scope}`"
      @mousedown.prevent @click="emit('reject')"><IconX :size="12" :stroke-width="2" aria-hidden="true" />{{ compact ? 'Reject' : 'Reject all' }}</button>
  </div>
</template>

<script setup>
import { IconCheck, IconX } from '@tabler/icons-vue'
defineProps({
  scope: { type: String, default: 'in this file' },
  pending: { type: Boolean, default: true },
  disabled: Boolean,
  compact: Boolean,
})
const emit = defineEmits(['accept', 'reject'])
</script>

<style scoped>
.review-actions { display: flex; align-items: center; gap: 2px; }
.review-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 3px; height: 24px; padding: 0 5px; border-radius: 3px; font: 10px var(--font-sans); white-space: nowrap; }
.review-accept { color: color-mix(in srgb, var(--color-add) 75%, var(--color-ink-2)); }
.review-reject { color: color-mix(in srgb, var(--color-rem) 75%, var(--color-ink-2)); }
.review-accept:hover:not(:disabled) { background: color-mix(in srgb, var(--color-add) 10%, transparent); color: var(--color-add); }
.review-reject:hover:not(:disabled) { background: color-mix(in srgb, var(--color-rem) 10%, transparent); color: var(--color-rem); }
.review-actions button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 1px; }
.review-actions button:disabled { opacity: .35; cursor: default; }
</style>
