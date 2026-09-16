import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import BusinessGraphApp from '../src/mimir/apps/BusinessGraphApp.vue'
import { useBusinessGraphStore } from '../src/stores/businessGraph.js'
import { loadWorkspaceConfig } from '../src/services/workspaceConfig.js'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') || 'parchment'
document.documentElement.setAttribute('data-theme', theme)
// The settings store applies its configured theme on load; seed it.
localStorage.setItem('mimir:editor:settings:v1', JSON.stringify({ editorTheme: theme }))

const iso = offset => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}
const stamp = (h, m) => {
  const date = new Date()
  date.setHours(h, m, 0, 0)
  return date.toISOString()
}

const scopes = [
  { id: 'private:local', kind: 'private', root: '/Users/waqr/.mimir/graph/private' },
  { id: 'project:atlas', kind: 'project', root: '/work/atlas' },
  { id: 'team:main', kind: 'team', root: '/team/graph' },
]
const mkIssue = (id, title, status, extra = {}) => ({
  id, kind: 'issue', title, status, summary: '',
  tags: [], projectId: 'project-atlas', scopeId: 'project:atlas',
  sourceRevision: 'r1', updatedAt: stamp(8, 30), relations: [], ...extra,
})
const summaries = [
  mkIssue('issue-map', 'Build evidence map for the value dossier', 'in-progress', { priority: 'high', dueDate: iso(-2), deliverables: ['outputs/evidence-map.md'] }),
  mkIssue('issue-comparator', 'Confirm comparator set with the client', 'waiting', { priority: 'urgent', waitingFor: 'Sanitized client confirmation' }),
  mkIssue('issue-abstracts', 'Screen 240 abstracts against PICO', 'in-progress', { priority: 'high' }),
  mkIssue('issue-walkthrough', 'Book the October client walkthrough', 'plan', { priority: 'normal', dueDate: iso(9) }),
  mkIssue('issue-objections', 'Collect payer objections from the advisory board', 'plan', { priority: 'normal' }),
  mkIssue('issue-registry', 'Clean the trial registry extract', 'backlog', { priority: 'low', dueDate: iso(16) }),
  mkIssue('issue-qc', 'QC the extraction sheet', 'review', { priority: 'normal', dueDate: iso(1) }),
  mkIssue('issue-kickoff', 'File kickoff notes', 'done', { priority: 'normal' }),
  {
    id: 'project-atlas', kind: 'project', title: params.get('projectName') || 'Atlas', summary: 'Global value evidence strategy',
    slug: 'atlas', scopeId: 'team:main', sourceRevision: 'r2', updatedAt: stamp(9, 5),
    relations: [{ relation: 'for_company', target: 'company-acme' }],
  },
  {
    id: 'person-alex', kind: 'person', title: 'Alex Researcher', summary: 'HEOR lead at Acme',
    scopeId: 'team:main', sourceRevision: 'r3', updatedAt: stamp(7, 12), relations: [],
  },
  {
    id: 'company-acme', kind: 'company', title: 'Acme', summary: 'Client',
    scopeId: 'team:main', sourceRevision: 'r4', updatedAt: stamp(7, 1), relations: [],
  },
  {
    id: 'dec-cohort', kind: 'decision', title: 'Use the matched cohort', summary: 'Comparator decision',
    scopeId: 'project:atlas', sourceRevision: 'r5', updatedAt: stamp(8, 1),
    relations: [{ relation: 'part_of', target: 'project-atlas' }],
  },
]
const events = [
  {
    id: 'e1', eventType: 'deliverable-added', action: 'issues.add_deliverable',
    timestamp: stamp(9, 41), graphRevision: 44, nodeId: 'issue-map', nodeKind: 'issue',
    title: 'Build evidence map', scopeId: 'project:atlas',
    summary: 'Added deliverable · Build evidence map for the value dossier',
    actor: { kind: 'agent', id: 'codex', label: 'Codex', initials: 'CX' },
    changes: [{ field: 'deliverables', before: [], after: ['outputs/evidence-map.md'] }],
    data: { deliverable: { path: 'outputs/evidence-map.md', label: 'Evidence map draft' } },
  },
  {
    id: 'e2', eventType: 'status-changed', action: 'issues.move',
    timestamp: stamp(9, 12), graphRevision: 43, nodeId: 'issue-map', nodeKind: 'issue',
    title: 'Build evidence map', scopeId: 'project:atlas',
    summary: 'Plan → in progress · Build evidence map for the value dossier',
    actor: { kind: 'human', id: 'local-human', label: 'You', initials: 'ME' },
    changes: [{ field: 'status', before: 'plan', after: 'in-progress' }], data: {},
  },
  {
    id: 'e3', eventType: 'decision-recorded', action: 'projects.record_decision',
    timestamp: stamp(8, 52), graphRevision: 42, nodeId: 'dec-cohort', nodeKind: 'decision',
    title: 'Use the matched cohort', scopeId: 'project:atlas',
    summary: 'Recorded decision · Use the matched cohort',
    actor: { kind: 'agent', id: 'pi', label: 'Pi', initials: 'PI' },
    changes: [], data: {},
  },
]

