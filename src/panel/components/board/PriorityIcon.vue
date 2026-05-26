<template>
  <svg v-if="priority === 'urgent'" class="shrink-0 text-accent" viewBox="0 0 12 12" width="14" height="14" fill="currentColor">
    <rect width="12" height="12" rx="2.5" opacity="0.15" />
    <rect x="5" y="2.5" width="2" height="4.5" rx="0.75" />
    <circle cx="6" cy="9" r="1.1" />
  </svg>
  <svg v-else class="shrink-0" :class="barClass" viewBox="0 0 12 12" width="14" height="14" fill="currentColor">
    <rect x="0" y="9" width="3" height="3" rx="0.5" />
    <rect x="4" y="6" width="3" height="6" rx="0.5" :opacity="level >= 2 ? 1 : 0.2" />
    <rect x="8" y="2" width="3" height="10" rx="0.5" :opacity="level >= 3 ? 1 : 0.2" />
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  priority: { type: String, default: 'normal' },
})

const level = computed(() => ({ low: 1, normal: 2, high: 3 }[props.priority] || 2))
const barClass = computed(() => ({ low: 'text-ink-3', normal: 'text-ink-3', high: 'text-ink-2' }[props.priority] || 'text-ink-3'))
</script>

