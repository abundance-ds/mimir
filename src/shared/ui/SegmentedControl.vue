<template>
  <div class="segmented-control" role="group">
    <template v-for="(opt, i) in options" :key="opt">
      <span v-if="i > 0" class="w-0"></span>
      <button
        class="segmented-option"
        :class="modelValue === opt
          ? 'is-active'
          : ''"
        :aria-pressed="modelValue === opt"
        @click="$emit('update:modelValue', opt)"
      >{{ opt }}</button>
    </template>
  </div>
</template>

<script setup>
defineProps({
  options: { type: Array, required: true },
  modelValue: { type: String, required: true },
})
defineEmits(['update:modelValue'])
</script>

<style scoped>
.segmented-control {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 22px;
  padding: 2px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  background: var(--color-chrome-mid);
}

.segmented-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  height: 16px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0;
  text-transform: capitalize;
}

.segmented-option:hover:not(.is-active) {
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
}

.segmented-option.is-active {
  color: var(--color-ink);
  background: var(--color-surface);
  box-shadow: 0 0 0 1px var(--color-rule-light);
  font-weight: 600;
}

.segmented-option:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
