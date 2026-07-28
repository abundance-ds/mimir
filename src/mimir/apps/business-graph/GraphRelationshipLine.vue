<template>
  <div
    data-graph-relationship-line
    class="relationship-line"
    :class="{ 'relationship-line-empty': !visibleNeighbors.length }"
  >
    <span class="relationship-subject">This {{ human(node?.kind || 'item') }}</span>
    <template v-if="visibleNeighbors.length">
      <template
        v-for="(neighbor, index) in visibleNeighbors"
        :key="`${neighbor.direction}:${neighbor.relation}:${neighbor.node.id}`"
      >
        <span class="relationship-join">{{ joiner(index) }}</span>
        <span>{{ phrase(neighbor) }}</span>
        <button
          type="button"
          :data-related-node="neighbor.node.id"
          :data-graph-control="`relationship-${neighbor.node.id}`"
          class="relationship-entity"
          @click="$emit('open', neighbor.node.id)"
        >
          {{ neighbor.node.title || neighbor.node.id }}
        </button>
      </template>
      <span>.</span>
    </template>
    <span v-else> has no visible relationships yet.</span>
    <span v-if="hiddenCount" class="relationship-more">
      +{{ hiddenCount }} more
    </span>
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

const orderedNeighbors = computed(() => [...props.neighbors].sort((left, right) => (
  relationOrder(left.relation) - relationOrder(right.relation)
  || String(left.node?.title || left.node?.id).localeCompare(String(right.node?.title || right.node?.id))
)))
const visibleNeighbors = computed(() => orderedNeighbors.value.slice(0, props.limit))
const hiddenCount = computed(() => Math.max(0, orderedNeighbors.value.length - visibleNeighbors.value.length))

function phrase(neighbor) {
  const outgoing = neighbor.direction !== 'incoming'
  const phrases = {
    part_of: outgoing ? 'belongs to' : 'contains',
    assigned_to: outgoing ? 'is assigned to' : 'owns work for',
    for_company: outgoing ? 'is for' : 'commissions',
    has_contact: outgoing ? 'has contact' : 'is a contact for',
    works_at: outgoing ? 'works at' : 'employs',
    contact_for: outgoing ? 'is a contact for' : 'has contact',
    blocks: outgoing ? 'blocks' : 'is blocked by',
    depends_on: outgoing ? 'depends on' : 'is required by',
    supports: outgoing ? 'supports' : 'is supported by',
    evidence_for: outgoing ? 'provides evidence for' : 'is informed by',
    cites: outgoing ? 'cites' : 'is cited by',
    derived_from: outgoing ? 'is derived from' : 'feeds',
    answers: outgoing ? 'answers' : 'is answered by',
    produced_by: outgoing ? 'was produced by' : 'produced',
    related_to: 'is related to',
  }
  return phrases[neighbor.relation] || (
    outgoing ? human(neighbor.relation) : `receives ${human(neighbor.relation)} from`
  )
}

function relationOrder(relation) {
  const order = [
    'part_of',
    'for_company',
    'assigned_to',
    'has_contact',
    'works_at',
    'blocks',
    'depends_on',
    'evidence_for',
    'supports',
    'answers',
    'derived_from',
    'related_to',
  ]
  const index = order.indexOf(relation)
  return index < 0 ? order.length : index
}

function joiner(index) {
  if (index === 0) return ' '
  if (index === visibleNeighbors.value.length - 1) return ', and '
  return ', '
}

function human(value) {
  return String(value || '').replaceAll('_', ' ').replaceAll('-', ' ')
}
</script>

<style scoped>
.relationship-line {
  color: var(--color-ink-3);
  font-size: 12px;
  line-height: 1.75;
}

.relationship-subject {
  color: var(--color-ink-2);
  font-weight: 620;
}

.relationship-join {
  white-space: pre;
}

.relationship-entity {
  border-radius: 3px;
  color: var(--color-accent);
  font-weight: 620;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
  text-underline-offset: 3px;
}

.relationship-entity:hover {
  color: var(--color-ink);
  text-decoration-color: var(--color-accent);
}

.relationship-entity:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  outline-offset: 2px;
}

.relationship-more {
  margin-left: 7px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.relationship-line-empty {
  color: var(--color-ink-4);
}
</style>
