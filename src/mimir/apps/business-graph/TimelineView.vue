<template>
  <div data-graph-timeline class="timeline">
    <section v-for="group in groups" :key="group.key" class="timeline-group">
      <time class="timeline-month">{{ group.label }}</time>
      <button
        v-for="node in group.nodes"
        :key="node.id"
        type="button"
        :data-timeline-node="node.id"
        :data-graph-control="`timeline-open-${node.id}`"
        class="timeline-item"
        @click="$emit('open', node.id)"
      >
        <span class="timeline-kind">{{ human(node.kind) }}</span>
        <strong>{{ node.title || node.id }}</strong>
        <span v-if="node.summary" class="timeline-summary">{{ node.summary }}</span>
        <span v-if="node.status" class="timeline-state" :class="stateClass(node.status)">
          {{ human(node.status) }}
        </span>
        <span class="timeline-date">{{ shortDate(node.updatedAt) }}</span>
      </button>
    </section>

    <div v-if="!groups.length" class="timeline-empty">
      <h2>No dated activity in these scopes</h2>
      <p>Items will appear here as their Markdown sources are created and updated.</p>
      <button
        type="button"
        data-graph-control="timeline-empty-create"
        @click="$emit('create')"
      >
        Create an item
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
})

defineEmits(['open', 'create'])
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
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)
}

function stateClass(status) {
  return status === 'waiting' ? 'state-waiting' : ''
}

function shortDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}.${month}`
}

function human(value) {
  if (value === 'timesheet') return 'time sheet'
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.timeline {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  background: var(--color-surface);
}

.timeline-month {
  position: sticky;
  top: 0;
  z-index: 1;
  display: block;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 5px 13px 4px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.timeline-item {
  display: grid;
  width: 100%;
  min-height: 34px;
  grid-template-columns: 84px minmax(220px, 1fr) minmax(140px, 0.7fr) auto 42px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 13px;
  text-align: left;
}

.timeline-item:hover,
.timeline-item:focus-visible {
  background: var(--color-chrome-mid);
}

.timeline-item:hover strong {
  color: var(--color-ink);
}

.timeline-kind {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.timeline-item strong {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-summary {
  overflow: hidden;
  color: var(--color-ink-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-state {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
}

.timeline-state.state-waiting {
  color: var(--color-ink);
  font-weight: 650;
}

.timeline-date {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.timeline-empty {
  display: grid;
  min-height: 300px;
  place-content: center;
  justify-items: center;
  text-align: center;
}

.timeline-empty h2 {
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.timeline-empty p {
  max-width: 380px;
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.5;
}

.timeline-empty button {
  min-height: 34px;
  margin-top: 16px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
}

.timeline-empty button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 700px) {
  .timeline-summary {
    display: none;
  }

  .timeline-item {
    grid-template-columns: 72px minmax(140px, 1fr) auto 40px;
  }
}
</style>