const fullNode = id => {
  const summary = summaries.find(item => item.id === id)
  return {
    ...summary,
    createdAt: new Date(Date.now() - (30 * 86_400_000)).toISOString(),
    body: id === 'person-alex' ? 'Primary contact for extraction QC.' : 'Working note.',
    properties: id === 'person-alex'
      ? { role: 'HEOR lead', email: 'alex@acme.example', phone: '+49 30 555 010' }
      : {},
    relations: id === 'person-alex' ? [{ relation: 'works_at', target: 'company-acme' }] : (summary?.relations || []),
    provenance: { scopeId: summary?.scopeId || 'project:atlas', sourceRevision: 'r9', sourcePath: `/work/atlas/${id}.md` },
  }
}

function filterNodes(query = {}) {
  const anchor = summaries.find(node => node.id === query.relatedTo)
  const related = new Set(anchor ? [anchor.id, ...(anchor.relations || []).map(edge => edge.target)] : [])
  if (anchor) summaries.forEach(node => {
    if (node.projectId === anchor.id || node.relations?.some(edge => edge.target === anchor.id)) related.add(node.id)
  })
  return summaries.filter(node => (!query.scopeIds?.length || query.scopeIds.includes(node.scopeId))
    && (!query.kinds?.length || query.kinds.includes(node.kind))
    && (!query.relatedTo || related.has(node.id)))
}

window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    switch (cmd) {
      case 'graph_open':
        return { scopes, nodeCount: summaries.length, diagnosticCount: 0, graphRevision: 44 }
      case 'workspace_config_load':
        return { id: 'workspace-atlas', project: params.has('noProject') ? '' : 'project-atlas', graphScope: 'team' }
      case 'graph_query': {
        const items = filterNodes(args?.query)
        return { items, total: items.length, graphRevision: 44 }
      }
      case 'graph_diagnostics':
        return []
      case 'graph_events':
        return { items: events, total: events.length, offset: 0, limit: 500 }
      case 'graph_search': {
        const query = String(args?.query || '').toLowerCase()
        return filterNodes(args)
          .filter(node => (
            node.title.toLowerCase().includes(query)
            || node.id.includes(query)
            || (node.summary || '').toLowerCase().includes(query)
          ))
          .map(node => ({ node }))
      }
      case 'graph_get':
        return fullNode(args?.id)
      case 'graph_neighbors': {
        if (args?.id !== 'issue-map') return []
        return [
          {
            relation: 'part_of',
            direction: 'outgoing',
            node: summaries.find(node => node.id === 'project-atlas'),
          },
          {
            relation: 'blocked_by',
            direction: 'incoming',
            node: summaries.find(node => node.id === 'issue-comparator'),
          },
        ]
      }
      case 'graph_context':
        return { graphRevision: 44, markdown: '# Business graph context\n\nBounded snapshot.' }
      case 'settings_load':
        return { settings: { editor: { editorTheme: theme } } }
      case 'settings_save':
      case 'settings_save_editor':
      case 'settings_changed':
        return null
      default:
        return null
    }
  },
  transformCallback: () => 0,
  unregisterCallback: () => {},
}

const pinia = createPinia()
const app = createApp({
  setup() {
    return () => h(BusinessGraphApp, {
      workspacePath: '/work/atlas',
      active: true,
    })
  },
})
app.use(pinia)
const graph = useBusinessGraphStore(pinia)
await loadWorkspaceConfig('/work/atlas')
await graph.start('/work/atlas')
app.mount('#app')
graph.setSection(params.get('section') || 'all')

const action = params.get('do')
if (action) {
  setTimeout(async () => {
    if (action === 'search') {
      const input = document.querySelector('[data-graph-search]')
      input?.focus()
      if (input) {
        input.value = 'alex'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    if (action === 'board') {
      document.querySelector('[data-graph-section="work"]')?.click()
    }
    if (action === 'peek') {
      document.querySelector('[data-graph-section="work"]')?.click()
      await new Promise(resolve => setTimeout(resolve, 400))
      document.querySelector('[data-board-card="issue-map"]')?.click()
    }
  }, 900)
}
