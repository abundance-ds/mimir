<template>
  <div ref="root" class="scribe-select">
    <button
      ref="trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="open ? optionId(activeIndex) : undefined"
      :disabled="disabled"
      class="scribe-select-trigger"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="min-w-0 flex-1 truncate text-left">
        {{ selectedOption?.label || 'Choose…' }}
      </span>
      <IconChevronDown :size="12" aria-hidden="true" />
    </button>

    <div
      v-if="open"
      :id="listboxId"
      ref="listbox"
      role="listbox"
      :aria-label="ariaLabel"
      class="scribe-select-listbox"
      @keydown="onListboxKeydown"
    >
      <button
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="option.value"
        :ref="element => setOptionRef(element, index)"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        class="scribe-select-option"
        :class="{ 'bg-accent-soft': option.value === modelValue }"
        @mouseenter="activeIndex = index"
        @focus="activeIndex = index"
        @click="choose(option)"
      >
        <IconCheck
          :size="11"
          class="shrink-0"
          :class="option.value === modelValue ? 'text-accent' : 'invisible'"
          aria-hidden="true"
        />
        <span class="truncate">{{ option.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { IconCheck, IconChevronDown } from '@tabler/icons-vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  ariaLabel: { type: String, required: true },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const root = ref(null)
const trigger = ref(null)
const listbox = ref(null)
const optionRefs = ref([])
const open = ref(false)
const activeIndex = ref(0)
const listboxId = `scribe-select-${useId().replaceAll(':', '')}`
const selectedOption = computed(() => (
  props.options.find(option => option.value === props.modelValue)
))

function optionId(index) {
  return `${listboxId}-option-${index}`
}

function setOptionRef(element, index) {
  if (element) optionRefs.value[index] = element
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    close()
    return
  }
  show()
}

function show(focus = false) {
  if (props.disabled) return
  activeIndex.value = Math.max(
    0,
    props.options.findIndex(option => option.value === props.modelValue),
  )
  open.value = true
  document.addEventListener('pointerdown', onOutsidePointerDown, true)
  if (focus) nextTick(focusActive)
}

function close({ restoreFocus = false } = {}) {
  open.value = false
  optionRefs.value = []
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}

function choose(option) {
  emit('update:modelValue', option.value)
  close({ restoreFocus: true })
}

function focusActive() {
  optionRefs.value[activeIndex.value]?.focus()
}

function move(delta) {
  if (!props.options.length) return
  activeIndex.value = (
    activeIndex.value + delta + props.options.length
  ) % props.options.length
  nextTick(focusActive)
}

function onTriggerKeydown(event) {
  if (props.disabled) return
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    show(true)
    if (event.key === 'ArrowUp') {
      activeIndex.value = Math.max(0, props.options.length - 1)
      nextTick(focusActive)
    }
    return
  }
  if (['Enter', ' '].includes(event.key)) {
    event.preventDefault()
    show(true)
  }
}

function onListboxKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close({ restoreFocus: true })
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    activeIndex.value = event.key === 'Home' ? 0 : Math.max(0, props.options.length - 1)
    nextTick(focusActive)
  }
}

function onOutsidePointerDown(event) {
  if (!root.value?.contains(event.target)) close()
}

onBeforeUnmount(() => close())
</script>

<style scoped>
.scribe-select {
  position: relative;
}

.scribe-select-trigger {
  display: flex;
  width: 100%;
  height: 32px;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink);
  font-size: 10px;
}

.scribe-select-trigger:hover:not(:disabled) {
  background: var(--color-chrome-mid);
}

.scribe-select-trigger:disabled {
  cursor: default;
  opacity: 0.45;
}

.scribe-select-trigger:focus-visible,
.scribe-select-option:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}

.scribe-select-listbox {
  position: absolute;
  z-index: 30;
  top: calc(100% + 2px);
  left: 0;
  width: 100%;
  max-height: 192px;
  overflow-y: auto;
  border: 1px solid var(--color-rule);
  background: var(--color-surface);
}

.scribe-select-option {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: 7px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 5px 8px;
  color: var(--color-ink-2);
  font-size: 10px;
  text-align: left;
}

.scribe-select-option:last-child {
  border-bottom: 0;
}

.scribe-select-option:hover,
.scribe-select-option:focus {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}
</style>
