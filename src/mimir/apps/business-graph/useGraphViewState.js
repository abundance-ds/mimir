import { computed, ref, watch } from 'vue'
import { BUSINESS_SECTIONS } from '../../../stores/businessGraph.js'
import { waitingOnHuman } from './predicates.js'
import { UNASSIGNED, WORK_STATUSES, initials, isClosedIssue, workProjectId } from './workRow.js'

export const BOARD_STATUSES = WORK_STATUSES

export const BOARD_GROUP_OPTIONS = Object.freeze([
  { value: 'status', label: 'By status' },
  { value: 'project', label: 'By project' },
])

export const BOARD_SORT_OPTIONS = Object.freeze([
  { value: 'rank', label: 'Manual order' },
  { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due date' },
  { value: 'updated', label: 'Updated' },
  { value: 'title', label: 'Title' },
])

export const PRIORITY_FILTER_OPTIONS = Object.freeze([
  { value: '', label: 'All priorities' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
])

export const ALL_KIND_OPTIONS = Object.freeze([
  { value: '', label: 'All kinds' },
  { value: 'issue', label: 'Tasks' },
  { value: 'project', label: 'Projects' },
  { value: 'person', label: 'People' },
  { value: 'company', label: 'Companies' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'journal', label: 'Journal' },
  { value: 'knowledge', label: 'Knowledge' },
])

const VIEWS_BY_SECTION = Object.freeze({
  all: [
    { id: 'list', label: 'List' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'meetings', label: 'Meetings' },
    { id: 'changes', label: 'Changes' },
  ],
  work: [
    { id: 'board', label: 'Board' },
    { id: 'list', label: 'List' },
  ],
})

export function useGraphViewState({ graph, settings }) {
  const projectFilter = ref('')
  const priorityFilter = ref('')
  const assigneeFilter = ref('')
  const boardGroup = ref('status')
  const boardSort = ref('rank')
  const allKindFilter = ref('')
  const collapsedBoardStatuses = ref([])
  const showClosedIssues = ref(false)
  const showEmptyProjects = ref(false)
  const workFilters = computed(() => ({
    project: projectFilter.value,
    priority: priorityFilter.value,
    assignee: assigneeFilter.value,
    showClosed: showClosedIssues.value,
  }))
  // Keep Done as a drop target. Cancelled has a column when closed work is shown.
  const boardStatuses = computed(() => BOARD_STATUSES.filter(status => (
    showClosedIssues.value || status.id !== 'cancelled'
  )))
  // Columns follow task filters, but search only filters cards within them.
  const unsearchedWorkIssues = computed(() => filterWorkIssues(
    graph.issues, graph.projects, workFilters.value,
  ))
  let hydrated = false

  const sections = BUSINESS_SECTIONS
  const currentSection = computed(() => sections.find(item => item.id === graph.section))
  const viewOptions = computed(() => VIEWS_BY_SECTION[graph.section] || VIEWS_BY_SECTION.all)
  const projectFilterOptions = computed(() => buildProjectOptions(graph))
  const selfPersonId = computed(() => String(settings.businessGraphSelfPersonId || '').trim())
  const assigneeFilterOptions = computed(() => (
    buildAssigneeOptions(graph, assigneeFilter.value, selfPersonId.value)
  ))
  /** One project scopes the view, so rows need not repeat it. */
  const projectScoped = computed(() => (
    Boolean(projectFilter.value) && projectFilter.value !== UNASSIGNED
  ))
  /** Board and List share the group control. */
  const listGroupBy = computed(() => boardGroup.value)
  const projectionNodes = computed(() => filterProjection(graph, {
    ...workFilters.value,
    kind: allKindFilter.value,
  }))
  const boardIssues = computed(() => (
    [...projectionNodes.value].sort(issueSort(boardSort.value))
  ))
  const waitingOnYouIssues = computed(() => graph.issues.filter(waitingOnHuman))
  const emptyTitle = computed(() => {
    if (graph.section === 'work') return 'No work matches this view'
    if (graph.searchQuery) return 'No matching graph items'
    return {
      work: 'No work in these scopes',
      all: 'The graph is empty',
    }[graph.section] || 'Nothing here yet'
  })
  const emptyCopy = computed(() => {
    if (graph.section === 'work') {
      return showClosedIssues.value
        ? 'Clear search or filters, include another scope, or create an issue.'
        : 'Clear search or filters, or enable Show closed issues in Display.'
    }
    return graph.searchQuery
      ? 'Try broader terms or include another physical scope.'
      : 'Create the first item or include another physical scope.'
  })

  // Restore old project filters as No project only after the graph is loaded.
  watch([() => graph.loading, () => graph.projects, projectFilter], () => {
    if (graph.loading || !graph.status || !projectFilter.value || projectFilter.value === UNASSIGNED) return
    if (!graph.projects.some(project => project.id === projectFilter.value)) {
      projectFilter.value = UNASSIGNED
    }
  })

  watch(
    () => settings.settingsReady,
    ready => {
      if (!ready || hydrated) return
      hydrateViewState({
        graph,
        settings,
        projectFilter,
        priorityFilter,
        assigneeFilter,
        boardGroup,
        boardSort,
        collapsedBoardStatuses,
        showClosedIssues,
        showEmptyProjects,
      })
      hydrated = true
    },
    { immediate: true },
  )

  watch(
    [
      () => graph.section,
      () => ({ ...graph.sectionViews }),
      projectFilter,
      boardGroup,
      boardSort,
      allKindFilter,
      priorityFilter,
      assigneeFilter,
      collapsedBoardStatuses,
      showClosedIssues,
      showEmptyProjects,
    ],
    () => {
      if (!hydrated) return
      settings.set('businessGraphViewState', {
        section: graph.section,
        sectionViews: { ...graph.sectionViews },
        graph: { kind: allKindFilter.value },
        work: {
          project: projectFilter.value,
          groupBy: boardGroup.value,
          sortBy: boardSort.value,
          priority: priorityFilter.value,
          assignee: assigneeFilter.value,
          collapsedStatuses: [...collapsedBoardStatuses.value],
          showClosedIssues: showClosedIssues.value,
          showEmptyProjects: showEmptyProjects.value,
        },
      })
    },
    { deep: true },
  )

  function toggleBoardStatusCollapse(id) {
    const collapsed = new Set(collapsedBoardStatuses.value)
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    collapsedBoardStatuses.value = BOARD_STATUSES
      .map(status => status.id)
      .filter(status => collapsed.has(status))
  }

  function expandAllBoardStatuses() {
    collapsedBoardStatuses.value = []
  }

  function expandBoardStatus(id) {
    collapsedBoardStatuses.value = collapsedBoardStatuses.value.filter(status => status !== id)
  }

  return {
    allKindFilter,
    allKindOptions: ALL_KIND_OPTIONS,
    assigneeFilter,
    assigneeFilterOptions,
    boardGroup,
    boardGroupOptions: BOARD_GROUP_OPTIONS,
    boardIssues,
    boardSort,
    boardSortOptions: BOARD_SORT_OPTIONS,
    boardStatuses,
    showClosedIssues,
    showEmptyProjects,
    unsearchedWorkIssues,
    collapsedBoardStatuses,
    currentSection,
    emptyCopy,
    emptyTitle,
    expandAllBoardStatuses,
    expandBoardStatus,
    listGroupBy,
    priorityFilter,
    priorityFilterOptions: PRIORITY_FILTER_OPTIONS,
    projectFilter,
    projectFilterOptions,
    projectionNodes,
    projectScoped,
    sections,
    selfPersonId,
    toggleBoardStatusCollapse,
    viewOptions,
    waitingOnYouIssues,
  }
}

function hydrateViewState({
  graph,
  settings,
  projectFilter,
  priorityFilter,
  assigneeFilter,
  boardGroup,
  boardSort,
  collapsedBoardStatuses,
  showClosedIssues,
  showEmptyProjects,
}) {
  const saved = settings.businessGraphViewState || {}
  const savedViews = saved.sectionViews && typeof saved.sectionViews === 'object'
    ? saved.sectionViews
    : {}
  const legacySection = ['projects', 'knowledge', 'journal', 'now'].includes(saved.section)
    ? saved.section
    : ''
  const validViews = Object.fromEntries(
    Object.entries(savedViews).filter(([section, view]) => (
      VIEWS_BY_SECTION[section]?.some(option => option.id === view)
    )),
  )
  graph.sectionViews = { ...graph.sectionViews, ...validViews }
  if (legacySection) {
    const legacyView = savedViews[legacySection]
    graph.sectionViews.all = legacySection === 'now'
      ? 'changes'
      : (VIEWS_BY_SECTION.all.some(option => option.id === legacyView) ? legacyView : 'list')
  }
  const savedSection = BUSINESS_SECTIONS.some(item => item.id === saved.section)
    ? saved.section
    : (legacySection ? 'all' : 'work')
  graph.section = savedSection
  graph.view = graph.sectionViews[savedSection]

  const work = saved.work || {}
  showClosedIssues.value = work.showClosedIssues === true
  showEmptyProjects.value = work.showEmptyProjects === true
  if (['status', 'project'].includes(work.groupBy)) boardGroup.value = work.groupBy
  if (typeof work.project === 'string') projectFilter.value = work.project
  if (['rank', 'priority', 'due', 'updated', 'title'].includes(work.sortBy)) boardSort.value = work.sortBy
  if (['', 'urgent', 'high', 'normal', 'low'].includes(work.priority)) priorityFilter.value = work.priority
  if (typeof work.assignee === 'string') assigneeFilter.value = work.assignee

  const knownStatuses = new Set(BOARD_STATUSES.map(status => status.id))
  if (Array.isArray(work.collapsedStatuses)) {
    collapsedBoardStatuses.value = work.collapsedStatuses.filter(status => knownStatuses.has(status))
  } else if (Array.isArray(work.visibleStatuses)) {
    const visible = new Set(work.visibleStatuses.filter(status => knownStatuses.has(status)))
    collapsedBoardStatuses.value = BOARD_STATUSES
      .map(status => status.id)
      .filter(status => !visible.has(status))
  }
}

function buildProjectOptions(graph) {
  const options = [...graph.projects]
    .sort((left, right) => projectLabel(left).localeCompare(projectLabel(right)))
    .map(project => ({
      value: project.id,
      label: projectLabel(project),
      hint: project.properties?.slug || project.slug || '',
    }))
  return [
    { value: '', label: 'All projects', separatorAfter: true },
    ...options,
    { value: '__unassigned__', label: 'No project' },
  ]
}

function filterProjection(graph, filters) {
  let items = graph.visibleNodes
  if (graph.section === 'work') {
    items = filterWorkIssues(items, graph.projects, filters)
  }
  if (graph.section === 'all' && filters.kind) {
    items = items.filter(item => matchesAllKind(item, filters.kind))
  }
  return items
}

function filterWorkIssues(items, projects, filters) {
  if (!filters.showClosed) items = items.filter(item => !isClosedIssue(item))
  if (filters.project) {
    const projectIds = new Set(projects.map(project => project.id))
    items = items.filter(item => workProjectId(item, projectIds) === filters.project)
  }
  if (filters.priority) items = items.filter(item => item.priority === filters.priority)
  if (filters.assignee === UNASSIGNED) items = items.filter(item => !item.assigneeId)
  else if (filters.assignee) items = items.filter(item => item.assigneeId === filters.assignee)
  return items
}

function matchesAllKind(item, filter) {
  if (filter === 'knowledge') {
    return [
      'note', 'resource', 'decision', 'record', 'study', 'evidence', 'dataset', 'analysis',
      'model', 'endpoint', 'publication', 'submission', 'research-question', 'method',
      'client-request',
    ].includes(item.kind)
  }
  return item.kind === filter
}

function issueSort(mode) {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 }
  return (left, right) => {
    if (mode === 'rank') {
      return (Number(left.rank) || Number.MAX_SAFE_INTEGER)
        - (Number(right.rank) || Number.MAX_SAFE_INTEGER)
        || (priority[left.priority] ?? 2) - (priority[right.priority] ?? 2)
        || left.title.localeCompare(right.title)
    }
    if (mode === 'due') {
      return String(left.dueDate || '9999').localeCompare(String(right.dueDate || '9999'))
        || left.title.localeCompare(right.title)
    }
    if (mode === 'updated') {
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
        || left.title.localeCompare(right.title)
    }
    if (mode === 'title') return left.title.localeCompare(right.title)
    return (priority[left.priority] ?? 2) - (priority[right.priority] ?? 2)
      || String(left.dueDate || '9999').localeCompare(String(right.dueDate || '9999'))
      || left.title.localeCompare(right.title)
  }
}

/**
 * Owner filter options: You (when configured), active team members, and
 * Unassigned. A selected person outside that list stays selectable so the
 * filter never hides silently.
 */
function buildAssigneeOptions(graph, selected, selfId) {
  const byId = new Map(graph.people.map(person => [person.id, person]))
  const team = graph.people
    .filter(person => person.teamMember && person.status === 'active')
    .sort((left, right) => personLabel(left).localeCompare(personLabel(right)))
  const options = []
  const self = selfId ? byId.get(selfId) : null
  if (self) options.push({ value: self.id, label: 'You', hint: personLabel(self) })
  for (const person of team) {
    if (person.id === selfId) continue
    options.push({
      value: person.id,
      label: personLabel(person),
      hint: initials(personLabel(person)),
    })
  }
  if (selected && selected !== UNASSIGNED && !options.some(option => option.value === selected)) {
    const known = byId.get(selected)
    options.push({
      value: selected,
      label: known ? personLabel(known) : selected,
      hint: known ? 'Not an active team member' : 'Unavailable person',
    })
  }
  return [
    { value: '', label: 'Anyone', separatorAfter: true },
    ...options,
    { value: UNASSIGNED, label: 'Unassigned' },
  ]
}

function personLabel(person) {
  return person?.title || person?.id || 'Unnamed person'
}

function projectLabel(project) {
  return project?.title || project?.properties?.slug || project?.slug || project?.id || 'Untitled project'
}
