<template>
  <div
    data-graph-filter-banner
    class="graph-filter-banner"
    role="status"
  >
    <span class="graph-filter-copy">
      <span class="graph-filter-showing">Showing:</span>
      <strong>{{ label }}</strong>
      <span v-if="hiddenCount" class="graph-filter-hidden">
        · {{ hiddenCount }} hidden
      </span>
    </span>
    <button
      v-bind="$attrs"
      type="button"
      :aria-label="`Clear filter: ${label}`"
      @click="$emit('clear')"
    >
      <IconX :size="12" />
      Clear
    </button>
  </div>
</template>

<script setup>
import { IconX } from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

defineProps({
  label: { type: String, required: true },
  hiddenCount: { type: Number, default: 0 },
})

defineEmits(['clear'])
</script>

<style scoped>
.graph-filter-banner {
  display: flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 3px 10px;
}

.graph-filter-copy {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--color-ink-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-filter-showing {
  color: var(--color-ink-4);
}

.graph-filter-copy strong {
  color: var(--color-ink);
  font-weight: 650;
}

.graph-filter-hidden {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.graph-filter-banner button {
  display: inline-flex;
  min-height: 22px;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 0 7px;
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 620;
}

.graph-filter-banner button:hover,
.graph-filter-banner button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}
</style>
