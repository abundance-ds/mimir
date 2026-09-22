import { createApp, h, ref } from 'vue'
import '../src/shared/styles/app.css'
import GraphCreateDialog from '../src/mimir/apps/business-graph/GraphCreateDialog.vue'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'parchment'
const projects = [{ id: 'atlas', kind: 'project', title: 'Atlas' }, { id: 'oncology', kind: 'project', title: 'Oncology model' }]
const people = [{ id: 'anna', kind: 'person', title: 'Anna Berg' }]
// Fixture-only preview. No user Graph files are read or written.
const references = [
  { id: 'utility', title: 'Utility extraction', kind: 'note', scopeId: 'team:main' },
  ...Array.from({ length: 11 }, (_, index) => ({ id: `source-${index}`, title: `Utility source ${index + 1}`, kind: 'resource', scopeId: 'team:main' })),
]
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  if (command === 'graph_lookup') return references.filter(node => node.title.toLowerCase().includes(args.query.toLowerCase()))
  if (command === 'graph_link_targets') return args.ids.map(id => ({ ...references.find(node => node.id === id), status: 'resolved' }))
  return []
} }
createApp({ setup() {
  const open = ref(true)
  const result = ref('')
  return () => h('main', { style: 'padding:24px' }, [
    h('button', { onClick: () => { open.value = true } }, 'New issue'),
    h('pre', { 'data-preview-result': '', style: 'white-space:pre-wrap' }, result.value),
    h(GraphCreateDialog, {
      open: open.value,
      initialKind: 'issue', initialProjectId: 'atlas', projects, nodes: people,
      scopes: [{ id: 'team:main', kind: 'team' }, { id: 'private:local', kind: 'private' }],
      scopeIds: ['team:main'],
      onClose: () => { open.value = false },
      onCreate: (value, controls) => {
        result.value = JSON.stringify(value, null, 2)
        if (controls.another) controls.reset()
        else open.value = false
      },
    }),
  ])
} }).mount('#app')
