<template>
  <section class="graph-references" aria-label="Note links" :aria-busy="loading">
    <p v-if="error" role="status" class="graph-reference-status">
      {{ error }} <button type="button" data-graph-control="note-links-retry" @click="load">Retry</button>
    </p>
    <p v-else-if="dirty" role="status" class="graph-reference-status">Links update after save.</p>
    <div class="graph-reference-group">
      <h3>Links</h3>
      <p v-if="!outgoing.length" class="graph-reference-empty">No links</p>
      <button
        v-for="reference in outgoing"
        :key="reference.targetId"
        type="button"
        class="graph-reference-row"
        data-graph-outgoing-link
        :data-graph-control="`note-link-${reference.targetId}`"
        :disabled="reference.status !== 'resolved'"
        @click="$emit('open', reference.targetId)"
      >
        <span>{{ reference.node?.title || reference.label || 'Entry unavailable' }}</span>
        <small>{{ reference.status === 'resolved' ? reference.node?.kind : 'Unavailable' }}</small>
      </button>
    </div>
    <div class="graph-reference-group">
      <h3>Backlinks</h3>
      <p v-if="!references.backlinks.length" class="graph-reference-empty">No backlinks</p>
      <button
        v-for="backlink in references.backlinks"
        :key="backlink.source.id"
        type="button"
        class="graph-reference-row"
        data-graph-backlink
        :data-graph-control="`note-backlink-${backlink.source.id}`"
        @click="openBacklink(backlink)"
      >
        <span>{{ backlink.source.title }}</span>
        <small>{{ backlink.source.kind }}<template v-if="backlink.occurrences.length > 1"> · {{ backlink.occurrences.length }} links</template></small>
      </button>
    </div>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { graphReferences } from '../../../services/businessGraph.js'

const props = defineProps({
  node: { type: Object, required: true },
  scopeIds: { type: Array, default: () => [] },
  graphRevision: { type: [Number, String], default: 0 },
  dirty: { type: Boolean, default: false },
})
const emit = defineEmits(['open'])
const empty = () => ({ outgoing: [], backlinks: [], sourceRevision: '' })
const references = ref(empty())
const loading = ref(false)
const error = ref('')
let generation = 0
const outgoing = computed(() => [...new Map(references.value.outgoing.map(reference => [reference.targetId, reference])).values()])

async function load() {
  const current = ++generation
  const id = props.node?.id
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    const result = await graphReferences(id, { scopeIds: props.scopeIds })
    if (current !== generation) return
    references.value = { ...empty(), ...result }
  } catch {
    if (current === generation) error.value = 'Links could not be loaded.'
  } finally {
    if (current === generation) loading.value = false
  }
}

watch(() => [props.node?.id, props.node?.provenance?.sourceRevision, props.graphRevision, props.scopeIds.join('\0')], (next, previous) => {
  if (!previous || next[0] !== previous[0] || next[3] !== previous[3]) references.value = empty()
  void load()
}, { immediate: true })

function openBacklink(backlink) {
  const occurrence = backlink.occurrences[0]
  emit('open', {
    id: backlink.source.id,
    targetId: props.node.id,
    sourceRevision: backlink.sourceRevision,
    from: occurrence?.from,
    to: occurrence?.to,
  })
}
onUnmounted(() => { generation += 1 })
</script>

<style scoped>
.graph-references { padding: 16px 0; border-top: 1px solid var(--color-rule-light); }
.graph-reference-group + .graph-reference-group { margin-top: 14px; }
h3 { margin-bottom: 6px; color: var(--color-ink-3); font-size: 11px; font-weight: 650; }
.graph-reference-row { display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: 12px; padding: 5px 3px; text-align: left; font-size: 12px; }
.graph-reference-row > span { min-width: 0; overflow-wrap: anywhere; color: var(--color-accent); }
.graph-reference-row small { flex-shrink: 0; color: var(--color-ink-3); font-size: 10px; }
.graph-reference-row:hover { background: var(--color-chrome-mid); }
.graph-reference-row:focus-visible, .graph-reference-status button:focus-visible { outline: 2px solid var(--color-accent); }
.graph-reference-row:disabled > span { color: var(--color-ink-3); }
.graph-reference-empty, .graph-reference-status { color: var(--color-ink-3); font-size: 11px; }
.graph-reference-status { margin-bottom: 10px; }
.graph-reference-status button { color: var(--color-accent); text-decoration: underline; }
</style>
