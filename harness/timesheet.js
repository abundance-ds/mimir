import { createApp, h, reactive } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import GraphInspector from '../src/mimir/apps/business-graph/GraphInspector.vue'
import { graphDocumentState } from '../src/stores/graphDocuments.js'
import { buildInspectorSave } from '../src/mimir/apps/business-graph/graphInspectorPersistence.js'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', params.get('theme') || 'parchment')
// This preview uses fixture data. Native persistence is covered by Graph tests.
window.__TAURI_INTERNALS__ = { invoke: async command => {
  if (command === 'graph_references') return { outgoing: [], backlinks: [] }
  return []
} }
const nodes = [
  { id: 'project-atlas', kind: 'project', title: 'Atlas' },
  { id: 'person-alex', kind: 'person', title: 'Alex Rivera' },
]
const node = {
  id: 'atlas-september', kind: 'timesheet', title: 'Atlas — September 2026', summary: '', tags: [],
  body: 'Client reference: PO-1042.\n\nInclude a short description of each task in the monthly report.',
  relations: [{ relation: 'part_of', target: 'project-atlas' }, { relation: 'assigned_to', target: 'person-alex' }],
  properties: { period: '2026-09', entries: [
    { id: 't1', date: '2026-09-14', minutes: 120, description: 'Review the export requirements', invoice: 'INV-014' },
    { id: 't2', date: '2026-09-14', minutes: 45, description: 'Project meeting', invoice: 'INV-014' },
    { id: 't3', date: '2026-09-15', minutes: 90, description: 'Test the export' },
    { id: 't4', date: '2026-09-15', minutes: 30, description: 'Review client comments' },
    { id: 't5', date: '2026-09-16', minutes: 75, description: 'Correct the date format' },
  ] },
  provenance: { scopeId: 'team:main', scopeKind: 'team', sourceRevision: 'fixture', sourcePath: '/preview/graph/atlas-september.md' },
}
const file = reactive({ id: 'preview', kind: 'graph', path: node.provenance.sourcePath,
  dirty: false, saveState: 'idle', graph: graphDocumentState({ node, sourceRevision: 'fixture', bodyFrom: 0 }) })
const viewState = { path: file.path, note: null, scrollTop: 0 }
createApp({ setup() {
  return () => h('div', { class: 'preview-pane', style: { width: `${Number(params.get('width')) || 760}px` } }, [
    h(GraphInspector, { documentFile: file, nodes, viewState, onDraftChange: () => { file.dirty = true },
      onSave: () => {
        try {
          const { payload } = buildInspectorSave({ node: file.graph.node, nodes, draft: file.graph.draft, tags: [] })
          const saved = { ...file.graph.node, title: payload.title, body: payload.body, relations: payload.relations, properties: payload.setProperties }
          file.graph = graphDocumentState({ node: saved, sourceRevision: 'fixture', bodyFrom: 0 })
          file.dirty = false; file.saveState = 'saved'
        } catch { file.saveState = 'failed' }
      },
    }),
  ])
} }).mount('#app')
