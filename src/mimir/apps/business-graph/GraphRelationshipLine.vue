<template>
  <div
    data-graph-relationship-line
    class="relationship-line"
    :class="{ 'relationship-line-empty': !visibleNeighbors.length }"
  >
    <template v-if="visibleNeighbors.length">
      <span
        v-for="neighbor in visibleNeighbors"
        :key="`${neighbor.direction}:${neighbor.relation}:${neighbor.node.id}`"
        class="relationship-item"
      >
        <span class="relationship-phrase">{{ phrase(neighbor) }}</span>
        <button
          type="button"
          :data-related-node="neighbor.node.id"
          :data-graph-control="`relationship-${neighbor.node.id}`"
          class="relationship-entity"
          @click="$emit('open', neighbor.node.id)"
        >
          {{ displayTitle(neighbor.node) }}
        </button>
      </span>
      <span v-if="hiddenCount" class="relationship-more">
        +{{ hiddenCount }} more
      </span>
    </template>
    <span v-else>No relationships yet.</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  node: { type: Object, default: null },
  neighbors: { type: Array, default: () => [] },
  limit: { type: Number, default: 4 },
})

defineEmits(['open'])

// Compact context labels, [outgoing, incoming] per relation. Labels stay
// lowercase metadata; the linked object carries the meaning.
const RELATION_PHRASES = Object.freeze({
  part_of: ['part of', 'contains'],
  assigned_to: ['assigned to', 'owns'],
  for_company: ['for', 'commissions'],
  has_contact: ['contact', 'contact for'],
  works_at: ['works at', 'employs'],
  contact_for: ['contact for', 'contact'],
  blocks: ['blocks', 'blocked by'],
  blocked_by: ['blocked by', 'blocks'],
  depends_on: ['depends on', 'required by'],
  introduced_by: ['introduced by', 'introduced'],
  references: ['references', 'referenced by'],
  supports: ['supports', 'supported by'],
  evidence_for: ['evidence for', 'informed by'],
  cites: ['cites', 'cited by'],
  derived_from: ['derived from', 'feeds'],
  answers: ['answers', 'answered by'],
  produced_by: ['produced by', 'produced'],
  related_to: ['related to', 'related to'],
})

const orderedNeighbors = computed(() => [...props.neighbors].sort((left, right) => (
  relationOrder(left.relation) - relationOrder(right.relation)
  || displayTitle(left.node).localeCompare(displayTitle(right.node))
)))
const visibleNeighbors = computed(() => orderedNeighbors.value.slice(0, props.limit))
const hiddenCount = computed(() => Math.max(0, orderedNeighbors.value.length - visibleNeighbors.value.length))

function phrase(neighbor) {
  const pair = RELATION_PHRASES[neighbor.relation]
  if (!pair) return human(neighbor.relation)
  return neighbor.direction === 'incoming' ? pair[1] : pair[0]
}

function relationOrder(relation) {
  const order = [
    'part_of',
    'for_company',
    'assigned_to',
    'has_contact',
    'works_at',
    'blocked_by',
    'blocks',
    'depends_on',
    'introduced_by',
    'evidence_for',
    'supports',
    'answers',
    'derived_from',
    'references',
    'related_to',
  ]
  const index = order.indexOf(relation)
  return index < 0 ? order.length : index
}

function human(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}

function displayTitle(node) {
  return node?.title || `Untitled ${human(node?.kind || 'object')}`
}
</script>

<style scoped>
.relationship-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 16px;
  font-size: 10px;
  line-height: 1.6;
}

.relationship-item {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 5px;
}

.relationship-phrase {
  flex: 0 0 auto;
  color: var(--color-ink-4);
}

.relationship-entity {
  overflow: hidden;
  border-radius: 2px;
  color: var(--color-accent);
  font-size: 10px;
  font-weight: 620;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
  text-overflow: ellipsis;
  text-underline-offset: 2px;
  white-space: nowrap;
}

.relationship-entity:hover {
  text-decoration-color: var(--color-accent);
}

.relationship-entity:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  outline-offset: 2px;
}

.relationship-more {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.relationship-line-empty {
  color: var(--color-ink-4);
}
</style>
