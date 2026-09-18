import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import '../src/shared/styles/fonts.css'
import '../src/shared/styles/themes.css'
import '../src/shared/styles/app.css'
import WorkBoard from '../src/mimir/apps/business-graph/WorkBoard.vue'
import EntityList from '../src/mimir/apps/business-graph/EntityList.vue'
import GraphViewbar from '../src/mimir/apps/business-graph/GraphViewbar.vue'
import GraphAppHeader from '../src/mimir/apps/business-graph/GraphAppHeader.vue'
import { useBusinessGraphStore } from '../src/stores/businessGraph.js'
import { useGraphViewState } from '../src/mimir/apps/business-graph/useGraphViewState.js'

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
  { id: 'project-retired', kind: 'project', title: 'Retired project' },
]
const people = [
  { id: 'person-waq', kind: 'person', title: 'Waq Rahman', teamMember: true, status: 'active' },
  { id: 'person-anna', kind: 'person', title: 'Anna Berg', teamMember: true, status: 'active' },
  { id: 'person-tom', kind: 'person', title: 'Tom Okafor', teamMember: true, status: 'active' },
]
const selfId = params.get('self') === '0' ? '' : 'person-waq'
const titles = {
  backlog: [
    'Draft comparator landscape for the European reimbursement submission', 'Scope RWE extraction template', 'Collect payer objections',
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
  cancelled: ['Retired comparator analysis'],
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
      assigneeId: n % 5 === 0 ? '' : people[n % people.length].id,
      waitingFor: status === 'waiting' ? (index % 2 ? 'Client confirmation' : 'you') : '',
      rank: n * 1000,
    })
  }
}

const groupBy = ref(params.get('group') || 'status')
const app = createApp({
  components: { WorkBoard },
  setup() {
    const graph = useBusinessGraphStore()
    graph.nodes = [...projects, ...people, ...issues]
    graph.setWorkspaceConfiguration({ project: params.get('workspace-project') || '' })
    graph.view = params.get('list') === '1' ? 'list' : 'board'
    const state = useGraphViewState({ graph, settings: { settingsReady: false, businessGraphSelfPersonId: selfId } })
    state.boardGroup.value = groupBy.value
    const toolbar = () => h(GraphViewbar, {
      section: 'work', sectionLabel: 'Work', view: graph.view,
      viewOptions: state.viewOptions.value,
      projectFilter: state.projectFilter.value, projectOptions: state.projectFilterOptions.value,
      projectEntry: state.projectEntry.value,
      onOpenProject: id => { window.openedProject = id },
      assigneeFilter: state.assigneeFilter.value, assigneeOptions: state.assigneeFilterOptions.value,
      priorityFilter: state.priorityFilter.value, priorityOptions: state.priorityFilterOptions,
      groupBy: state.boardGroup.value, groupOptions: state.boardGroupOptions,
      sortBy: state.boardSort.value, sortOptions: state.boardSortOptions,
      statuses: state.boardStatuses.value, collapsedStatuses: state.collapsedBoardStatuses.value,
      showClosedIssues: state.showClosedIssues.value,
      showEmptyProjects: state.showEmptyProjects.value,
      'onUpdate:showEmptyProjects': value => { state.showEmptyProjects.value = value },
      'onUpdate:showClosedIssues': value => { state.showClosedIssues.value = value },
      onSetView: value => { graph.view = value },
      'onUpdate:projectFilter': value => { state.projectFilter.value = value },
      'onUpdate:assigneeFilter': value => { state.assigneeFilter.value = value },
      'onUpdate:priorityFilter': value => { state.priorityFilter.value = value },
      'onUpdate:groupBy': value => { state.boardGroup.value = value },
      'onUpdate:sortBy': value => { state.boardSort.value = value },
      onToggleStatus: state.toggleBoardStatusCollapse,
      onExpandAll: state.expandAllBoardStatuses,
    })
    return () => [
      h(GraphAppHeader, {
        sections: state.sections, section: 'work', sectionLabel: 'Work',
        searchValue: graph.searchQuery, searchQuery: graph.searchQuery,
        resultCount: state.boardIssues.value.length,
        'onUpdate:searchValue': graph.prepareSearch, onClearSearch: graph.clearSearch,
      }),
      toolbar(),
      graph.view === 'list'
        ? h(EntityList, {
            nodes: state.boardIssues.value,
            lookup: [...projects, ...people, ...issues],
            projects,
            mode: 'work',
            groupBy: state.boardGroup.value,
            selfId,
            style: 'flex: 1 1 auto; min-height: 0;',
          })
        : h(WorkBoard, {
            issues: state.boardIssues.value,
            unfilteredIssues: state.unsearchedWorkIssues.value,
            showEmptyProjects: state.showEmptyProjects.value,
            statuses: state.boardStatuses.value,
            searchQuery: graph.searchQuery,
            nodes: [...projects, ...people, ...issues],
            projects,
            groupBy: state.boardGroup.value,
            collapsedStatuses: state.collapsedBoardStatuses.value,
            hideProject: state.projectScoped.value,
            onExpandColumn: state.expandBoardStatus,
            selfId,
            style: 'flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;',
          }),
    ]
  },
})
app.use(createPinia())
app.mount('#app')

if (params.get('menu') === '1') {
  setTimeout(() => {
    document.querySelector('[data-card-priority="issue-2"]')?.click()
  }, 600)
}
