<template>
  <button
    v-bind="$attrs"
    type="button"
    role="checkbox"
    class="graph-checkbox-control"
    :aria-checked="modelValue"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span :class="{ checked: modelValue }">
      <IconCheck v-if="modelValue" :size="11" />
    </span>
    <slot />
  </button>
</template>

<script setup>
import { IconCheck } from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

defineProps({
  modelValue: { type: Boolean, default: false },
})

defineEmits(['update:modelValue'])
</script>

<style scoped>
.graph-checkbox-control {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 8px;
  border-radius: 5px;
  padding: 0 5px;
  color: var(--color-ink-3);
  font-size: 11px;
}

.graph-checkbox-control:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-checkbox-control:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  outline-offset: 1px;
}

.graph-checkbox-control > span {
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  color: transparent;
}

.graph-checkbox-control > span.checked {
  border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-rule));
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
</style>
