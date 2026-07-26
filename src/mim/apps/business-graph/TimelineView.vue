<template>
  <div data-graph-timeline class="min-h-0 flex-1 overflow-y-auto bg-chrome-high p-3">
    <section
      v-for="group in groups"
      :key="group.key"
      class="grid grid-cols-[72px_minmax(0,1fr)] gap-3"
    >
      <div class="border-r border-rule pr-3 text-right">
        <div class="sticky top-2 font-mono text-[7px] uppercase tracking-[0.1em] text-ink-4">
          {{ group.label }}
        </div>
      </div>
      <div class="space-y-1.5 pb-4">
        <button
          v-for="node in group.nodes"
          :key="node.id"
          type="button"
          :data-timeline-node="node.id"
          class="relative flex min-h-10 w-full items-center gap-2 border border-rule-light bg-surface px-2.5 text-left hover:border-rule hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('open', node.id)"
        >
          <span class="absolute -left-[18px] size-2 rounded-full border-2 border-chrome-high bg-accent" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[9px] font-semibold text-ink-2">{{ node.title || node.id }}</span>
            <span class="block truncate font-mono text-[7px] text-ink-4">
              {{ node.kind }} · {{ node.id }}
            </span>
          </span>
          <span v-if="node.status" class="font-mono text-[7px] text-ink-3">{{ human(node.status) }}</span>
          <IconChevronRight :size="11" class="text-ink-4" />
        </button>
      </div>
    </section>
    <div v-if="!groups.length" class="grid min-h-56 place-items-center text-[9px] text-ink-4">
      No dated graph activity in these scopes.
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { IconChevronRight } from '@tabler/icons-vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
})

defineEmits(['open'])
const groups = computed(() => {
  const values = new Map()
  for (const node of [...props.nodes].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    const key = monthKey(node.updatedAt)
    if (!values.has(key)) values.set(key, [])
    values.get(key).push(node)
  }
  return [...values.entries()].map(([key, nodes]) => ({
    key,
    label: monthLabel(key),
    nodes,
  }))
})

function monthKey(value) {
  return /^\d{4}-\d{2}/.test(value || '') ? value.slice(0, 7) : 'unknown'
}

function monthLabel(key) {
  if (key === 'unknown') return 'Undated'
  const date = new Date(`${key}-01T00:00:00`)
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(date)
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>
