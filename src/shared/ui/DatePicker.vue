<template>
  <button
    ref="trigger"
    v-bind="$attrs"
    type="button"
    class="date-picker-trigger graph-date-trigger"
    :class="[`date-picker-${variant}`, `graph-date-${variant}`]"
    :aria-label="ariaLabel"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :disabled="attrs.disabled"
    @click="toggle"
  >
    <slot name="trigger" :display-value="displayValue">
      <IconCalendar v-if="variant !== 'row'" :size="variant === 'icon' ? 14 : variant === 'quiet' ? 12 : 13" />
      <span v-if="variant !== 'icon'">{{ displayValue }}</span>
      <IconChevronDown v-if="variant === 'field'" :size="11" class="ml-auto" />
    </slot>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      data-date-picker-popover
      data-graph-date-popover
      class="date-picker-popover graph-date-popover"
      :class="{ 'date-picker-no-footer': !showFooter }"
      :style="popoverStyle"
      role="dialog"
      :aria-label="ariaLabel"
      @keydown.esc.prevent.stop="close(true)"
    >
      <header>
        <button
          type="button"
          data-date-picker-control="previous-month"
          data-graph-control="date-previous-month"
          aria-label="Previous month"
          :disabled="!canMoveMonth(-1)"
          @click="moveMonth(-1)"
        >
          <IconChevronLeft :size="14" />
        </button>
        <strong>{{ monthLabel }}</strong>
        <button
          type="button"
          data-date-picker-control="next-month"
          data-graph-control="date-next-month"
          aria-label="Next month"
          :disabled="!canMoveMonth(1)"
          @click="moveMonth(1)"
        >
          <IconChevronRight :size="14" />
        </button>
      </header>

      <div class="date-picker-weekdays graph-date-weekdays" aria-hidden="true">
        <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
      </div>
      <div class="date-picker-grid graph-date-grid" role="grid">
        <span v-for="index in leadingBlanks" :key="`blank:${index}`" />
        <button
          v-for="day in daysInMonth"
          :key="day"
          type="button"
          role="gridcell"
          :data-date-value="dateValue(day)"
          :data-day-state="dayStateValue(day) || undefined"
          :aria-label="dayLabel(day)"
          :aria-selected="dateValue(day) === modelValue"
          :aria-disabled="isDayDisabled(day) || undefined"
          :disabled="isDayDisabled(day)"
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

      <footer v-if="showFooter">
        <button
          type="button"
          data-date-picker-control="clear"
          data-graph-control="date-clear"
          :disabled="!modelValue"
          @click="clear"
        >
          Clear
        </button>
        <button
          type="button"
          data-date-picker-control="today"
          data-graph-control="date-today"
          :disabled="!withinRange(todayValue)"
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
    validator: value => ['field', 'icon', 'row', 'quiet', 'custom'].includes(value),
  },
  min: { type: String, default: '' },
  max: { type: String, default: '' },
  showFooter: { type: Boolean, default: true },
  placement: {
    type: String,
    default: 'auto',
    validator: value => ['auto', 'top-start', 'top-end', 'bottom-start', 'bottom-end'].includes(value),
  },
  dayState: { type: Function, default: null },
  describeDay: { type: Function, default: null },
})

const emit = defineEmits(['update:modelValue', 'change', 'month-change'])
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
    const day = String(date.getDate()).padStart(2, '0')
    const monthValue = String(date.getMonth() + 1).padStart(2, '0')
    return `${day}.${monthValue}`
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
  emitMonthChange()
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  await nextTick()
  position()
  const initialDay = popover.value?.querySelector('[aria-selected="true"]')
    || popover.value?.querySelector('.today')
    || popover.value?.querySelector('.date-picker-grid button:not(:disabled)')
  initialDay?.focus()
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
  const triggerRect = trigger.value?.getBoundingClientRect()
  if (!triggerRect) return
  const measured = popover.value?.getBoundingClientRect()
  const width = measured?.width || 286
  const height = measured?.height || (props.showFooter ? 338 : 302)
  const gap = 6
  const spaceBelow = window.innerHeight - triggerRect.bottom
  const openAbove = props.placement.startsWith('top')
    || (props.placement === 'auto' && spaceBelow < height + gap && triggerRect.top > height)
  const top = openAbove ? triggerRect.top - height - gap : triggerRect.bottom + gap
  const alignEnd = props.placement.endsWith('end')
  const naturalLeft = alignEnd ? triggerRect.right - width : triggerRect.left
  const left = Math.min(
    Math.max(8, naturalLeft),
    Math.max(8, window.innerWidth - width - 8),
  )
  popoverStyle.value = {
    top: `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`,
    left: `${left}px`,
  }
}

function moveMonth(offset) {
  if (!canMoveMonth(offset)) return
  month.value = monthAtOffset(offset)
  emitMonthChange()
  void nextTick(position)
}

function monthAtOffset(offset) {
  return new Date(month.value.getFullYear(), month.value.getMonth() + offset, 1)
}

function canMoveMonth(offset) {
  const candidate = monthAtOffset(offset)
  const first = toDateValue(candidate)
  const last = toDateValue(new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0))
  return (!props.min || last >= props.min) && (!props.max || first <= props.max)
}

function choose(day) {
  if (isDayDisabled(day)) return
  update(dateValue(day))
}

