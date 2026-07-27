<template>
  <button
    ref="trigger"
    v-bind="$attrs"
    type="button"
    class="graph-date-trigger"
    :class="`graph-date-${variant}`"
    :aria-label="ariaLabel"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :disabled="$attrs.disabled"
    @click="toggle"
  >
    <IconCalendar v-if="variant !== 'row'" :size="variant === 'icon' ? 14 : 13" />
    <span v-if="variant !== 'icon'">{{ displayValue }}</span>
    <IconChevronDown v-if="variant === 'field'" :size="11" class="ml-auto" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      data-graph-date-popover
      class="graph-date-popover"
      :style="popoverStyle"
      role="dialog"
      :aria-label="ariaLabel"
      @keydown.esc.prevent.stop="close(true)"
    >
      <header>
        <button
          type="button"
          data-graph-control="date-previous-month"
          aria-label="Previous month"
          @click="moveMonth(-1)"
        >
          <IconChevronLeft :size="14" />
        </button>
        <strong>{{ monthLabel }}</strong>
        <button
          type="button"
          data-graph-control="date-next-month"
          aria-label="Next month"
          @click="moveMonth(1)"
        >
          <IconChevronRight :size="14" />
        </button>
      </header>

      <div class="graph-date-weekdays" aria-hidden="true">
        <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
      </div>
      <div class="graph-date-grid" role="grid">
        <span v-for="index in leadingBlanks" :key="`blank:${index}`" />
        <button
          v-for="day in daysInMonth"
          :key="day"
          type="button"
          role="gridcell"
          :data-date-value="dateValue(day)"
          :aria-label="dayLabel(day)"
          :aria-selected="dateValue(day) === modelValue"
          :class="{
            selected: dateValue(day) === modelValue,
            today: dateValue(day) === todayValue,
          }"
          @click="choose(day)"
          @keydown="onDayKeydown($event, day)"
        >
          {{ day }}
        </button>
      </div>

      <footer>
        <button
          type="button"
          data-graph-control="date-clear"
          :disabled="!modelValue"
          @click="clear"
        >
          Clear
        </button>
        <button
          type="button"
          data-graph-control="date-today"
          @click="chooseToday"
        >
          Today
        </button>
      </footer>
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
} from 'vue'
import {
  IconCalendar,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: String, default: '' },
  ariaLabel: { type: String, required: true },
  placeholder: { type: String, default: 'No date' },
  variant: {
    type: String,
    default: 'field',
    validator: value => ['field', 'icon', 'row'].includes(value),
  },
})

const emit = defineEmits(['update:modelValue', 'change'])
const attrs = useAttrs()
const trigger = ref(null)
const popover = ref(null)
const open = ref(false)
const month = ref(startMonth(props.modelValue))
const popoverStyle = ref({})
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const todayValue = toDateValue(new Date())

const displayValue = computed(() => {
  if (!props.modelValue) return props.placeholder
  const date = parseDate(props.modelValue)
  if (!date) return props.modelValue
  if (props.variant === 'row') {
    return new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      month: '2-digit',
    }).format(date)
  }
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
})
const monthLabel = computed(() => new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
}).format(month.value))
const daysInMonth = computed(() => (
  new Date(month.value.getFullYear(), month.value.getMonth() + 1, 0).getDate()
))
const leadingBlanks = computed(() => {
  const firstDay = new Date(month.value.getFullYear(), month.value.getMonth(), 1).getDay()
  return (firstDay + 6) % 7
})

async function toggle() {
  if (attrs.disabled) return
  if (open.value) {
    close()
    return
  }
  month.value = startMonth(props.modelValue)
  open.value = true
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  await nextTick()
  position()
  popover.value?.querySelector('[aria-selected="true"], .today')?.focus()
}

function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('resize', position)
  window.removeEventListener('scroll', position, true)
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function position() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = 286
  const height = 338
  const gap = 6
  const openAbove = window.innerHeight - rect.bottom < height + gap && rect.top > height
  const top = openAbove ? rect.top - height - gap : rect.bottom + gap
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, window.innerWidth - width - 8),
  )
  popoverStyle.value = {
    top: `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`,
    left: `${left}px`,
  }
}

