import { createApp, h } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import PortfolioView from '../src/mim/apps/business-graph/PortfolioView.vue'
import ProjectStanding from '../src/mim/apps/business-graph/ProjectStanding.vue'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', params.get('theme') || 'parchment')

const iso = offset => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

const companies = [
  { id: 'company-acme', kind: 'company', title: 'Acme' },
  { id: 'company-borel', kind: 'company', title: 'Borel Health' },
]
const projects = [
  {
    id: 'project-atlas', kind: 'project', title: 'Atlas', scopeId: 'team:main',
    summary: 'Global value evidence strategy',
    relations: [{ relation: 'for_company', target: 'company-acme' }],
  },
  {
    id: 'project-ember', kind: 'project', title: 'Ember', scopeId: 'project:ember',
    summary: 'Payer objection handling',
    relations: [{ relation: 'for_company', target: 'company-borel' }],
  },
  {
    id: 'project-cinder', kind: 'project', title: 'Cinder', scopeId: 'private:local',
    summary: 'Internal pricing model',
    relations: [],
  },
]
const mkIssue = (id, projectId, status, extra = {}) => ({
  id, kind: 'issue', title: id, status, projectId,
  relations: [{ relation: 'part_of', target: projectId }],
  ...extra,
})
const issues = [
  mkIssue('i1', 'project-atlas', 'in-progress', { deliverables: ['outputs/evidence-map.md'] }),
  mkIssue('i2', 'project-atlas', 'waiting', { waitingFor: 'Client confirmation' }),
  mkIssue('i3', 'project-atlas', 'waiting', { waitingFor: 'Client confirmation' }),
  mkIssue('i4', 'project-atlas', 'waiting', { waitingFor: 'Internal review' }),
  mkIssue('i5', 'project-atlas', 'done'),
  mkIssue('i6', 'project-atlas', 'done'),
  mkIssue('i7', 'project-atlas', 'plan', { dueDate: iso(-3) }),
  mkIssue('i8', 'project-ember', 'in-progress'),
  mkIssue('i9', 'project-ember', 'done'),
  mkIssue('i10', 'project-ember', 'done'),
  mkIssue('i11', 'project-ember', 'done'),
  mkIssue('i12', 'project-ember', 'done'),
  mkIssue('i13', 'project-cinder', 'backlog'),
]
const decisions = [
  {
    id: 'dec-1', kind: 'decision', title: 'Use the matched cohort', updatedAt: iso(-2),
    relations: [{ relation: 'part_of', target: 'project-atlas' }],
  },
  {
    id: 'dec-2', kind: 'decision', title: 'Drop the network meta-analysis', updatedAt: iso(-9),
    relations: [{ relation: 'part_of', target: 'project-atlas' }],
  },
]
const knowledge = [
  { id: 'ev-1', kind: 'evidence', title: 'HTA submission', relations: [{ relation: 'references', target: 'project-atlas' }] },
  { id: 'ev-2', kind: 'study', title: 'Registry cut', relations: [{ relation: 'references', target: 'project-atlas' }] },
]
const nodes = [...companies, ...projects, ...issues, ...decisions, ...knowledge]
const scopes = [
  { id: 'team:main', kind: 'team' },
  { id: 'project:ember', kind: 'project' },
  { id: 'private:local', kind: 'private' },
]

const view = params.get('view') || 'portfolio'
const app = createApp({
  setup() {
    return () => view === 'standing'
      ? h('div', { style: 'max-width: 860px; background: var(--color-surface); flex: 1;' }, [
          h(ProjectStanding, {
            project: { ...projects[0], properties: { deliverables: ['outputs/readout-deck.pdf'] } },
            nodes,
          }),
        ])
      : h(PortfolioView, { projects, issues, nodes, scopes })
  },
})
app.mount('#app')
