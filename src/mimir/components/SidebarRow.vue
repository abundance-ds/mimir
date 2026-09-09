<template>
  <div
    class="group relative flex h-8 w-full items-center text-left text-ink-2 hover:bg-chrome-mid hover:text-ink"
    :class="{
      'bg-accent-soft text-ink': active || selected,
      'text-ink-4': muted && !active && !selected,
    }"
    :data-selected="selected ? 'true' : undefined"
    @click="$emit('click', $event)"
  >
    <component
      :is="editing ? 'div' : 'button'"
      :type="editing ? undefined : 'button'"
      class="flex h-full min-w-0 flex-1 items-center text-left"
      :aria-label="editing ? undefined : ariaLabel || (collapsed ? label : undefined)"
      :aria-current="!editing && active ? 'page' : undefined"
      :aria-pressed="!editing && selected ? 'true' : undefined"
      :aria-disabled="editing ? undefined : $attrs['aria-disabled']"
      :aria-expanded="editing ? undefined : ariaExpanded"
      :aria-haspopup="editing ? undefined : ariaHaspopup || undefined"
      :aria-controls="editing ? undefined : ariaControls || undefined"
      :title="editing ? undefined : $attrs.title"
    >
      <span class="ml-[12px] grid size-[28px] shrink-0 place-items-center">
        <slot />
      </span>
      <span
        :data-sidebar-copy="copyId || undefined"
        class="ml-2 flex min-w-0 flex-1 items-center gap-2"
        :class="[
          $slots.trailing ? 'pr-1' : 'pr-3',
          { 'pointer-events-none invisible': collapsed },
        ]"
        :aria-hidden="collapsed"
      >
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium">
          <slot name="label">{{ label }}</slot>
        </span>
        <span
          v-if="$slots.meta || meta"
          data-sidebar-meta
          class="shrink-0 font-mono text-[9px] text-ink-3"
          :class="{ 'uppercase tracking-[0.06em]': !$slots.meta }"
        >
          <slot name="meta">{{ meta }}</slot>
        </span>
      </span>
    </component>
    <span
      v-if="$slots.trailing && !collapsed"
      class="mr-1 shrink-0"
    >
      <slot name="trailing" />
    </span>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  ariaLabel: { type: String, default: '' },
  meta: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  editing: { type: Boolean, default: false },
  copyId: { type: String, default: '' },
  muted: { type: Boolean, default: false },
  ariaExpanded: { type: [Boolean, String], default: undefined },
  ariaHaspopup: { type: String, default: '' },
  ariaControls: { type: String, default: '' },
})

defineEmits(['click'])
</script>
