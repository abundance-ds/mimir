<template>
  <div
    class="group relative flex h-9 w-full items-center text-left text-ink-2 hover:bg-chrome-mid hover:text-ink"
    :class="{
      'bg-accent-soft text-ink': active,
      'text-ink-4': muted && !active,
    }"
    @click="$emit('click')"
  >
    <button
      type="button"
      class="flex h-full min-w-0 flex-1 items-center text-left"
      :aria-label="ariaLabel || (collapsed ? label : undefined)"
      :aria-current="active ? 'page' : undefined"
      :aria-disabled="$attrs['aria-disabled']"
      :title="$attrs.title"
    >
      <span class="ml-3 grid size-7 shrink-0 place-items-center">
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
        <span class="min-w-0 flex-1 truncate text-[11px] font-medium">
          <slot name="label">{{ label }}</slot>
        </span>
        <span
          v-if="meta"
          data-sidebar-meta
          class="shrink-0 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-4"
        >
          {{ meta }}
        </span>
      </span>
    </button>
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
  copyId: { type: String, default: '' },
  muted: { type: Boolean, default: false },
})

defineEmits(['click'])
</script>
