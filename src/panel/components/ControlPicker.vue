<template>
  <div class="control-picker">
    <button ref="referenceRef" class="picker-trigger" :disabled="disabled || options.length === 0" @click="toggle">
      <span class="picker-label">{{ currentLabel }}</span>
      <IconChevronDown :size="12" />
    </button>
    <div v-if="isOpen" ref="floatingRef" class="picker-dropdown" :style="floatingStyles">
      <button
        v-for="option in options"
        :key="option.id"
        class="picker-option"
        :class="{ selected: option.id === controlId }"
        type="button"
        @click="select(option.id)"
      >
        {{ option.label || option.id }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { usePopover } from '../../shared/composables/usePopover'
import { IconChevronDown } from '@tabler/icons-vue'

const props = defineProps({
  controlId: String,
  label: { type: String, default: 'Control' },
  options: { type: Array, default: () => [] },
  disabled: Boolean,
})
const emit = defineEmits(['update:controlId'])

const { referenceRef, floatingRef, floatingStyles, isOpen, toggle, close } = usePopover()
const currentLabel = computed(() => props.options.find((option) => option.id === props.controlId)?.label || 'Default')

function select(id) {
  emit('update:controlId', id)
  close()
}
</script>

<style scoped>
.control-picker { position: relative; }
.picker-trigger {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px;
  border-radius: 999px; color: var(--color-ink-2);
  font-family: var(--font-mono); font-size: 12px;
}
.picker-trigger:hover { background: var(--color-surface); }
.picker-trigger:disabled { opacity: 0.4; pointer-events: none; }
.picker-label { color: var(--color-ink-2); }
.picker-dropdown {
  background: var(--color-surface); border: 1px solid var(--color-rule); border-radius: 6px;
  padding: 4px; width: 170px; z-index: 20;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.picker-option {
  display: block; width: 100%; text-align: left;
  padding: 7px 10px; border-radius: 4px;
  font-family: var(--font-mono); font-size: 12px;
}
.picker-option:hover { background: var(--color-chrome-high); }
.picker-option.selected { background: var(--color-accent-tint); color: var(--color-accent); font-weight: 600; }
</style>
