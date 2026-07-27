<template>
  <div data-project-portfolio class="portfolio">
    <div v-if="projects.length" class="portfolio-table">
      <div class="portfolio-header" aria-hidden="true">
        <span>Project</span>
        <span>Company / scope</span>
        <span>Work</span>
        <span>Complete</span>
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
        <dl class="project-work">
          <div><dd>{{ metrics(project).open }}</dd><dt>open</dt></div>
          <div><dd :class="{ attention: metrics(project).waiting }">{{ metrics(project).waiting }}</dd><dt>wait</dt></div>
          <div><dd>{{ metrics(project).done }}</dd><dt>done</dt></div>
        </dl>
        <span class="project-completion">{{ completion(project) }}%</span>
        <div class="project-knowledge">
          <span>{{ knowledge(project).evidence }} evidence</span>
          <span>
            {{ knowledge(project).decisions }}
            {{ knowledge(project).decisions === 1 ? 'decision' : 'decisions' }}
          </span>
          <span>{{ knowledge(project).other }} other</span>
        </div>
        <span class="project-health" :class="health(project).class">
          <i />
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

function knowledge(project) {
  const connected = connectedNodes(project)
  const evidenceKinds = new Set([
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
  return {
    evidence: connected.filter(node => evidenceKinds.has(node.kind)).length,
    decisions: connected.filter(node => node.kind === 'decision').length,
    other: connected.filter(node => (
      !evidenceKinds.has(node.kind)
      && !['decision', 'issue', 'person', 'company', 'project'].includes(node.kind)
    )).length,
  }
}

function health(project) {
  const values = metrics(project)
  const overdue = projectIssues(project).some(issue => (
    issue.dueDate
    && issue.dueDate < new Date().toISOString().slice(0, 10)
    && !['done', 'cancelled'].includes(issue.status)
  ))
  if (overdue || values.waiting > 1) return { label: 'Needs attention', class: 'health-attention' }
  if (values.open) return { label: 'Active', class: 'health-active' }
  return { label: 'Clear', class: 'health-clear' }
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
  overflow-y: auto;
  padding: 12px;
}

.portfolio-table {
  min-width: 920px;
  border: 1px solid var(--color-rule-light);
  background: var(--color-surface);
}

.portfolio-header,
.project-row {
  display: grid;
  grid-template-columns:
    minmax(240px, 1.35fr)
    minmax(150px, 0.8fr)
    160px
    76px
    minmax(180px, 0.9fr)
    116px;
  align-items: center;
  gap: 14px;
}

.portfolio-header {
  min-height: 32px;
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 0 13px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.035em;
  text-transform: uppercase;
}

.project-row {
  width: 100%;
  min-height: 70px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 9px 13px;
  color: var(--color-ink-2);
  text-align: left;
}

.project-row:last-child {
  border-bottom: 0;
}

.project-row:hover {
  background: var(--color-chrome-high);
}

.project-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 28%, transparent);
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
}

.project-context strong {
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 600;
}

.project-identity small,
.project-context small {
  margin-top: 4px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.project-context small {
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.project-work {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.project-work div {
  min-width: 0;
}

.project-work dd {
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 650;
}

.project-work dd.attention {
  color: var(--color-rem);
}

.project-work dt {
  margin-top: 2px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.project-completion {
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.project-knowledge {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.project-knowledge span {
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-health {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-ink-3);
  font-size: 9px;
  font-weight: 620;
}

.project-health i {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
}

.health-attention {
  color: var(--color-rem);
}

.health-active {
  color: var(--color-accent);
}

.health-clear {
  color: var(--color-add);
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
  border-radius: 5px;
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
