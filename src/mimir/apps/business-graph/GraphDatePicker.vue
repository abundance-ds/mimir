<template>
  <DatePicker
    v-bind="$attrs"
    :model-value="modelValue"
    :aria-label="ariaLabel"
    :placeholder="placeholder"
    :variant="variant"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  >
    <template v-if="$slots.trigger" #trigger="slotProps">
      <slot name="trigger" v-bind="slotProps" />
    </template>
  </DatePicker>
</template>

<script setup>
import DatePicker from '../../../shared/ui/DatePicker.vue'

defineOptions({ inheritAttrs: false })

defineProps({
  modelValue: { type: String, default: '' },
  ariaLabel: { type: String, required: true },
  placeholder: { type: String, default: 'No date' },
  variant: {
    type: String,
    default: 'field',
    validator: value => ['field', 'icon', 'row', 'quiet'].includes(value),
  },
})

const emit = defineEmits(['update:modelValue', 'change'])
</script>
