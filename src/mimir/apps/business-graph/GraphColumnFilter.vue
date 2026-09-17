<template>
  <div ref="root" class="graph-column-filter">
    <button ref="trigger" type="button" :data-graph-control="`graph-filter-${column}`"
      class="graph-column-filter-trigger" :class="{ active: modelValue.length }"
      :aria-label="`Filter by ${label.toLowerCase()}${modelValue.length ? `, ${modelValue.length} selected: ${selectionLabel}` : ''}`"
      :title="modelValue.length ? `${label}: ${selectionLabel}` : `Filter by ${label.toLowerCase()}`" :aria-expanded="opened" aria-haspopup="dialog"
      @pointerdown="rememberTriggerPress" @pointercancel="triggerPressWasOpen = null"
      @mousedown.prevent="trigger?.focus({ preventScroll: true })"
      @click="toggle" @keydown.down.prevent="open">
      <IconFilter :size="13" aria-hidden="true" />
      <span v-if="modelValue.length" class="graph-column-filter-count" aria-hidden="true">{{ modelValue.length }}</span>
    </button>
    <button v-if="modelValue.length" type="button" :data-graph-control="`graph-filter-clear-${column}`"
      class="graph-column-filter-clear" :aria-label="`Clear ${label.toLowerCase()} filter: ${selectionLabel}`"
      :title="`Clear ${label.toLowerCase()} filter: ${selectionLabel}`" @click="clear">
      <IconX :size="12" aria-hidden="true" />
    </button>
    <Teleport to="body">
    <div v-if="opened" ref="popup" class="graph-column-filter-popup" :style="position"
      data-modal-portal :data-graph-column-filter="column" role="dialog" :aria-label="`${label} filter`" @keydown="onKeydown">
      <div class="graph-column-filter-heading">
        <span>{{ label }}</span>
        <button type="button" :data-graph-control="`graph-filter-reset-${column}`" :disabled="!modelValue.length"
          :aria-label="`Clear ${label.toLowerCase()} filter`" @click="$emit('update:modelValue', [])">Clear</button>
      </div>
      <input v-if="searchable" ref="searchInput" v-model="query" type="search" autocomplete="off"
        :data-graph-control="`graph-filter-search-${column}`" :placeholder="`Find a ${label.toLowerCase()}…`"
        :aria-label="`Find a ${label.toLowerCase()}`" />
      <div class="graph-column-filter-options">
        <GraphCheckbox v-for="option in filteredOptions" :key="option.value"
          :model-value="modelValue.includes(option.value)" :data-graph-control="`graph-filter-option-${column}-${option.value}`"
          :title="option.hint ? `${option.label} · ${option.hint}` : option.label"
          @mousedown.prevent="$event.currentTarget.focus({ preventScroll: true })"
          @update:model-value="select(option.value)">
          <div class="graph-column-option-label">{{ option.label }}<small v-if="option.hint">{{ option.hint }}</small></div>
        </GraphCheckbox>
        <p v-if="!filteredOptions.length" role="status">No matching {{ label.toLowerCase() }}.</p>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconFilter, IconX } from '@tabler/icons-vue'
