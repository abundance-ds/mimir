<template>
  <button
    type="button"
    class="group relative flex h-9 w-full items-center text-left text-ink-2 hover:bg-chrome-mid hover:text-ink"
    :class="{ 'bg-accent-soft text-ink': active }"
    :aria-current="active ? 'page' : undefined"
  >
    <span
      v-if="active"
      class="absolute inset-y-1 left-0 w-0.5 bg-accent"
      aria-hidden="true"
    />
    <span class="ml-3 grid size-7 shrink-0 place-items-center">
      <slot />
    </span>
    <span
      :data-sidebar-copy="copyId || undefined"
      class="ml-2 flex min-w-0 flex-1 items-center gap-2 pr-2"
      :class="{ 'pointer-events-none invisible': collapsed }"
      :aria-hidden="collapsed"
    >
      <span class="min-w-0 flex-1 truncate text-[11px] font-medium">
        {{ label }}
      </span>
      <span v-if="meta" class="shrink-0 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">
        {{ meta }}
      </span>
    </span>
  </button>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  meta: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  copyId: { type: String, default: '' },
})
</script>
