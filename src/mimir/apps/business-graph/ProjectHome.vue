<template>
  <section class="project-home" data-project-home>
    <div class="project-home-actions">
      <div class="project-home-context"><slot name="status" /><button type="button" data-graph-control="project-open-work" class="project-open-work" @click="$emit('openWork', project)">Open Work <IconArrowUpRight :size="13" /></button></div>
      <button type="button" data-graph-control="project-edit-page" @click="$emit('edit')">Edit page</button>
    </div>
    <div class="project-home-layout">
      <div class="project-home-content">
          <ProjectMarkdown v-if="document.brief.length" :document="document" @open="openLink" />
          <div v-else class="project-home-empty">
            <p>Keep the objective, deliverable, and next milestone here.</p>
            <button type="button" data-graph-control="project-write-brief" @click="$emit('edit')">Write brief</button>
          </div>
          <section class="project-home-resources" aria-label="Key resources">
            <div class="project-home-section-heading"><h2>Key resources</h2>
              <button type="button" data-graph-control="project-edit-resources" @click="$emit('edit')">{{ document.resources.length ? 'Edit links' : 'Add links' }}</button>
            </div>
            <ProjectMarkdown v-if="document.resources.length" :document="document" section="resources" @open="openLink" />
            <p v-else class="project-home-muted">Keep the protocol, evidence table, model, and shared folder within reach.</p>
          </section>
      </div>
      <aside class="project-home-attention" aria-label="Needs attention" :aria-busy="loading">
        <div class="project-home-section-heading"><h2>Needs attention</h2><span v-if="total" class="project-attention-count">{{ total }}</span></div>
        <p v-if="error" class="project-home-muted" role="status">{{ error }} <button type="button" data-graph-control="project-work-retry" @click="load">Retry</button></p>
        <p v-else-if="loading && !rows.length" class="project-home-muted" role="status">Loading project work…</p>
        <p v-else-if="!rows.length" class="project-home-muted">No waiting, overdue, or review tasks. Nothing due today.</p>
        <div v-if="rows.length" class="project-attention-rows">
          <button v-for="row in rows" :key="row.id" type="button" class="project-attention-row"
            :data-graph-control="`project-task-${row.id}`" @click="$emit('openNode', row.id)">
            <strong>{{ row.title }}</strong>
            <span v-if="row.reason" class="project-attention-reason">{{ row.reason }}</span>
            <span class="project-attention-meta"><span>{{ row.assigneeId ? (owners.get(row.assigneeId) || 'Owner unavailable') : 'Unassigned' }}</span>
              <span v-if="row.due.label" :class="{ 'project-task-overdue': row.due.state === 'overdue' }">{{ row.due.label }}</span>
            </span>
          </button>
        </div>
        <button type="button" data-graph-control="project-more-work" v-if="total > rows.length" class="project-more-work" @click="$emit('openWork', project)">{{ total - rows.length }} more in Work <IconArrowUpRight :size="12" /></button>
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { IconArrowUpRight } from '@tabler/icons-vue'
import ProjectMarkdown from './ProjectMarkdown.vue'
import { projectHomeMarkdown } from './projectHomeMarkdown.js'
import { useProjectAttention } from './useProjectAttention.js'

const props = defineProps({
  project: { type: Object, required: true }, modelValue: { type: String, default: '' },
  scopeIds: { type: Array, default: () => [] }, graphRevision: { type: [Number, String], default: 0 },
})
const emit = defineEmits(['edit', 'openWork', 'openNode', 'openFile', 'openUrl'])
const document = computed(() => projectHomeMarkdown(props.modelValue))
const { rows, total, owners, loading, error, load } = useProjectAttention(props)
function openLink(destination) {
  emit(destination.kind === 'graph' ? 'openNode' : destination.kind === 'file' ? 'openFile' : 'openUrl', destination.target)
}
</script>

<style scoped>
.project-home { margin: 4px 0 24px; }
.project-home-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 20px; }
.project-home button { font-size: 11px; }
.project-home-actions button, .project-more-work { display: inline-flex; min-height: 28px; align-items: center; gap: 5px; color: var(--color-ink-3); }
.project-home-context { display: flex; align-items: center; gap: 14px; }
.project-home-actions .project-open-work { color: var(--color-accent); font-weight: 550; }
.project-home-layout { display: grid; grid-template-columns: minmax(0, 1fr) 235px; align-items: start; gap: 28px; }
.project-home-content, .project-home-attention { min-width: 0; }
.project-home-resources { margin-top: 24px; }
.project-home-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; margin-bottom: 6px; }
.project-home-section-heading h2 { color: var(--color-ink); font-size: 12px; font-weight: 650; }
.project-home-section-heading > button { color: var(--color-ink-3); }
.project-home-muted, .project-home-empty { color: var(--color-ink-3); font-size: 12px; line-height: 1.6; }
.project-home-empty { padding: 10px 0; }
.project-home-empty button, .project-home-muted button { color: var(--color-accent); min-height: 28px; }
.project-attention-count { color: var(--color-ink-3); font-size: 10px; font-variant-numeric: tabular-nums; }
.project-attention-row { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 10px 8px; text-align: left; }
.project-attention-row strong { color: var(--color-ink); font-size: 12px; font-weight: 550; line-height: 1.45; overflow-wrap: anywhere; }
.project-attention-reason { color: var(--color-ink-2); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.project-attention-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; justify-content: space-between; color: var(--color-ink-3); font-size: 10px; }
.project-task-overdue { color: var(--color-rem); }
.project-home button:hover { background: var(--color-chrome-mid); }
.project-home button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.project-more-work { margin-top: 8px; }
@container graph-document (max-width: 699px) {
  .project-home-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .project-home-attention { border-top: 1px solid var(--color-rule-light); padding-top: 12px; }
}
</style>
