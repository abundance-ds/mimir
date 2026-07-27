<template>
  <div data-graph-timeline class="timeline">
    <section v-for="group in groups" :key="group.key" class="timeline-group">
      <time>{{ group.label }}</time>
      <div class="timeline-items">
        <button
          v-for="node in group.nodes"
          :key="node.id"
          type="button"
          :data-timeline-node="node.id"
          :data-graph-control="`timeline-open-${node.id}`"
          class="timeline-item"
          @click="$emit('open', node.id)"
        >
          <span class="timeline-node" :class="kindClass(node.kind)" aria-hidden="true" />
          <span class="timeline-copy">
            <small>{{ human(node.kind) }}</small>
            <strong>{{ node.title || node.id }}</strong>
            <span v-if="node.summary">{{ node.summary }}</span>
            <span v-else class="timeline-id">{{ node.id }}</span>
          </span>
          <span v-if="node.status" class="timeline-state" :class="stateClass(node.status)">
            {{ human(node.status) }}
          </span>
          <IconArrowUpRight :size="14" class="timeline-open-icon" aria-hidden="true" />
        </button>
      </div>
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
import { IconArrowUpRight } from '@tabler/icons-vue'

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

function kindClass(kind) {
  if (kind === 'issue') return 'node-work'
  if (kind === 'project') return 'node-project'
  if (['person', 'company'].includes(kind)) return 'node-business'
  return 'node-knowledge'
}

function stateClass(status) {
  return {
    'in-progress': 'state-active',
    waiting: 'state-attention',
    done: 'state-done',
  }[status] || ''
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.timeline {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 18px clamp(14px, 3cqw, 28px) 44px;
}

.timeline-group {
  display: grid;
  grid-template-columns: 122px minmax(0, 760px);
  gap: 25px;
  justify-content: center;
}

.timeline-group > time {
  position: sticky;
  top: 16px;
  align-self: start;
  padding-top: 14px;
  color: var(--color-ink-3);
  font-size: 11px;
  font-weight: 630;
  text-align: right;
}

.timeline-items {
  position: relative;
  padding: 0 0 22px 22px;
}

.timeline-items::before {
  position: absolute;
  inset: 0 auto 0 5px;
  width: 1px;
  background: var(--color-rule);
  content: "";
}

.timeline-item {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 74px;
  grid-template-columns: minmax(0, 1fr) auto 20px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 10px 8px;
  text-align: left;
}

.timeline-item:hover {
  background: color-mix(in srgb, var(--color-surface) 62%, transparent);
}

.timeline-item:focus-visible {
  border-radius: 6px;
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 1px;
}

.timeline-node {
  position: absolute;
  top: 29px;
  left: -21px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--color-chrome-high);
  border-radius: 50%;
  background: var(--color-ink-4);
  box-shadow: 0 0 0 1px var(--color-rule);
}

.timeline-node.node-work {
  background: var(--color-accent);
}

.timeline-node.node-project {
  background: var(--color-add);
}

.timeline-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.timeline-copy small {
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 620;
  letter-spacing: 0.055em;
  text-transform: uppercase;
}

.timeline-copy strong {
  overflow: hidden;
  margin-top: 4px;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-copy > span {
  overflow: hidden;
  margin-top: 3px;
  color: var(--color-ink-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-copy .timeline-id {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.timeline-state {
  padding: 0;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 620;
  text-transform: capitalize;
}

.timeline-state.state-active {
  color: var(--color-accent);
}

.timeline-state.state-attention {
  color: var(--color-rem);
}

.timeline-state.state-done {
  color: var(--color-add);
}

.timeline-open-icon {
  color: var(--color-ink-4);
}

.timeline-empty {
  display: grid;
  min-height: 300px;
  place-content: center;
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
  border-radius: 5px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
}

.timeline-empty button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 600px) {
  .timeline-group {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .timeline-group > time {
    position: static;
    padding: 14px 0 2px 22px;
    text-align: left;
  }
}
</style>
