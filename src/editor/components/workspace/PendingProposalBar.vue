<template>
  <div class="pending-bar h-[30px] shrink-0 border-b border-rule-light flex items-center gap-3 px-[14px] whitespace-nowrap overflow-hidden">
    <span class="font-sans text-[11px] text-ink-2 truncate">
      {{ label }}
    </span>
    <div class="flex-1"></div>
    <span
      v-if="error"
      role="alert"
      class="max-w-[320px] truncate font-sans text-[10px] text-rem"
      :title="error"
    >{{ error }}</span>
    <button class="pending-action-btn discard" :disabled="busy" @mousedown.prevent @click="emit('discard')">Discard</button>
    <button class="pending-action-btn recheck" :disabled="busy" @mousedown.prevent @click="emit('recheck')">Re-check</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  count: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits(['recheck', 'discard'])

const label = computed(() => {
  const noun = props.count === 1 ? 'proposed edit is' : 'proposed edits are'
  return `${props.count} ${noun} pending. The target text is not in this document.`
})
</script>

<style scoped>
.pending-bar {
  background: var(--color-chrome-mid);
}

.pending-action-btn {
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 500;
  height: 22px;
  padding: 0 10px;
  border: none;
  border-radius: 3px;
  background: none;
}

.pending-action-btn.discard {
  color: var(--color-ink-3);
}
.pending-action-btn.discard:hover:not(:disabled) {
  color: var(--color-rem);
  background: color-mix(in srgb, var(--color-rem) 15%, transparent);
}

.pending-action-btn.recheck {
  color: var(--color-ink-2);
  border: 1px solid var(--color-rule);
}
.pending-action-btn.recheck:hover:not(:disabled) {
  color: var(--color-ink);
  background: var(--color-chrome-high);
}
</style>