import GraphCheckbox from './GraphCheckbox.vue'
const props = defineProps({
  column: { type: String, required: true },
  label: { type: String, required: true },
  modelValue: { type: Array, default: () => [] },
  options: { type: Array, default: () => [] },
  searchable: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const root = ref(null), trigger = ref(null), popup = ref(null), searchInput = ref(null)
const opened = ref(false), query = ref(''), position = ref({})
const selectedOnOpen = ref([])
let triggerPressWasOpen = null
const selectionLabel = computed(() => props.modelValue.map(value => props.options.find(option => option.value === value)?.label || value).join(', '))
const filteredOptions = computed(() => props.options.filter(option =>
  `${option.label} ${option.hint || ''}`.toLowerCase().includes(query.value.trim().toLowerCase()))
  .sort((a, b) => Number(selectedOnOpen.value.includes(b.value)) - Number(selectedOnOpen.value.includes(a.value))))
async function open() {
  // Pin the existing selection on open; do not move rows beneath a click.
  selectedOnOpen.value = [...props.modelValue]
  opened.value = true
  query.value = ''
  await nextTick()
  place()
  if (searchInput.value) searchInput.value.focus({ preventScroll: true })
  else popup.value?.querySelector('[role="checkbox"]')?.focus({ preventScroll: true })
}
function rememberTriggerPress(event) {
  if (event.button === 0) triggerPressWasOpen = opened.value
}
function toggle(event) {
  // A native focus change can dismiss the popup between press and click.
  // Keep that click as Close instead of opening the popup again.
  const wasOpen = event.detail > 0 && triggerPressWasOpen !== null ? triggerPressWasOpen : opened.value
  triggerPressWasOpen = null
  if (wasOpen) closeMenus({ restoreFocus: true })
  else void open()
}
function place() {
  if (!opened.value || !trigger.value) return
  const rect = trigger.value.getBoundingClientRect()
  const width = Math.min(268, window.innerWidth - 16)
  const top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 220))
  position.value = { left: `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`,
    top: `${top}px`, width: `${width}px`, maxHeight: `${window.innerHeight - top - 8}px` }
}
function closeMenus({ restoreFocus = false } = {}) {
  if (!opened.value) return false
  opened.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
  return true
}
function select(value) {
  emit('update:modelValue', props.modelValue.includes(value)
    ? props.modelValue.filter(item => item !== value) : [...props.modelValue, value])
}
function clear() {
  closeMenus()
  emit('update:modelValue', [])
  trigger.value?.focus({ preventScroll: true })
}
function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenus({ restoreFocus: true })
    return
  }
  const isInput = event.target.tagName === 'INPUT'
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || (isInput && ['Home', 'End'].includes(event.key))) return
  const items = [...popup.value.querySelectorAll('input, [role="checkbox"]')]
  const index = items.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  items[next]?.focus()
}
function outside(event) {
  if (opened.value && !root.value?.contains(event.target) && !popup.value?.contains(event.target)) closeMenus()
}
function onScroll(event) { if (!popup.value?.contains(event.target)) place() }
watch(() => props.modelValue, () => { if (opened.value) void nextTick(place) })
let resizeObserver
onMounted(() => {
  const pane = root.value?.closest('[data-graph-entries]')
  if (pane && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(place)
    resizeObserver.observe(pane)
  }
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', place)
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', place)
})
defineExpose({ closeMenus })
</script>

<style scoped>
.graph-column-filter { display: flex; flex: 0 0 auto; align-items: center; margin-inline-start: auto; }
.graph-column-filter-trigger { display: flex; min-width: 24px; height: 28px; align-items: center; justify-content: center; gap: 2px; padding-inline: 4px; color: var(--color-ink-3); }
.graph-column-filter-count { min-width: 8px; font-size: 10px; font-variant-numeric: tabular-nums; }
.graph-column-filter-clear { display: grid; width: 20px; height: 28px; place-items: center; color: var(--color-ink-3); }
.graph-column-filter-clear:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-column-filter-trigger:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-column-filter-trigger.active { background: var(--color-accent-soft); color: var(--color-accent); }
.graph-column-filter-popup { position: fixed; z-index: 260; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--color-rule); background: var(--color-surface); box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); color: var(--color-ink); font-size: 12px; font-weight: 400; text-align: left; }
.graph-column-filter-heading { display: flex; min-height: 24px; justify-content: space-between; align-items: center; padding: 0 4px; font-weight: 600; }
.graph-column-filter-heading button { padding: 4px; color: var(--color-ink-3); font-size: 11px; font-weight: 400; }
.graph-column-filter-heading button:disabled { opacity: .4; }
.graph-column-filter-popup input { flex: 0 0 auto; width: 100%; min-height: 30px; padding: 4px 8px; border: 1px solid var(--color-rule); background: var(--color-chrome-high); font-size: 12px; }
.graph-column-filter-options { display: flex; min-height: 0; max-height: 300px; overflow: auto; flex-direction: column; }
.graph-column-filter-options > button { flex-shrink: 0; width: 100%; min-height: 28px; text-align: left; border-radius: 0; color: var(--color-ink-2); font-size: 12px; }
.graph-column-filter-options :deep(.graph-checkbox-control > span:first-child) { flex-shrink: 0; }
.graph-column-option-label { display: flex; min-width: 0; flex-direction: column; padding-block: 1px; overflow-wrap: anywhere; }
.graph-column-option-label small { color: var(--color-ink-3); font-size: 10px; }
.graph-column-filter-options p { padding: 8px 4px; color: var(--color-ink-3); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
</style>
