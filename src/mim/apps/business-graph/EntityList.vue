<template>
  <div class="entity-list-shell">
    <div
      data-graph-entity-list
      class="entity-list"
      tabindex="0"
      role="listbox"
      aria-label="Graph items"
      :aria-activedescendant="nodes[selection] ? `graph-list-option-${nodes[selection].id}` : undefined"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="openSelected"
    >
      <button
        v-for="(node, index) in nodes"
        :id="`graph-list-option-${node.id}`"
        :key="node.id"
        type="button"
        :data-graph-node="node.id"
        :data-graph-control="`list-open-${node.id}`"
        role="option"
        :aria-selected="index === selection"
        class="entity-row"
        :class="{ 'entity-row-selected': index === selection }"
        @mouseenter="selection = index"
        @click="$emit('open', node.id)"
      >
        <span class="entity-line-1">
          <component
            :is="priorityIcon(node.priority)"
            v-if="node.kind === 'issue'"
            :size="14"
            :stroke-width="2.1"
            class="entity-priority"
            :class="`priority-${node.priority || 'normal'}`"
            aria-hidden="true"
          />
          <strong>{{ node.title || node.id }}</strong>
        </span>
        <span class="entity-line-2">
          <template v-if="node.kind === 'issue'">
            <span class="entity-status" :class="stateClass(node.status)">
              {{ human(node.status || 'backlog') }}
            </span>
            <span v-if="projectLabel(node)" class="entity-project">{{ projectLabel(node) }}</span>
            <span v-if="node.dueDate" class="entity-due" :class="{ overdue: overdue(node.dueDate) }">
              {{ shortDate(node.dueDate) }}
            </span>
            <span v-if="overdue(node.dueDate)" class="entity-overdue">overdue</span>
            <span v-if="node.waitingFor" class="entity-waiting">waiting</span>
            <span v-if="actorInitials(node)" class="entity-author" :title="actorLabel(node)">
              {{ actorInitials(node) }}
            </span>
          </template>
          <template v-else>
            <span class="entity-kind">{{ human(node.kind) }}</span>
            <span v-if="node.summary" class="entity-summary">{{ node.summary }}</span>
            <span class="entity-updated">{{ shortDate(node.updatedAt) }}</span>
          </template>
        </span>
      </button>

      <div v-if="!nodes.length" class="entity-empty">
        <h2>{{ emptyTitle }}</h2>
        <p>{{ emptyCopy }}</p>
        <button
          type="button"
          data-graph-control="list-empty-create"
          @click="$emit('create')"
        >
          Create an item
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  IconAntennaBars2,
  IconAntennaBars3,
  IconAntennaBars4,
  IconExclamationMark,
} from '@tabler/icons-vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  actors: { type: Object, default: () => ({}) },
  emptyTitle: { type: String, default: 'Nothing here yet' },
  emptyCopy: { type: String, default: 'Create an item or choose another scope.' },
})

const emit = defineEmits(['open', 'create'])
const selection = ref(0)
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

watch(() => props.nodes.length, length => {
  selection.value = Math.min(selection.value, Math.max(0, length - 1))
})

function move(delta) {
  if (!props.nodes.length) return
  selection.value = (selection.value + delta + props.nodes.length) % props.nodes.length
}

function openSelected() {
  const node = props.nodes[selection.value]
  if (node) emit('open', node.id)
}

function priorityIcon(priority = 'normal') {
  return {
    urgent: IconExclamationMark,
    high: IconAntennaBars4,
    normal: IconAntennaBars3,
    low: IconAntennaBars2,
  }[priority] || IconAntennaBars3
}

function projectLabel(node) {
  if (!node.projectId) return ''
  const project = byId.value.get(node.projectId)
  return project?.slug || project?.properties?.slug || project?.title || ''
}

function actorInitials(node) {
  return props.actors?.[node.id]?.initials || ''
}

function actorLabel(node) {
  return props.actors?.[node.id]?.label || ''
}

function overdue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value < new Date().toISOString().slice(0, 10)
}

function shortDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}.${month}`
}

function stateClass(status) {
  return status === 'waiting' ? 'state-waiting' : ''
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.entity-list-shell {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.entity-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  outline: none;
}

.entity-list:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 22%, transparent);
}

.entity-row {
  display: flex;
  width: 100%;
  min-height: 42px;
  flex-direction: column;
  justify-content: center;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 14px;
  text-align: left;
}

.entity-row:hover {
  background: var(--color-chrome-mid);
}

.entity-row:focus-visible {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: -2px;
}

.entity-row-selected {
  background: var(--color-accent-soft);
}

.entity-row-selected:hover {
  background: color-mix(in srgb, var(--color-accent-soft) 78%, var(--color-chrome-mid));
}

.entity-line-1 {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.entity-line-1 strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 620;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-priority {
  flex: 0 0 auto;
  color: var(--color-ink-2);
}

.entity-priority.priority-urgent {
  color: var(--color-rem);
}

.entity-priority.priority-normal {
  color: var(--color-ink-3);
}

.entity-priority.priority-low {
  color: var(--color-ink-4);
}

.entity-line-2 {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 15px;
  white-space: nowrap;
}

.entity-status,
.entity-kind {
  flex: 0 0 auto;
  color: var(--color-ink-3);
}

.entity-status.state-waiting {
  color: var(--color-ink);
  font-weight: 650;
}

.entity-project {
  flex: 0 1 auto;
  overflow: hidden;
  max-width: 110px;
  text-overflow: ellipsis;
}

.entity-due {
  flex: 0 0 auto;
  color: var(--color-ink-2);
}

.entity-due.overdue,
.entity-overdue {
  color: var(--color-rem);
}

.entity-overdue {
  flex: 0 0 auto;
}

.entity-waiting {
  flex: 0 0 auto;
  color: var(--color-ink-2);
}

.entity-author {
  margin-left: auto;
  color: var(--color-ink-3);
  font-weight: 650;
}

.entity-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-4);
  text-overflow: ellipsis;
}

.entity-updated {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--color-ink-4);
}

.entity-empty {
  display: grid;
  min-height: 340px;
  place-content: center;
  justify-items: center;
  padding: 36px;
  text-align: center;
}

.entity-empty h2 {
  margin-top: 15px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.entity-empty p {
  max-width: 360px;
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.5;
}

.entity-empty button {
  min-height: 32px;
  margin-top: 16px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 630;
}

.entity-empty button:hover {
  background: var(--color-chrome-mid);
}
</style>