function chooseToday() {
  if (!withinRange(todayValue)) return
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
    if (target < 1 || target > daysInMonth.value || isDayDisabled(target)) return
    event.preventDefault()
    focusDay(target)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    focusBoundaryDay(event.key === 'Home' ? 1 : -1)
    return
  }
  if (event.key === 'PageUp' || event.key === 'PageDown') {
    const offset = event.key === 'PageUp' ? -1 : 1
    if (!canMoveMonth(offset)) return
    event.preventDefault()
    moveMonth(offset)
    await nextTick()
    focusClosestDay(Math.min(day, daysInMonth.value))
  }
}

function focusBoundaryDay(direction) {
  const start = direction > 0 ? 1 : daysInMonth.value
  focusClosestDay(start, direction)
}

function focusClosestDay(day, preferredDirection = -1) {
  if (!isDayDisabled(day)) {
    focusDay(day)
    return
  }
  for (let distance = 1; distance < daysInMonth.value; distance += 1) {
    const preferred = day + (distance * preferredDirection)
    const alternate = day - (distance * preferredDirection)
    if (preferred >= 1 && preferred <= daysInMonth.value && !isDayDisabled(preferred)) {
      focusDay(preferred)
      return
    }
    if (alternate >= 1 && alternate <= daysInMonth.value && !isDayDisabled(alternate)) {
      focusDay(alternate)
      return
    }
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

function isDayDisabled(day) {
  return !withinRange(dateValue(day))
}

function withinRange(value) {
  return (!props.min || value >= props.min) && (!props.max || value <= props.max)
}

function dayStateValue(day) {
  return String(props.dayState?.(dateValue(day)) || '')
}

function dayLabel(day) {
  const value = dateValue(day)
  const base = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(month.value.getFullYear(), month.value.getMonth(), day))
  const description = props.describeDay?.(value, dayStateValue(day))
  return description ? `${base}, ${description}` : base
}

function emitMonthChange() {
  emit('month-change', toDateValue(month.value).slice(0, 7))
}

function startMonth(value) {
  const date = parseDate(value) || new Date()
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return !Number.isNaN(date.getTime()) && toDateValue(date) === value ? date : null
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
.date-picker-trigger {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-rule-light);
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 520;
}

.date-picker-trigger:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.date-picker-trigger:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 23%, transparent);
  outline-offset: 1px;
}

.date-picker-field {
  width: 100%;
  min-height: 32px;
  padding: 0 9px;
}

.date-picker-quiet {
  min-height: 26px;
  padding: 0 5px;
  border-color: transparent;
  border-radius: 2px;
  background: transparent;
  font-weight: 560;
}

.date-picker-quiet svg {
  color: var(--color-ink-4);
}

.date-picker-quiet:hover {
  background: var(--color-chrome-mid);
}

.date-picker-icon {
  width: 29px;
  height: 28px;
  justify-content: center;
  border-color: transparent;
  background: transparent;
  color: var(--color-ink-4);
}

.date-picker-row {
  width: auto;
  min-width: 34px;
  height: 19px;
  justify-content: flex-start;
  border-color: transparent;
  border-radius: 2px;
  background: transparent;
  padding: 0 2px;
  color: inherit;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.date-picker-row:hover {
  border-color: var(--color-rule);
  background: var(--color-chrome-high);
}

.date-picker-custom {
  justify-content: center;
  border-color: transparent;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: inherit;
  font: inherit;
}

.date-picker-trigger:disabled {
  opacity: 0.42;
}

.date-picker-popover {
  position: fixed;
  z-index: 260;
  width: 286px;
  min-height: 338px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 9px;
  color: var(--color-ink);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--color-ink) 16%, transparent);
}

.date-picker-popover.date-picker-no-footer {
  min-height: 302px;
}

.date-picker-popover > header {
  display: grid;
  min-height: 38px;
  grid-template-columns: 34px 1fr 34px;
  align-items: center;
}

.date-picker-popover header button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-3);
}

.date-picker-popover header button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.date-picker-popover header button:disabled {
  color: var(--color-ink-4);
  opacity: 0.35;
}

.date-picker-popover header strong {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 650;
  text-align: center;
}

.date-picker-weekdays,
.date-picker-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.date-picker-weekdays {
  margin-top: 7px;
}

.date-picker-weekdays span {
  display: grid;
  height: 24px;
  place-items: center;
  color: var(--color-ink-4);
  font-size: 10px;
  font-weight: 620;
}

.date-picker-grid button,
.date-picker-grid > span {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
}

.date-picker-grid button {
  border-radius: 3px;
  color: var(--color-ink-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.date-picker-grid button[data-day-state="empty"]:not(.selected):not(.today) {
  color: var(--color-ink-4);
}

.date-picker-grid button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.date-picker-grid button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  outline-offset: -1px;
}

.date-picker-grid button:disabled {
  color: var(--color-ink-4);
  opacity: 0.25;
}

.date-picker-grid button.today {
  color: var(--color-accent);
  font-weight: 700;
}

.date-picker-grid button.selected {
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
  font-weight: 700;
}

.date-picker-popover > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  border-top: 1px solid var(--color-rule-light);
  padding: 8px 4px 0;
}

.date-picker-popover footer button {
  min-height: 28px;
  border-radius: 3px;
  padding: 0 8px;
  color: var(--color-ink-3);
  font-size: 10px;
  font-weight: 620;
}

.date-picker-popover footer button:hover:not(:disabled) {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.date-picker-popover footer button:disabled {
  opacity: 0.35;
}

.date-picker-popover footer button:last-child {
  color: var(--color-accent);
}
</style>
