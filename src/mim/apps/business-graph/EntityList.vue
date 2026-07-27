<template>
  <div class="entity-list-shell">
    <div v-if="nodes.length" class="entity-list-header" aria-hidden="true">
      <span>Type</span>
      <span>Object</span>
      <span>Context</span>
    </div>
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
        <span class="entity-kind">
          <i :class="kindClass(node.kind)" />
          {{ human(node.kind) }}
        </span>
        <span class="entity-main">
          <span class="entity-title-line">
            <strong>{{ node.title || node.id }}</strong>
            <span v-if="node.status" class="entity-state" :class="stateClass(node.status)">
              {{ human(node.status) }}
            </span>
            <span v-if="node.priority && node.priority !== 'normal'" class="entity-priority">
              {{ human(node.priority) }}
            </span>
          </span>
          <span v-if="node.summary" class="entity-summary">{{ node.summary }}</span>
          <span v-else class="entity-id">{{ node.id }}</span>
        </span>
        <span class="entity-context">
          <span v-if="node.tags?.length" class="entity-tags">
            {{ node.tags.slice(0, 2).join(' · ') }}
          </span>
          <span class="entity-scope">
            <i :class="scopeClass(node.scopeId)" />
            {{ scopeLabel(node.scopeId) }}
          </span>
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
import { ref, watch } from 'vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  emptyTitle: { type: String, default: 'Nothing here yet' },
  emptyCopy: { type: String, default: 'Create an item or choose another scope.' },
})

const emit = defineEmits(['open', 'create'])
const selection = ref(0)

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

function scopeLabel(id) {
  return props.scopes.find(scope => scope.id === id)?.kind || 'source'
}

function scopeClass(id) {
  return `scope-${scopeLabel(id)}`
}

function kindClass(kind) {
  if (kind === 'issue') return 'kind-work'
  if (kind === 'project') return 'kind-project'
  if (['person', 'company'].includes(kind)) return 'kind-business'
  return 'kind-knowledge'
}

function stateClass(status) {
  return {
    'in-progress': 'state-active',
    waiting: 'state-waiting',
    review: 'state-review',
    done: 'state-done',
  }[status] || ''
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

.entity-list-header {
  display: grid;
  min-height: 33px;
  flex: 0 0 auto;
  grid-template-columns: 100px minmax(240px, 1fr) minmax(110px, 0.42fr);
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 0 18px;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.055em;
  text-transform: uppercase;
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
  position: relative;
  display: grid;
  width: 100%;
  min-height: 68px;
  grid-template-columns: 100px minmax(240px, 1fr) minmax(110px, 0.42fr);
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 10px 18px;
  text-align: left;
  transition: background-color 110ms ease;
}

.entity-row:hover {
  background: var(--color-chrome-high);
}

.entity-row:focus-visible {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: -2px;
}

.entity-row-selected {
  background: color-mix(in srgb, var(--color-accent-soft) 62%, transparent);
}

.entity-kind,
.entity-scope {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--color-ink-3);
  font-size: 10px;
  text-transform: capitalize;
}

.entity-kind i,
.entity-scope i {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-ink-4);
}

.entity-kind .kind-work,
.entity-scope .scope-project {
  background: var(--color-accent);
}

.entity-kind .kind-project,
.entity-scope .scope-team {
  background: var(--color-add);
}

.entity-kind .kind-business,
.entity-scope .scope-private {
  background: var(--color-ink-3);
}

.entity-main,
.entity-context {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.entity-title-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.entity-title-line strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 630;
  letter-spacing: -0.008em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-state,
.entity-priority {
  flex: 0 0 auto;
  padding: 0;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 620;
  text-transform: capitalize;
}

.entity-state.state-active {
  color: var(--color-accent);
}

.entity-state.state-waiting {
  color: var(--color-rem);
}

.entity-state.state-done {
  color: var(--color-add);
}

.entity-summary,
.entity-id {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-id {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.entity-context {
  align-items: flex-end;
  gap: 6px;
}

.entity-tags {
  overflow: hidden;
  max-width: 100%;
  color: var(--color-ink-3);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-radius: 5px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 630;
}

.entity-empty button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 620px) {
  .entity-list-header {
    display: none;
  }

  .entity-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding-inline: 14px;
  }

  .entity-kind {
    grid-column: 1 / -1;
    margin-bottom: -6px;
    font-size: 9px;
  }

  .entity-context {
    align-items: flex-end;
  }

  .entity-tags {
    display: none;
  }
}
</style>
