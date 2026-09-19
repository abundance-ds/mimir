<template>
  <section class="project-home" data-project-home>
    <div class="project-home-actions">
      <div class="project-home-context"><slot name="status" /><button type="button" data-graph-control="project-open-work" class="project-open-work" @click="$emit('openWork', project)">Open Work <IconArrowUpRight :size="13" /></button></div>
      <span v-if="saveLabel" class="project-home-save-state" role="status" :title="updatedTitle">{{ saveLabel }}</span>
    </div>
    <div v-if="draft?.error" class="project-home-save-error" role="status">
      <p>{{ draft.error }}</p>
      <template v-if="draft.remote != null">
        <details><summary data-graph-control="project-saved-canvas">View saved canvas</summary><ProjectMarkdown :document="remoteDocument" @open="openLink" /></details>
        <button type="button" data-graph-control="project-save-local" @click="$emit('resolve', false)">Save my version</button>
        <button type="button" data-graph-control="project-use-saved" @click="$emit('resolve', true)">Use saved version</button>
      </template>
      <button v-else type="button" data-graph-control="project-save-retry" @click="$emit('save')">Retry save</button>
    </div>
    <button v-if="draft?.recovery != null" class="project-home-recover" type="button" data-graph-control="project-recover-draft" @click="$emit('recover')">Restore my previous draft</button>
    <div class="project-home-layout">
      <div class="project-home-content">
        <GraphMarkdownEditor :model-value="modelValue" :view-state="editorState" :framed="false" canvas-style open-links
          aria-label="Team canvas" :min-height="280" :scope-ids="scopeIds" :graph-revision="graphRevision"
          placeholder=""
          @update:model-value="$emit('update:modelValue', $event)" @save="$emit('save')"
          @open-file="$emit('openFile', $event)" @open-url="$emit('openUrl', $event)" @open-graph="$emit('openNode', $event)" />
        <details v-if="project.body?.trim()" class="project-home-project-context">
          <summary data-graph-control="project-context"><IconChevronRight :size="13" />Project context</summary>
          <div class="project-home-section-heading"><span class="project-home-muted">Scope, methods, and agent instructions</span><button type="button" data-graph-control="project-edit-context" @click="$emit('editContext')">Edit context</button></div>
          <ProjectMarkdown :document="contextDocument" @open="openLink" />
        </details>
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
import { IconArrowUpRight, IconChevronRight } from '@tabler/icons-vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import ProjectMarkdown from './ProjectMarkdown.vue'
import { projectHomeMarkdown } from './projectHomeMarkdown.js'
import { useProjectAttention } from './useProjectAttention.js'

const props = defineProps({
  draft: { type: Object, default: null },
  project: { type: Object, required: true }, modelValue: { type: String, default: '' },
  scopeIds: { type: Array, default: () => [] }, graphRevision: { type: [Number, String], default: 0 },
})
const emit = defineEmits(['update:modelValue', 'save', 'resolve', 'recover', 'editContext', 'openWork', 'openNode', 'openFile', 'openUrl'])
const editorState = { note: null }
const contextDocument = computed(() => projectHomeMarkdown(props.project.body, { splitResources: false }))
const remoteDocument = computed(() => projectHomeMarkdown(props.draft?.remote, { splitResources: false }))
const updatedTitle = computed(() => props.draft?.home?.updatedAt ? new Date(props.draft.home.updatedAt).toLocaleString() : '')
const saveLabel = computed(() => {
  const state = props.draft?.status
  if (state === 'saving') return 'Saving…'
  if (state === 'dirty') return 'Unsaved changes'
  if (state === 'error' || state === 'conflict') return 'Not saved'
  const home = props.draft?.home
  if (home?.updatedAt) {
    const date = new Date(home.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const actor = home.updatedBy?.label
    return `Updated ${date}${actor && actor !== 'You' ? ` · ${actor}` : ''}`
  }
  return props.modelValue.trim() ? 'Saved' : ''
})
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
.project-home-save-state { color: var(--color-ink-3); font-size: 10px; text-align: right; }
.project-home-save-error { margin-bottom: 16px; color: var(--color-rem); font-size: 12px; line-height: 1.6; }
.project-home-save-error button, .project-home-recover { color: var(--color-accent); padding: 5px 0; margin-right: 16px; }
.project-home-save-error details { margin: 8px 0; color: var(--color-ink); }
.project-home-project-context { border-top: 1px solid var(--color-rule-light); margin-top: 32px; padding-top: 8px; }
.project-home-project-context > summary { display: flex; align-items: center; gap: 6px; min-height: 28px; list-style: none; cursor: pointer; color: var(--color-ink-3); font-size: 11px; }
.project-home-project-context > summary::-webkit-details-marker { display: none; }
.project-home-project-context[open] > summary > svg { transform: rotate(90deg); }
.project-home-context { display: flex; align-items: center; gap: 14px; }
.project-home-actions .project-open-work { color: var(--color-accent); font-weight: 550; }
.project-home-layout { display: grid; grid-template-columns: minmax(0, 1fr) 235px; align-items: start; gap: 28px; }
.project-home-content, .project-home-attention { min-width: 0; }
.project-home-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; margin-bottom: 6px; }
.project-home-section-heading h2 { color: var(--color-ink); font-size: 12px; font-weight: 650; }
.project-home-section-heading > button { color: var(--color-ink-3); }
.project-home-muted { color: var(--color-ink-3); font-size: 12px; line-height: 1.6; }
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
