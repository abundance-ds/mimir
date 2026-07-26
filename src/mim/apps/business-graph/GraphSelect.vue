<template>
  <button
    ref="trigger"
    v-bind="$attrs"
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    :aria-expanded="open"
    :aria-controls="open ? listboxId : undefined"
    :aria-activedescendant="open && activeOption ? optionId(activeOption.value) : undefined"
    class="graph-select-trigger"
    :class="`graph-select-${variant}`"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="min-w-0 flex-1 truncate text-left">
      {{ selectedOption?.label || placeholder }}
    </span>
    <IconChevronDown
      :size="variant === 'card' ? 8 : 10"
      class="graph-select-chevron shrink-0"
      :class="{ 'rotate-180': open }"
    />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      :id="listboxId"
      data-graph-select-menu
      role="listbox"
      :aria-label="ariaLabel"
      class="graph-select-menu fixed z-[180] border border-rule bg-surface p-1 text-ink shadow-xl"
      :style="menuStyle"
      @keydown="onMenuKeydown"
    >
      <div v-if="searchable" class="relative mb-1 border-b border-rule-light pb-1">
        <IconSearch
          :size="10"
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-[calc(50%+2px)] text-ink-4"
        />
        <input
          ref="searchInput"
          v-model="query"
          data-graph-select-search
          type="search"
          class="h-7 w-full bg-chrome-high pl-7 pr-2 text-[9px] text-ink-2 placeholder:text-ink-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :placeholder="searchPlaceholder"
          :aria-label="`Search ${ariaLabel.toLowerCase()}`"
          autocomplete="off"
          @keydown.down.prevent="focusOption(0)"
          @keydown.up.prevent="focusOption(filteredOptions.length - 1)"
        />
      </div>

      <div class="max-h-60 overflow-y-auto">
        <button
          v-for="(option, index) in filteredOptions"
          :id="optionId(option.value)"
          :key="option.value"
          :ref="element => setOptionRef(element, index)"
          type="button"
          role="option"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          :data-graph-select-option="option.value"
          class="graph-select-option group flex min-h-8 w-full items-center gap-2 px-2 text-left hover:bg-chrome-mid focus-visible:bg-chrome-mid focus-visible:outline-none disabled:opacity-40"
          @mouseenter="activeIndex = index"
          @focus="activeIndex = index"
          @click="choose(option)"
        >
          <span
            class="grid size-4 shrink-0 place-items-center border"
            :class="option.value === modelValue ? 'border-accent/40 bg-accent-soft text-accent' : 'border-rule-light text-transparent'"
          >
            <IconCheck :size="9" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[9px] font-medium text-ink-2">{{ option.label }}</span>
            <span v-if="option.hint" class="block truncate font-mono text-[7px] text-ink-4">
              {{ option.hint }}
            </span>
          </span>
        </button>

        <p
          v-if="!filteredOptions.length"
          class="px-3 py-5 text-center text-[8px] text-ink-4"
        >
          No matching options
        </p>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  useAttrs,
  watch,
} from 'vue'
import { IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Choose…' },
  ariaLabel: { type: String, required: true },
  searchable: { type: Boolean, default: false },
  searchPlaceholder: { type: String, default: 'Filter options' },
  variant: {
    type: String,
    default: 'field',
    validator: value => ['toolbar', 'field', 'card'].includes(value),
  },
  menuMinWidth: { type: Number, default: 148 },
})

const emit = defineEmits(['update:modelValue', 'change'])
const attrs = useAttrs()
const trigger = ref(null)
const menu = ref(null)
const searchInput = ref(null)
const optionRefs = ref([])
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const menuStyle = ref({})
const selectCounter = nextSelectId()
const listboxId = `graph-select-${selectCounter}`

