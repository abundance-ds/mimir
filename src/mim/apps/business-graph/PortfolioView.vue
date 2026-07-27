<template>
  <div data-project-portfolio class="portfolio">
    <div v-if="projects.length" class="portfolio-table">
      <div class="portfolio-header" aria-hidden="true">
        <span>Project</span>
        <span>Company / scope</span>
        <span class="num">Open</span>
        <span class="num">Waiting</span>
        <span class="num">Done</span>
        <span class="num">Complete</span>
        <span>Knowledge</span>
        <span>Health</span>
      </div>
      <button
        v-for="project in projects"
        :key="project.id"
        type="button"
        :data-project-card="project.id"
        :data-graph-control="`portfolio-open-${project.id}`"
        class="project-row"
        @click="$emit('open', project.id)"
      >
        <div class="project-identity">
          <strong>{{ project.title || project.id }}</strong>
          <small>{{ project.summary || project.id }}</small>
        </div>
        <div class="project-context">
          <strong>{{ company(project) }}</strong>
          <small>{{ scope(project.scopeId) }}</small>
        </div>
        <span class="project-num">{{ metrics(project).open }}</span>
        <span class="project-num" :class="{ flagged: metrics(project).waiting }">
          {{ metrics(project).waiting }}
        </span>
        <span class="project-num">{{ metrics(project).done }}</span>
        <span class="project-num project-completion">{{ completion(project) }}%</span>
        <span class="project-knowledge">{{ knowledgeText(project) }}</span>
        <span class="project-health" :class="health(project).class">
          <b v-if="health(project).marker" aria-hidden="true">{{ health(project).marker }}</b>
          {{ health(project).label }}
        </span>
      </button>
    </div>

    <div v-else class="portfolio-empty">
      <h2>No projects in these scopes</h2>
      <p>Create a project to connect clients, people, work, evidence, and decisions.</p>
      <button
        type="button"
        data-graph-control="portfolio-empty-create"
        @click="$emit('create')"
      >
        Create project
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  issues: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
})

defineEmits(['open', 'create'])
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

function projectIssues(project) {
  return props.issues.filter(issue => (
    issue.projectId === project.id
    || issue.relations?.some(edge => edge.relation === 'part_of' && edge.target === project.id)
  ))
}

function metrics(project) {
  const issues = projectIssues(project)
  return {
    total: issues.length,
    open: issues.filter(issue => !['done', 'cancelled'].includes(issue.status)).length,
    waiting: issues.filter(issue => issue.status === 'waiting' || issue.waitingFor).length,
    done: issues.filter(issue => issue.status === 'done').length,
  }
}

function completion(project) {
  const values = metrics(project)
  return values.total ? Math.round((values.done / values.total) * 100) : 0
}

function connectedNodes(project) {
  const outgoing = new Set((project.relations || []).map(edge => edge.target))
  return props.nodes.filter(node => (
    node.id !== project.id
    && (
      outgoing.has(node.id)
      || node.relations?.some(edge => edge.target === project.id)
    )
  ))
}

const EVIDENCE_KINDS = new Set([
  'study',
  'evidence',
  'dataset',
  'analysis',
  'model',
  'endpoint',
  'publication',
  'submission',
  'research-question',
  'method',
  'client-request',
])

function knowledge(project) {
  const connected = connectedNodes(project)
  return {
    evidence: connected.filter(node => EVIDENCE_KINDS.has(node.kind)).length,
    decisions: connected.filter(node => node.kind === 'decision').length,
    other: connected.filter(node => (
      !EVIDENCE_KINDS.has(node.kind)
      && !['decision', 'issue', 'person', 'company', 'project'].includes(node.kind)
    )).length,
  }
}

function knowledgeText(project) {
  const values = knowledge(project)
  const decisions = `${values.decisions} ${values.decisions === 1 ? 'decision' : 'decisions'}`
  return `${values.evidence} evidence · ${decisions} · ${values.other} other`
}

function health(project) {
  const values = metrics(project)
  const overdue = projectIssues(project).some(issue => (
    issue.dueDate
    && issue.dueDate < new Date().toISOString().slice(0, 10)
    && !['done', 'cancelled'].includes(issue.status)
  ))
  if (overdue || values.waiting > 1) {
    return { label: 'needs attention', marker: '!', class: 'health-attention' }
  }
  if (values.open) return { label: 'active', marker: '', class: 'health-active' }
  return { label: 'clear', marker: '', class: 'health-clear' }
}

function company(project) {
  const target = project.relations?.find(edge => edge.relation === 'for_company')?.target
  return target ? byId.value.get(target)?.title || target : 'No company linked'
}

function scope(id) {
  return props.scopes.find(item => item.id === id)?.kind || 'source'
}
</script>

<style scoped>
.portfolio {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  background: var(--color-surface);
}

.portfolio-table {
  min-width: 980px;
}

.portfolio-header,
.project-row {
  display: grid;
  grid-template-columns:
    minmax(200px, 1.3fr)
    minmax(130px, 0.8fr)
    52px
    64px
    52px
    72px
    minmax(150px, 0.9fr)
    128px;
  align-items: center;
  gap: 12px;
}

.portfolio-header {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 30px;
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 0 13px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.portfolio-header .num,
.project-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.project-row {
  width: 100%;
  min-height: 46px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 4px 13px;
  color: var(--color-ink-2);
  text-align: left;
}

.project-row:hover {
  background: var(--color-chrome-mid);
}

.project-row:hover .project-identity strong,
.project-row:hover .project-context strong {
  color: var(--color-ink);
}

.project-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.project-identity,
.project-context {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.project-identity strong,
.project-context strong,
.project-identity small,
.project-context small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-identity strong {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 640;
  line-height: 16px;
}

.project-identity small {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-size: 9px;
  line-height: 12px;
}

.project-context strong {
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
}

.project-context small {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 12px;
}

.project-num {
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 560;
}

.project-num.flagged {
  font-weight: 700;
}

.project-completion {
  color: var(--color-ink-2);
}

.project-knowledge {
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-health {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  color: var(--color-ink-3);
  font-size: 10px;
}

.project-health b {
  font-family: var(--font-mono);
  font-weight: 700;
}

.project-health.health-attention {
  color: var(--color-rem);
}

.project-health.health-active {
  color: var(--color-ink-2);
}

.project-health.health-clear {
  color: var(--color-ink-4);
}

.portfolio-empty {
  display: grid;
  min-height: 330px;
  place-content: center;
  justify-items: center;
  padding: 30px;
  text-align: center;
}

.portfolio-empty h2 {
  margin-top: 14px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.portfolio-empty p {
  max-width: 390px;
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.5;
}

.portfolio-empty button {
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

.portfolio-empty button:hover {
  background: var(--color-chrome-mid);
}
</style>