function moveMonth(offset) {
  month.value = new Date(month.value.getFullYear(), month.value.getMonth() + offset, 1)
}

function choose(day) {
  update(dateValue(day))
}

function chooseToday() {
  update(todayValue)
}

async function onDayKeydown(event, day) {
  const offsets = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -7,
    ArrowDown: 7,
  }
  if (event.key in offsets) {
    const target = day + offsets[event.key]
    if (target < 1 || target > daysInMonth.value) return
    event.preventDefault()
    focusDay(target)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusDay(event.key === 'Home' ? 1 : daysInMonth.value)
    return
  }
  if (event.key === 'PageUp' || event.key === 'PageDown') {
    event.preventDefault()
    moveMonth(event.key === 'PageUp' ? -1 : 1)
    await nextTick()
    focusDay(Math.min(day, daysInMonth.value))
  }
}

function focusDay(day) {
  popover.value?.querySelector(`[data-date-value="${dateValue(day)}"]`)?.focus()
}

function clear() {
  update('')
}

function update(value) {
  emit('update:modelValue', value)
  emit('change', value)
  close(true)
}

function dateValue(day) {
  return toDateValue(new Date(month.value.getFullYear(), month.value.getMonth(), day))
}

function dayLabel(day) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(month.value.getFullYear(), month.value.getMonth(), day))
}

function startMonth(value) {
  const date = parseDate(value) || new Date()
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function toDateValue(date) {
  const year = date.getFullYear()
  const monthValue = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${monthValue}-${day}`
}

function onDocumentPointerDown(event) {
  if (trigger.value?.contains(event.target) || popover.value?.contains(event.target)) return
  close()
}

onUnmounted(close)
</script>

<style scoped>
.graph-date-trigger {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 520;
}

.graph-date-trigger:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-date-trigger:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 23%, transparent);
  outline-offset: 1px;
}

.graph-date-field {
  width: 100%;
  min-height: 37px;
  padding: 0 10px;
}

.graph-date-icon {
  width: 29px;
  height: 28px;
  justify-content: center;
  border-color: transparent;
  background: transparent;
  color: var(--color-ink-4);
}

.graph-date-row {
  width: auto;
  min-width: 34px;
  height: 18px;
  justify-content: flex-start;
  border-color: transparent;
  background: transparent;
  padding: 0 2px;
  color: inherit;
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.graph-date-row:hover {
  border-color: var(--color-rule);
  background: var(--color-chrome-high);
}

.graph-date-trigger:disabled {
  opacity: 0.42;
}

.graph-date-popover {
  position: fixed;
  z-index: 190;
  width: 286px;
  min-height: 338px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 9px;
  color: var(--color-ink);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--color-ink) 16%, transparent);
}

.graph-date-popover > header {
  display: grid;
  min-height: 38px;
  grid-template-columns: 34px 1fr 34px;
  align-items: center;
}

.graph-date-popover header button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-3);
}

.graph-date-popover header button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-date-popover header strong {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 650;
  text-align: center;
}

.graph-date-weekdays,
.graph-date-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.graph-date-weekdays {
  margin-top: 7px;
}

.graph-date-weekdays span {
  display: grid;
  height: 24px;
  place-items: center;
  color: var(--color-ink-4);
  font-size: 10px;
  font-weight: 620;
}

.graph-date-grid button,
.graph-date-grid > span {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
}

.graph-date-grid button {
  border-radius: 5px;
  color: var(--color-ink-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.graph-date-grid button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-date-grid button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  outline-offset: -1px;
}

.graph-date-grid button.today {
  color: var(--color-accent);
  font-weight: 700;
}

.graph-date-grid button.selected {
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
  font-weight: 700;
}

.graph-date-popover > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  border-top: 1px solid var(--color-rule-light);
  padding: 8px 4px 0;
}

.graph-date-popover footer button {
  min-height: 30px;
  border-radius: 5px;
  padding: 0 8px;
  color: var(--color-ink-3);
  font-size: 10px;
  font-weight: 620;
}

.graph-date-popover footer button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.graph-date-popover footer button:last-child {
  color: var(--color-accent);
}

.graph-date-popover footer button:disabled {
  opacity: 0.35;
}
</style>
