<template>
  <button
    type="button"
    :data-pane-restore="pane"
    :title="`Restore ${title}`"
    class="absolute inset-0 z-30 flex h-full w-full flex-col items-center gap-3 overflow-hidden bg-chrome py-3 text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    @click="$emit('restore')"
  >
    <span
      v-if="meta"
      class="size-1.5 shrink-0 rounded-full bg-accent"
      aria-hidden="true"
    />
    <span class="truncate font-mono text-[9px] uppercase tracking-[0.16em] [writing-mode:vertical-rl]">
      {{ title }}
    </span>
    <span
      v-if="meta"
      class="truncate font-mono text-[9px] text-ink-4 [writing-mode:vertical-rl]"
    >
      {{ meta }}
    </span>
  </button>
</template>

<script setup>
defineProps({
  pane: {
    type: String,
    required: true,
    validator: (value) => ['activity', 'editor'].includes(value),
  },
  title: { type: String, required: true },
  meta: { type: String, default: '' },
})

defineEmits(['restore'])
</script>
