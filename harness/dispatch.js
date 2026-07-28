import { createApp, h, ref } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import DispatchBar from '../src/mimir/apps/business-graph/DispatchBar.vue'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', params.get('theme') || 'parchment')

const nodes = [
  { id: 'issue-1', kind: 'issue', title: 'Build evidence map', status: 'in-progress', projectId: 'project-atlas', dueDate: '2030-06-30' },
  { id: 'issue-2', kind: 'issue', title: 'Confirm comparator set', status: 'waiting', projectId: 'project-atlas', waitingFor: 'Sanitized client confirmation' },
  { id: 'project-atlas', kind: 'project', title: 'Atlas', slug: 'atlas', summary: 'Global value evidence strategy' },
  { id: 'person-alex', kind: 'person', title: 'Alex Researcher', summary: 'HEOR lead at Acme' },
  { id: 'company-acme', kind: 'company', title: 'Acme', summary: 'Client' },
  { id: 'decision-1', kind: 'decision', title: 'Use the matched cohort', summary: 'Comparator decision' },
]

window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    if (cmd === 'graph_search') {
      const query = String(args?.query || '').toLowerCase()
      return nodes
        .filter(node => (
          node.title.toLowerCase().includes(query)
          || node.id.includes(query)
          || (node.summary || '').toLowerCase().includes(query)
        ))
        .map(node => ({ node }))
    }
    if (cmd === 'graph_context') {
      return {
        graphRevision: 42,
        markdown: [
          '# Business graph context',
          '',
          '## issue-1 · Build evidence map (issue)',
          'status: in-progress · priority: high · due 2030-06-30',
          'project: Atlas · assignee: Alex Researcher',
          '',
          '## project-atlas · Atlas (project)',
          'Global value evidence strategy for Acme.',
          '',
          '## person-alex · Alex Researcher (person)',
          'HEOR lead, Acme. Owns extraction QC.',
          '',
          '## decision-1 · Use the matched cohort (decision)',
          'Recorded 2030-05-12 by WA.',
        ].join('\n'),
      }
    }
    return null
  },
  transformCallback: () => 0,
  unregisterCallback: () => {},
}

const echoes = params.get('echo') === '1'
  ? [
      { id: 1, kind: 'job', text: '→ jana owes us the comparator list by friday', at: new Date(Date.now() - 9 * 60000).toISOString() },
      { id: 2, kind: 'echo', text: 'mimir call issues.move {"id":"issue-2","status":"waiting"}', at: new Date(Date.now() - 5 * 60000).toISOString() },
      { id: 3, kind: 'error', text: '/bord: unknown command (try /help)', at: new Date(Date.now() - 2 * 60000).toISOString() },
      { id: 4, kind: 'ok', text: '/board waiting — filter announced above the board', at: new Date(Date.now() - 60000).toISOString() },
    ]
  : []

const app = createApp({
  components: { DispatchBar },
  setup() {
    const bar = ref(null)
    return () => [
      h('div', { class: 'filler' }),
      h(DispatchBar, {
        ref: bar,
        scopeIds: ['private:local', 'project:alpha', 'team:main'],
        nodes,
        nodeCount: 412,
        echoes,
        running: params.get('run') === '1' ? 1 : 0,
        queued: params.get('run') === '1' ? 2 : 0,
      }),
    ]
  },
})
app.mount('#app')

const type = params.get('type')
if (type) {
  setTimeout(() => {
    const input = document.querySelector('[data-dispatch-input]')
    input.focus()
    input.value = type
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, 500)
}
