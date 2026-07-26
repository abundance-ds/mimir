<template>
  <section :data-app-settings-group="label.toLowerCase().replaceAll(' ', '-')">
    <header class="flex h-8 items-center border-b border-rule-light bg-chrome px-4">
      <span class="font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-ink-2">{{ label }}</span>
      <span class="ml-2 font-mono text-[8px] text-ink-4">{{ detail }}</span>
      <span class="ml-auto font-mono text-[8px] tabular-nums text-ink-4">{{ apps.length }}</span>
    </header>
    <button
      v-for="app in apps"
      :key="app.id"
      type="button"
      :data-app-settings-row="app.id"
      :aria-current="app.id === selectedId ? 'true' : undefined"
      class="group grid min-h-12 w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule-light border-l-2 border-l-transparent px-4 py-2 text-left hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :class="{ 'border-l-accent bg-accent-soft': app.id === selectedId }"
      @click="$emit('select', app)"
      @dblclick="$emit('launch', app)"
    >
      <span class="grid size-7 place-items-center border border-rule bg-surface text-ink-3 group-hover:text-ink">
        <component :is="iconFor(app)" :size="13" :stroke-width="1.6" />
      </span>
      <span class="min-w-0">
        <span class="flex items-center gap-2">
          <span class="truncate text-[10.5px] font-semibold text-ink">{{ app.title }}</span>
          <span v-if="app.tools?.length" class="font-mono text-[7px] uppercase tracking-[0.1em] text-accent">
            {{ app.tools.length }} {{ app.tools.length === 1 ? 'tool' : 'tools' }}
          </span>
        </span>
        <span class="mt-0.5 block truncate text-[9px] text-ink-3">{{ app.description || app.id }}</span>
      </span>
      <span class="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">{{ modeLabel(app.mode) }}</span>
    </button>
  </section>
</template>

<script setup>
import {
  IconBolt,
  IconCode,
  IconExternalLink,
  IconFocus2,
  IconTerminal2,
  IconTool,
  IconWindow,
} from '@tabler/icons-vue'

defineProps({
  label: { type: String, required: true },
  detail: { type: String, default: '' },
  apps: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
})

defineEmits(['select', 'launch'])

function iconFor(app) {
  if (app.id === 'scratch') return IconFocus2
  return {
    embedded: IconCode,
    terminal: IconTerminal2,
    process: IconTool,
    window: IconWindow,
    'rust-helper': IconBolt,
    action: IconExternalLink,
  }[app.mode] || IconCode
}

function modeLabel(mode) {
  return {
    embedded: 'View',
    terminal: 'TTY',
    process: 'Process',
    window: 'Window',
    'rust-helper': 'Native',
    action: 'Action',
  }[mode] || mode
}
</script>
