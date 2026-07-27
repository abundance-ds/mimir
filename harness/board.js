import { createApp, h, ref } from 'vue'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import WorkBoard from '../src/mim/apps/business-graph/WorkBoard.vue'
import GraphFilterBanner from '../src/mim/apps/business-graph/GraphFilterBanner.vue'
import StatusRail from '../src/mim/apps/business-graph/StatusRail.vue'
import StatusRailPanel from '../src/mim/apps/business-graph/StatusRailPanel.vue'

const params = new URLSearchParams(location.search)
document.documentElement.setAttribute('data-theme', params.get('theme') || 'parchment')

const today = new Date()
const iso = offset => {
  const date = new Date(today)
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

const projects = [
  { id: 'project-atlas', kind: 'project', title: 'Atlas', properties: { slug: 'atlas' } },
  { id: 'project-ember', kind: 'project', title: 'Ember', properties: { slug: 'ember' } },
]
const titles = {
  backlog: [
    'Draft comparator landscape', 'Scope RWE extraction template', 'Collect payer objections',
    'Review search strategy', 'Outline evidence gaps',
  ],
  plan: [
    'Extract evidence table', 'Confirm comparator set', 'Book client walkthrough',
    'Draft model schematic',
  ],
  'in-progress': [
    'Build evidence map', 'Screen 240 abstracts', 'Clean trial registry extract',
    'Draft value story spine',
  ],
  waiting: [
    'Client sign-off on protocol', 'Sanitized data transfer', 'Statistician review',
  ],
  review: ['QC extraction sheet', 'Internal readout deck'],
  done: ['Kickoff notes filed', 'Feasibility count'],
}
const priorities = ['urgent', 'high', 'normal', 'low', 'normal', 'high']
const statuses = Object.keys(titles)
const issues = []
let n = 0
for (const status of statuses) {
  for (const [index, title] of titles[status].entries()) {
    n += 1
    const due = n % 5 === 0
      ? iso(-(n % 3) - 1)
      : n % 3 === 0
        ? iso((n % 6) + 1)
        : n % 4 === 0 ? iso(20) : ''
    issues.push({
      id: `issue-${n}`,
      kind: 'issue',
      title,
      status,
      priority: priorities[n % priorities.length],
      dueDate: due,
      projectId: n % 3 === 0 ? 'project-ember' : 'project-atlas',
      waitingFor: status === 'waiting' ? (index % 2 ? 'Client confirmation' : 'Internal review') : '',
      rank: n * 1000,
    })
  }
}
const actors = Object.fromEntries(issues.map((issue, index) => [
  issue.id,
  index % 4 === 0
    ? { kind: 'agent', label: 'Codex', initials: 'CX' }
    : { kind: 'human', label: 'Waq R', initials: 'WA' },
]))

const activities = [
  { id: 'act-1', kind: 'agent', title: 'Work · Build evidence map', status: 'working', updatedAt: new Date().toISOString() },
  { id: 'act-2', kind: 'agent', title: 'Dispatch · file payer objections', status: 'needs-input', updatedAt: new Date(Date.now() - 7 * 60000).toISOString() },
  { id: 'act-3', kind: 'terminal', title: 'Shell', status: 'idle', updatedAt: new Date().toISOString() },
]
const diagnostics = params.get('diag') === '1'
  ? [{ level: 'warning', code: 'relation-unresolved', message: 'Relation target “evidence-paper” is missing', nodeId: 'issue-7' }]
  : []

const groupBy = ref(params.get('group') || 'status')
const app = createApp({
  components: { WorkBoard, GraphFilterBanner },
  setup() {
    return () => [
      params.get('filter') === '1'
        ? h(GraphFilterBanner, {
            label: 'priority = high',
            hiddenCount: 11,
            'data-graph-control': 'x',
          })
        : null,
      params.get('filter') === '1'
        ? h(GraphFilterBanner, {
            label: 'columns hidden: Review, Done',
            hiddenCount: 4,
          })
        : null,
      h('div', { style: 'flex: 1 1 auto; min-height: 0; display: flex; background: var(--color-rule); gap: 1px;' }, [
        h(StatusRail, {
          issues,
          activities,
          diagnostics,
          active: params.get('rail') || '',
        }),
        params.get('panel')
          ? h('div', { style: 'flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;' }, [
              h(GraphFilterBanner, {
                label: params.get('panel') === 'agents' ? 'active agents' : 'diagnostics',
              }),
              h(StatusRailPanel, {
                kind: params.get('panel'),
                activities: activities.filter(a => a.kind === 'agent'),
                diagnostics,
              }),
            ])
          : h(WorkBoard, {
              issues,
              nodes: [...projects, ...issues],
              projects,
              actors,
              groupBy: groupBy.value,
              visibleStatuses: statuses,
              style: 'flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;',
            }),
      ]),
    ]
  },
})
app.mount('#app')

if (params.get('menu') === '1') {
  setTimeout(() => {
    document.querySelector('[data-card-priority="issue-2"]')?.click()
  }, 600)
}