const normalizedOptions = computed(() => props.options.map(option => (
  typeof option === 'string'
    ? { value: option, label: human(option), hint: '', disabled: false }
    : {
        value: option.value ?? option.id ?? '',
        label: option.label ?? option.title ?? human(option.value ?? option.id),
        hint: option.hint ?? option.description ?? '',
        disabled: Boolean(option.disabled),
      }
)))
const selectedOption = computed(() => (
  normalizedOptions.value.find(option => option.value === props.modelValue)
))
const filteredOptions = computed(() => {
  const terms = query.value.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return normalizedOptions.value
  return normalizedOptions.value.filter(option => {
    const haystack = `${option.label} ${option.hint} ${option.value}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})
const activeOption = computed(() => filteredOptions.value[activeIndex.value])

watch(filteredOptions, () => {
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, filteredOptions.value.length - 1))
  optionRefs.value = []
})

function nextSelectId() {
  graphSelectCounter += 1
  return graphSelectCounter
}

async function toggle() {
  if (open.value) {
    close()
    return
  }
  await show()
}

async function show({ last = false } = {}) {
  if (attrs.disabled) return
  open.value = true
  query.value = ''
  const selected = normalizedOptions.value.findIndex(option => option.value === props.modelValue)
  activeIndex.value = last
    ? Math.max(0, normalizedOptions.value.length - 1)
    : Math.max(0, selected)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('resize', positionMenu)
  window.addEventListener('scroll', positionMenu, true)
  await nextTick()
  positionMenu()
  if (props.searchable) searchInput.value?.focus()
  else focusOption(activeIndex.value)
}

function close({ restoreFocus = false } = {}) {
  if (!open.value) return
  open.value = false
  query.value = ''
  optionRefs.value = []
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function choose(option) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  close({ restoreFocus: true })
}

function positionMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.max(rect.width, props.menuMinWidth)
  const estimatedHeight = Math.min(
    props.searchable ? 292 : 252,
    filteredOptions.value.length * 34 + (props.searchable ? 42 : 8),
  )
  const gap = 4
  const spaceBelow = window.innerHeight - rect.bottom - gap
  const openAbove = spaceBelow < Math.min(estimatedHeight, 160) && rect.top > spaceBelow
  const top = openAbove
    ? Math.max(6, rect.top - estimatedHeight - gap)
    : Math.min(window.innerHeight - estimatedHeight - 6, rect.bottom + gap)
  const left = Math.min(
    Math.max(6, rect.left),
    Math.max(6, window.innerWidth - width - 6),
  )
  menuStyle.value = {
    top: `${Math.max(6, top)}px`,
    left: `${left}px`,
    width: `${width}px`,
  }
}

function onTriggerKeydown(event) {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    void show({ last: event.key === 'ArrowUp' })
  }
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close({ restoreFocus: true })
    return
  }
  if (event.key === 'Tab') {
    close()
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusOption(event.key === 'Home' ? 0 : filteredOptions.value.length - 1)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const length = filteredOptions.value.length
    if (length) focusOption((activeIndex.value + offset + length) % length)
    return
  }
  if (event.key === 'Enter' && document.activeElement !== searchInput.value) {
    event.preventDefault()
    if (activeOption.value) choose(activeOption.value)
  }
}

function focusOption(index) {
  if (index < 0 || index >= filteredOptions.value.length) return
  activeIndex.value = index
  optionRefs.value[index]?.focus()
}

function setOptionRef(element, index) {
  if (element) optionRefs.value[index] = element
}

function onDocumentPointerDown(event) {
  if (trigger.value?.contains(event.target) || menu.value?.contains(event.target)) return
  close()
}

function optionId(value) {
  return `${listboxId}-${String(value).replaceAll(/[^a-zA-Z0-9_-]/g, '-') || 'empty'}`
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

onUnmounted(close)
</script>

<script>
let graphSelectCounter = 0
</script>

<style scoped>
.graph-select-trigger {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-rule-light);
  border-radius: 0;
  background: var(--color-surface);
  color: var(--color-ink-3);
}

.graph-select-trigger:hover {
  border-color: var(--color-rule);
  color: var(--color-ink);
}

.graph-select-trigger:focus-visible {
  border-color: var(--color-accent);
  outline: 1px solid var(--color-accent);
  outline-offset: 0;
}

.graph-select-trigger:disabled {
  opacity: 0.45;
}

.graph-select-toolbar {
  height: 24px;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 7px;
}

.graph-select-field {
  width: 100%;
  min-height: 29px;
  padding: 0 8px;
  background: var(--color-chrome-high);
  font-size: 10px;
  color: var(--color-ink-2);
}

.graph-select-card {
  height: 20px;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 6px;
}

.graph-select-chevron {
  transition: transform 120ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .graph-select-chevron {
    transition: none;
  }
}
</style>
