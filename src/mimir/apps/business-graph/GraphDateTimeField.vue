<template>
  <div v-bind="$attrs" class="graph-datetime-field" :class="`datetime-${variant}`">
    <GraphDatePicker
      :model-value="datePart"
      :aria-label="`${ariaLabel} date`"
      :data-graph-control="`${controlId}-date`"
      :variant="variant"
      placeholder="No date"
      @update:model-value="updateDate"
    />
    <label>
      <IconClock :size="13" />
      <span class="sr-only">{{ ariaLabel }} time</span>
      <input
        v-model="timePart"
        :data-graph-control="`${controlId}-time`"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        maxlength="5"
        placeholder="09:00"
        :disabled="!datePart"
        :aria-label="`${ariaLabel} time`"
        @input="normalizeTime"
        @blur="commitTime"
        @keydown.enter.prevent="commitTime"
      />
    </label>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { IconClock } from '@tabler/icons-vue'
import GraphDatePicker from './GraphDatePicker.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Date and time' },
  controlId: { type: String, default: 'datetime' },
  variant: {
    type: String,
    default: 'field',
    validator: value => ['field', 'quiet'].includes(value),
  },
})

const emit = defineEmits(['update:modelValue', 'change'])
const datePart = ref('')
const timePart = ref('')

watch(() => props.modelValue, value => {
  const [date = '', time = ''] = String(value || '').split('T')
  datePart.value = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
  timePart.value = /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : ''
}, { immediate: true })

function updateDate(value) {
  datePart.value = value
  if (!value) {
    timePart.value = ''
    update('')
    return
  }
  if (!validTime(timePart.value)) timePart.value = '09:00'
  update(`${value}T${timePart.value}`)
}

function normalizeTime(event) {
  let digits = event.target.value.replaceAll(/\D/g, '').slice(0, 4)
  if (digits.length > 2) digits = `${digits.slice(0, 2)}:${digits.slice(2)}`
  timePart.value = digits
}

function commitTime() {
  if (!datePart.value) return
  if (!validTime(timePart.value)) {
    timePart.value = '09:00'
  }
  update(`${datePart.value}T${timePart.value}`)
}

function validTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59)
}

function update(value) {
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<style scoped>
.graph-datetime-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px;
  gap: 4px;
}

.graph-datetime-field > label {
  position: relative;
  display: flex;
  height: 32px;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-rule-light);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink-4);
}

.graph-datetime-field > label:focus-within {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 23%, transparent);
  outline-offset: 1px;
}

/* Ghost variant: borderless property control beside the quiet date picker. */
.graph-datetime-field.datetime-quiet {
  grid-template-columns: minmax(0, 1fr) 76px;
}

.graph-datetime-field.datetime-quiet > label {
  height: 26px;
  border-color: transparent;
  border-radius: 2px;
  background: transparent;
  padding: 0 5px;
}

.graph-datetime-field.datetime-quiet > label:hover {
  background: var(--color-chrome-mid);
}

.graph-datetime-field.datetime-quiet > label:focus-within {
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: var(--color-surface);
}

.graph-datetime-field input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-ink-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.graph-datetime-field input::placeholder {
  color: var(--color-ink-4);
}

.graph-datetime-field input:disabled {
  opacity: 0.4;
}
</style>
