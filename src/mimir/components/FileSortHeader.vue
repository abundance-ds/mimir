<template>
  <button
    type="button"
    :data-file-sort-header="sortKey"
    :data-file-sort-active="active ? '' : undefined"
    :aria-pressed="active"
    :aria-label="accessibleLabel"
    :title="accessibleLabel"
    class="flex h-full min-w-0 items-center gap-0.5 font-mono text-[9px] outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    :class="[
      active ? 'text-ink' : 'text-ink-4',
      align === 'right' ? 'justify-end text-right' : align === 'center' ? 'justify-center' : 'justify-start text-left',
      inset ? 'pl-3 pr-1' : 'px-1',
    ]"
    @click="$emit('sort')"
  >
    <slot>
      <span class="truncate">{{ label }}</span>
    </slot>
    <component
      :is="direction === 'desc' ? IconChevronDown : IconChevronUp"
      v-if="active"
      data-file-sort-arrow
      aria-hidden="true"
      :size="9"
      :stroke-width="2.2"
      class="shrink-0 text-accent"
    />
    <span v-else aria-hidden="true" class="block size-[9px] shrink-0" />
  </button>
</template>

<script setup>
import { computed } from 'vue'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-vue'

const props = defineProps({
  sortKey: { type: String, required: true },
  label: { type: String, required: true },
  active: { type: Boolean, default: false },
  direction: { type: String, default: 'asc' },
  directionLabel: { type: String, required: true },
  align: { type: String, default: 'left' },
  inset: { type: Boolean, default: false },
})

defineEmits(['sort'])

const accessibleLabel = computed(() => (
  props.active
    ? `${props.label}, ${props.directionLabel}. Select to reverse the order.`
    : `Sort by ${props.label}, ${props.directionLabel}.`
))
</script>
