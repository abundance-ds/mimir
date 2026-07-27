import { createApp, h } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import NowView from '../src/mim/apps/business-graph/NowView.vue'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', params.get('theme') || 'parchment')

const at = (hours, minutes, dayOffset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() - dayOffset)
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

const nodes = [
  { id: 'issue-1', kind: 'issue', title: 'Build evidence map', status: 'in-progress', projectId: 'project-atlas' },
  { id: 'issue-2', kind: 'issue', title: 'Confirm comparator set', status: 'waiting', projectId: 'project-atlas', waitingFor: 'Sanitized client confirmation' },
  { id: 'issue-3', kind: 'issue', title: 'Collect payer objections', status: 'plan', projectId: 'project-ember', needsDetail: true },
  { id: 'issue-4', kind: 'issue', title: 'QC extraction sheet', status: 'review', projectId: 'project-atlas' },
  { id: 'project-atlas', kind: 'project', title: 'Atlas', slug: 'atlas' },
  { id: 'project-ember', kind: 'project', title: 'Ember', slug: 'ember' },
]
const waiting = [
  nodes[1],
  nodes[2],
]
const human = { kind: 'human', id: 'local-human', label: 'You', initials: 'ME' }
const agent = { kind: 'agent', id: 'codex', label: 'Codex', initials: 'CX', activityId: 'agent:1' }
const events = [
  { id: 'e1', eventType: 'deliverable-added', action: 'issues.add_deliverable', timestamp: at(9, 41), graphRevision: 44, nodeId: 'issue-1', nodeKind: 'issue', title: 'Build evidence map', scopeId: 'project:atlas', summary: 'Added deliverable · Build evidence map', actor: agent, changes: [{ field: 'deliverables', before: [], after: ['outputs/evidence-map.md'] }], data: { deliverable: { path: 'outputs/evidence-map.md', label: 'Evidence map draft' } } },
  { id: 'e2', eventType: 'status-changed', action: 'issues.move', timestamp: at(9, 12), graphRevision: 43, nodeId: 'issue-1', nodeKind: 'issue', title: 'Build evidence map', scopeId: 'project:atlas', summary: 'Plan → in progress · Build evidence map', actor: human, changes: [{ field: 'status', before: 'plan', after: 'in-progress' }], data: {} },
  { id: 'e3', eventType: 'created', action: 'issues.create', timestamp: at(8, 52), graphRevision: 42, nodeId: 'issue-3', nodeKind: 'issue', title: 'Collect payer objections', scopeId: 'project:ember', summary: 'Filed issue · Collect payer objections', actor: agent, changes: [], data: {} },
  { id: 'e4', eventType: 'became-overdue', action: 'temporal', timestamp: at(8, 0), graphRevision: 41, nodeId: 'issue-4', nodeKind: 'issue', title: 'QC extraction sheet', scopeId: 'project:atlas', summary: 'Became overdue · QC extraction sheet', actor: { kind: 'system', id: 'graph', label: 'Graph', initials: 'GR' }, changes: [], data: {} },
  { id: 'e5', eventType: 'decision-recorded', action: 'projects.record_decision', timestamp: at(17, 26, 1), graphRevision: 38, nodeId: 'dec-1', nodeKind: 'decision', title: 'Use the matched cohort', scopeId: 'project:atlas', summary: 'Recorded decision · Use the matched cohort', actor: human, changes: [], data: {} },
  { id: 'e6', eventType: 'waiting-cleared', action: 'issues.update', timestamp: at(16, 3, 1), graphRevision: 37, nodeId: 'issue-2', nodeKind: 'issue', title: 'Confirm comparator set', scopeId: 'project:atlas', summary: 'Waiting cleared · Confirm comparator set', actor: agent, changes: [{ field: 'waitingFor', before: 'Internal review', after: '' }], data: {} },
  { id: 'e7', eventType: 'updated', action: 'external.file-change', timestamp: at(15, 44, 2), graphRevision: 30, nodeId: 'issue-4', nodeKind: 'issue', title: 'QC extraction sheet', scopeId: 'project:atlas', summary: 'Source changed · QC extraction sheet', actor: { kind: 'system', id: 'external', label: 'External edit', initials: 'EX' }, changes: [], data: {} },
]

const app = createApp({
  setup() {
    return () => h(NowView, {
      events,
      waiting,
      nodes,
      seenAt: params.get('seen') === '1' ? at(8, 40) : '',
    })
  },
})
app.mount('#app')
