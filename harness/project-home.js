import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import BusinessGraphApp from '../src/mimir/apps/BusinessGraphApp.vue'
import { useBusinessGraphStore } from '../src/stores/businessGraph.js'
import { useSettingsStore } from '../src/stores/settings.js'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'parchment'
const day = delta => { const date = new Date(); date.setDate(date.getDate() + delta); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const project = { id: 'project-atlas', kind: 'project', title: 'Atlas — Evidence review', summary: '', tags: [], relations: [],
  body: params.has('empty') ? '' : '**Deliverable:** A defensible evidence package for the UK reimbursement submission.\n\n**Current focus:** Resolve the comparator set and complete quality control of the extraction.\n\n**Next milestone:** Client review on 25 September. Anna owns the submission brief.\n\n## Key resources\n\n- [Study protocol](https://example.org/atlas/protocol-v3.pdf)\n- [Evidence table](evidence/extraction.xlsx)\n- [Analysis plan](mimir://graph/analysis-plan)\n- [Economic model](models/base-case.xlsx)\n- [Client shared folder](https://example.org/atlas/shared)\n- [Submission brief](outputs/submission-brief.md)',
  properties: { projectStatus: 'active', projectType: 'client-engagement' },
  provenance: { scopeId: 'team:main', scopeKind: 'team', sourceRevision: 'fixture', sourcePath: '/preview/graph/project-atlas.md' },
}
project.properties.home = { canvas: project.body, updatedAt: '2026-09-19T00:00:00Z' }
project.body = 'Stable context for the project and its agents.'
const owners = [{ id: 'anna', title: 'Anna Berg', kind: 'person' }, { id: 'alex', title: 'Alex Rivera', kind: 'person' }]
const issues = params.has('empty') ? [] : [
  { id: 'qc', title: 'Complete extraction quality control', status: 'review', dueDate: day(-2), assigneeId: 'alex' },
  { id: 'protocol', title: 'Get client sign-off on the comparator set', status: 'waiting', waitingFor: 'client confirmation', assigneeId: 'anna' },
  { id: 'brief', title: 'Prepare the client review brief', status: 'in-progress', dueDate: day(0), assigneeId: 'anna' },
  { id: 'model', title: 'Check the base-case assumptions', status: 'review', assigneeId: 'alex' },
  { id: 'done', title: 'File kickoff notes', status: 'done' },
].map(issue => ({ ...issue, kind: 'issue', projectId: project.id, scopeId: 'team:main', priority: 'normal' }))
const beta = { ...project, id: 'project-beta', title: 'Beta — Model review', body: '**Deliverable:** Review the economic model.\n\n## Key resources\n\n- [Model](models/beta.xlsx)' }
beta.properties = { home: { canvas: beta.body } }
beta.provenance = { ...project.provenance, sourcePath: '/preview/graph/project-beta.md' }
const opened = ref('')
// Local fixture IPC only. This page does not read or write a user's Graph.
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  if (command === 'graph_source') {
    const node = [project, beta].find(item => item.provenance.sourcePath === args.path)
    return node ? { node: structuredClone(node), sourceRevision: node.provenance.sourceRevision } : null
  }
  if (command === 'graph_update') {
    const node = [project, beta].find(item => item.id === args.patch.id)
    if (node.provenance.sourceRevision !== args.patch.expectedRevision) throw new Error('Revision conflict')
    Object.assign(node.properties, args.patch.setProperties)
    node.properties.home.updatedAt = new Date().toISOString()
    node.provenance.sourceRevision += '1'
    return structuredClone(node)
  }
  if (command === 'graph_get') return [project, beta, ...issues, ...owners].find(item => item.id === args.id)
  if (command === 'graph_query') {
    const rows = args.query.projectIds?.length ? issues.filter(item => args.query.projectIds.includes(item.projectId)) : [project, beta, ...issues, ...owners]
    return { items: rows.slice(args.query.offset, args.query.offset + args.query.limit), total: rows.length, graphRevision: 1 }
  }
  if (command === 'workspace_project_file_resolve') return `/preview/${args.relativePath}`
  if (command === 'plugin:opener|open_url') { opened.value = `URL: ${args.url}`; return }
  if (command === 'graph_events') return { items: [], total: 0 }
  if (command === 'graph_status') return { scopes: [{ id: 'team:main', kind: 'team' }], graphRevision: 1 }
  if (command === 'graph_link_targets') return args.ids.map(id => ({ id, status: 'resolved', title: owners.find(owner => owner.id === id)?.title || 'Analysis plan', kind: 'person' }))
  if (command === 'graph_references') return { outgoing: [], backlinks: [] }
  return []
} }
const pinia = createPinia()
const app = createApp({ setup() {
  const graph = useBusinessGraphStore()
  const settings = useSettingsStore()
  settings.businessGraphViewState = { section: 'home' }
  settings.settingsReady = true
  graph.nodes = [project, beta, ...owners, ...issues]
  graph.graphProjects = [project, beta]
  graph.status = { scopes: [{ id: 'team:main', kind: 'team' }], graphRevision: 1 }
  graph.activeScopeIds = ['team:main']
  graph.projectRoot = '/preview'
  graph.setWorkspaceConfiguration({ project: params.has('unlinked') ? '' : project.id })
  graph.workspaceProject = params.has('unlinked') ? null : project
  window.projectPreview = { graph, project, issues }
  return () => h('div', { class: 'preview-pane', style: { width: `${Number(params.get('width')) || 1000}px` } }, [
    h(BusinessGraphApp, { workspacePath: '/preview', active: true,
      onOpenGraphNode: request => { opened.value = `Entry: ${request.id}` },
      onOpenFile: request => { opened.value = `File: ${request.path}` },
      onConfigureWorkspace: () => { opened.value = 'Workspace settings' },
    }),
    opened.value ? h('output', { style: 'padding:8px;font-size:11px;color:var(--color-ink)' }, opened.value) : null,
  ])
} })
app.use(pinia).mount('#app')
