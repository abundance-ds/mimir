<template>
  <section
    v-if="error || outgoing.length || references.backlinks.length"
    class="graph-references"
    aria-label="Note links"
    :aria-busy="loading"
  >
    <p v-if="error" role="status" class="graph-reference-status">
      {{ error }} <button type="button" data-graph-control="note-links-retry" @click="load">Retry</button>
    </p>
    <details
      v-if="outgoing.length"
      class="graph-reference-group"
      data-graph-reference-group="links"
      :open="linksOpen"
      @toggle="linksOpen = $event.target.open"
    >
      <summary
        data-graph-control="note-links-toggle"
        :aria-label="`Links, ${outgoing.length}${unavailableCount ? `, ${unavailableCount} unavailable` : ''}`"
      >
        <IconChevronRight :size="12" aria-hidden="true" />
        <span>Links</span>
        <span class="graph-reference-count">{{ outgoing.length }}</span>
        <span v-if="unavailableCount" class="graph-reference-unavailable">{{ unavailableCount }} unavailable</span>
      </summary>
      <div v-if="linksOpen" class="graph-reference-list">
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
    </details>
    <details
      v-if="references.backlinks.length"
      class="graph-reference-group"
      data-graph-reference-group="backlinks"
      :open="backlinksOpen"
      @toggle="backlinksOpen = $event.target.open"
    >
      <summary data-graph-control="note-backlinks-toggle" :aria-label="`Backlinks, ${references.backlinks.length}`">
        <IconChevronRight :size="12" aria-hidden="true" />
        <span>Backlinks</span>
        <span class="graph-reference-count">{{ references.backlinks.length }}</span>
      </summary>
      <div v-if="backlinksOpen" class="graph-reference-list">
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
    </details>
    <p
      v-if="!error && dirty && ((outgoing.length && linksOpen) || (references.backlinks.length && backlinksOpen))"
      role="status"
      class="graph-reference-status"
    >Links update after save.</p>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { IconChevronRight } from '@tabler/icons-vue'
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
const linksOpen = ref(false)
const backlinksOpen = ref(false)
let generation = 0
const outgoing = computed(() => [...new Map(references.value.outgoing.map(reference => [reference.targetId, reference])).values()])
const unavailableCount = computed(() => outgoing.value.filter(reference => reference.status !== 'resolved').length)

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
  if (!previous || next[0] !== previous[0] || next[3] !== previous[3]) {
    references.value = empty()
    linksOpen.value = false
    backlinksOpen.value = false
  }
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
.graph-references { padding: 4px 0; border-top: 1px solid var(--color-rule-light); }
.graph-reference-group > summary { display: flex; min-height: 28px; align-items: center; gap: 6px; padding: 3px 0; color: var(--color-ink-3); font-size: 11px; font-weight: 500; list-style: none; cursor: pointer; }
.graph-reference-group > summary::-webkit-details-marker { display: none; }
.graph-reference-group > summary > svg { flex: 0 0 auto; }
.graph-reference-group[open] > summary > svg { transform: rotate(90deg); }
.graph-reference-count { color: var(--color-ink-4); font-size: 10px; font-variant-numeric: tabular-nums; }
.graph-reference-unavailable { margin-left: auto; color: var(--color-ink-3); font-size: 10px; font-weight: 400; }
.graph-reference-list { padding: 0 0 4px 18px; }
.graph-reference-row { display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: 12px; padding: 5px 3px; text-align: left; font-size: 12px; }
.graph-reference-row > span { min-width: 0; overflow-wrap: anywhere; color: var(--color-accent); }
.graph-reference-row small { flex-shrink: 0; color: var(--color-ink-3); font-size: 10px; }
.graph-reference-row:hover, .graph-reference-group > summary:hover { background: var(--color-chrome-mid); }
.graph-reference-row:focus-visible, .graph-reference-status button:focus-visible, .graph-reference-group > summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.graph-reference-row:disabled > span { color: var(--color-ink-3); }
.graph-reference-status { margin: 4px 0; color: var(--color-ink-3); font-size: 11px; }
.graph-reference-status button { color: var(--color-accent); text-decoration: underline; }
</style>
