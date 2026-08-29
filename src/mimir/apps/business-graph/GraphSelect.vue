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
      <slot name="trigger" :option="selectedOption">
        {{ selectedOption?.label || placeholder }}
      </slot>
    </span>
    <IconChevronDown
      v-if="chevron"
      :size="variant === 'card' ? 8 : variant === 'row' || variant === 'quiet' ? 9 : 10"
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
      data-modal-portal
      role="listbox"
      :aria-label="ariaLabel"
      class="graph-select-menu fixed z-[260] text-ink"
      :style="menuStyle"
      @keydown="onMenuKeydown"
    >
      <div v-if="searchable" class="graph-select-search-wrap relative">
        <IconSearch
          :size="13"
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4"
        />
        <input
          ref="searchInput"
          v-model="query"
          data-graph-select-search
          type="search"
          class="graph-select-search"
          :placeholder="searchPlaceholder"
          :aria-label="`Search ${ariaLabel.toLowerCase()}`"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          @keydown.down.prevent="focusOption(0)"
          @keydown.up.prevent="focusOption(filteredOptions.length - 1)"
          @keydown.enter.prevent="createFromQuery"
        />
      </div>

      <div class="graph-select-options">
        <template
          v-for="(option, index) in filteredOptions"
          :key="option.value"
        >
          <button
            :id="optionId(option.value)"
            :ref="element => setOptionRef(element, index)"
            type="button"
            role="option"
            :aria-selected="option.value === modelValue"
            :disabled="option.disabled"
            :data-graph-select-option="option.value"
            class="graph-select-option group"
            @mouseenter="activeIndex = index"
            @focus="activeIndex = index"
            @click="choose(option)"
          >
            <span
              class="graph-select-check"
              :class="{ 'graph-select-check-active': option.value === modelValue }"
            >
              <IconCheck :size="9" />
            </span>
            <span v-if="option.icon" class="graph-select-option-icon">
              <component :is="option.icon" :size="13" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="graph-select-option-label">{{ option.label }}</span>
              <span v-if="option.hint" class="graph-select-option-hint">
                {{ option.hint }}
              </span>
            </span>
          </button>
          <div
            v-if="option.separatorAfter"
            class="graph-select-separator"
            role="separator"
          />
        </template>

        <p
          v-if="!filteredOptions.length && !canCreate"
          class="px-3 py-7 text-center text-[11px] text-ink-4"
        >
          No matching options
        </p>
        <button
          v-if="canCreate"
          type="button"
          role="option"
          aria-selected="false"
          data-graph-control="select-create"
          data-graph-select-create
          class="graph-select-create"
          @click="createFromQuery"
        >
          <span>+</span>
          {{ createLabel }} “{{ normalizedQuery }}”
        </button>
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
    validator: value => ['toolbar', 'field', 'card', 'quiet', 'property', 'row'].includes(value),
  },
  menuMinWidth: { type: Number, default: 148 },
  chevron: { type: Boolean, default: true },
  createLabel: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'change', 'create'])
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
        icon: option.icon || null,
        disabled: Boolean(option.disabled),
        separatorAfter: Boolean(option.separatorAfter),
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
const normalizedQuery = computed(() => query.value.trim())
const canCreate = computed(() => (
  Boolean(props.createLabel && normalizedQuery.value)
  && !normalizedOptions.value.some(option => (
    option.label.trim().localeCompare(normalizedQuery.value, undefined, { sensitivity: 'accent' }) === 0
  ))
))

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

function createFromQuery() {
  if (!canCreate.value) return
  const value = normalizedQuery.value
  emit('create', value)
  close({ restoreFocus: true })
}

function positionMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.max(rect.width, props.menuMinWidth)
  const estimatedHeight = Math.min(
    props.searchable ? 292 : 252,
    filteredOptions.value.length * 32
      + filteredOptions.value.filter(option => option.separatorAfter).length * 9
      + (canCreate.value ? 34 : 0)
      + (props.searchable ? 40 : 8),
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
    event.preventDefault()
    const target = adjacentFocusTarget(event.shiftKey)
    close()
    void nextTick(() => {
      if (target?.isConnected) target.focus()
      else trigger.value?.focus()
    })
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

function adjacentFocusTarget(reverse = false) {
  const focusable = [...document.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter(element => !menu.value?.contains(element))
  const index = focusable.indexOf(trigger.value)
  if (index < 0) return trigger.value
  return focusable[index + (reverse ? -1 : 1)] || trigger.value
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
  justify-content: space-between;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-weight: 520;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.graph-select-trigger:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-select-trigger:focus-visible {
  border-color: color-mix(in srgb, var(--color-accent) 70%, transparent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 22%, transparent);
  outline-offset: 1px;
}

.graph-select-trigger:disabled {
  opacity: 0.45;
}

.graph-select-toolbar {
  height: 30px;
  padding: 0 9px;
  border-color: var(--color-rule-light);
  background: var(--color-surface);
  font-size: 11px;
}

.graph-select-field {
  width: 100%;
  min-height: 32px;
  padding: 0 9px;
  border-color: var(--color-rule-light);
  background: var(--color-surface);
  font-size: 11px;
  color: var(--color-ink-2);
}

.graph-select-card {
  height: 28px;
  padding: 0 8px;
  background: transparent;
  font-size: 10px;
}

/* Ghost property control: borderless and transparent at rest, with a
   chrome-mid wash on hover and an accent ring on focus. */
.graph-select-quiet {
  min-height: 26px;
  padding: 0 5px;
  border-color: transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 560;
}

.graph-select-quiet:hover {
  background: var(--color-chrome-mid);
}

.graph-select-quiet[aria-expanded="true"] {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-select-property {
  min-height: 30px;
  padding: 0 8px;
  border-color: var(--color-rule-light);
  background: var(--color-chrome-high);
  font-size: 11px;
}

.graph-select-row {
  min-width: 0;
  height: 19px;
  padding: 0 3px;
  border-color: transparent;
  border-radius: 2px;
  background: transparent;
  color: inherit;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 520;
  font-variant-numeric: tabular-nums;
}

.graph-select-row:hover {
  border-color: var(--color-rule);
  background: var(--color-chrome-high);
}

.graph-select-menu {
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 3px;
  box-shadow: 0 10px 30px color-mix(in srgb, var(--color-ink) 16%, transparent);
}

.graph-select-search-wrap {
  margin: 0 0 3px;
  padding: 2px 2px 5px;
  border-bottom: 1px solid var(--color-rule-light);
}

.graph-select-search {
  width: 100%;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--color-chrome-high);
  padding: 0 10px 0 31px;
  color: var(--color-ink-2);
  font-size: 11px;
}

.graph-select-search::placeholder {
  color: var(--color-ink-4);
}

.graph-select-search:focus-visible {
  border-color: var(--color-accent);
  outline: none;
}

.graph-select-options {
  max-height: 264px;
  overflow-y: auto;
}

.graph-select-separator {
  height: 1px;
  margin: 4px 5px;
  background: var(--color-rule-light);
}

.graph-select-option {
  display: flex;
  min-height: 30px;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 2px;
  padding: 4px 6px;
  text-align: left;
}

.graph-select-option:hover,
.graph-select-option:focus-visible {
  background: var(--color-chrome-mid);
  outline: none;
}

.graph-select-option:disabled {
  opacity: 0.4;
}

.graph-select-check {
  display: grid;
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 3px;
  color: transparent;
}

.graph-select-check-active {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-rule));
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.graph-select-option-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  color: var(--color-ink-3);
}

.graph-select-option-label {
  display: block;
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-select-option-hint {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-select-create {
  display: flex;
  min-height: 32px;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--color-rule-light);
  padding: 5px 8px;
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
}

.graph-select-create:hover,
.graph-select-create:focus-visible {
  background: var(--color-chrome-mid);
  outline: none;
}

.graph-select-chevron {
  color: var(--color-ink-4);
  transition: transform 120ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .graph-select-chevron {
    transition: none;
  }
}
</style>
