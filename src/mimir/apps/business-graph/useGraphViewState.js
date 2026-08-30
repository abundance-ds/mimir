import { computed, ref, watch } from 'vue'
import { BUSINESS_SECTIONS } from '../../../stores/businessGraph.js'
import { waitingOnHuman } from './predicates.js'

export const BOARD_STATUSES = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
])

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
  { value: 'decision', label: 'Decisions' },
  { value: 'knowledge', label: 'Knowledge' },
])

const VIEWS_BY_SECTION = Object.freeze({
  now: [{ id: 'stream', label: 'Stream' }],
  work: [
    { id: 'board', label: 'Board' },
    { id: 'list', label: 'List' },
    { id: 'attention', label: 'Attention' },
  ],
  projects: [
    { id: 'portfolio', label: 'Portfolio' },
    { id: 'list', label: 'List' },
    { id: 'timeline', label: 'Timeline' },
  ],
  knowledge: [
    { id: 'meetings', label: 'Meetings' },
    { id: 'list', label: 'List' },
    { id: 'timeline', label: 'Timeline' },
  ],
  journal: [
    { id: 'list', label: 'List' },
    { id: 'timeline', label: 'Timeline' },
  ],
  all: [
    { id: 'list', label: 'List' },
    { id: 'timeline', label: 'Timeline' },
  ],
})

export function useGraphViewState({ graph, settings }) {
  const projectFilter = ref('')
  const priorityFilter = ref('')
  const boardGroup = ref('status')
  const boardSort = ref('rank')
  const allKindFilter = ref('')
  const collapsedBoardStatuses = ref([])
  let hydrated = false

  const sections = BUSINESS_SECTIONS
  const currentSection = computed(() => sections.find(item => item.id === graph.section))
  const viewOptions = computed(() => VIEWS_BY_SECTION[graph.section] || VIEWS_BY_SECTION.all)
  const projectFilterOptions = computed(() => buildProjectOptions(graph, projectFilter.value))
  const projectionNodes = computed(() => filterProjection(graph, {
    project: projectFilter.value,
    priority: priorityFilter.value,
    kind: allKindFilter.value,
  }))
  const boardIssues = computed(() => (
    [...projectionNodes.value].sort(issueSort(boardSort.value))
  ))
  const waitingOnYouIssues = computed(() => graph.issues.filter(waitingOnHuman))
  const emptyTitle = computed(() => {
    if (graph.searchQuery) return 'No matching graph items'
    return {
      work: 'No work in these scopes',
      projects: 'No projects yet',
      knowledge: 'No knowledge yet',
      all: 'The graph is empty',
    }[graph.section] || 'Nothing here yet'
  })
  const emptyCopy = computed(() => (
    graph.searchQuery
      ? 'Try broader terms or include another physical scope.'
      : 'Create the first item or include another physical scope.'
  ))

  watch(
    () => settings.settingsReady,
    ready => {
      if (!ready || hydrated) return
      hydrateViewState({ graph, settings, projectFilter, priorityFilter, boardGroup, boardSort, collapsedBoardStatuses })
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
      priorityFilter,
      collapsedBoardStatuses,
    ],
    () => {
      if (!hydrated) return
      settings.set('businessGraphViewState', {
        section: graph.section,
        sectionViews: { ...graph.sectionViews },
        work: {
          project: projectFilter.value,
          groupBy: boardGroup.value,
          sortBy: boardSort.value,
          priority: priorityFilter.value,
          collapsedStatuses: [...collapsedBoardStatuses.value],
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
    boardGroup,
    boardGroupOptions: BOARD_GROUP_OPTIONS,
    boardIssues,
    boardSort,
    boardSortOptions: BOARD_SORT_OPTIONS,
    boardStatuses: BOARD_STATUSES,
    collapsedBoardStatuses,
    currentSection,
    emptyCopy,
    emptyTitle,
    expandAllBoardStatuses,
    expandBoardStatus,
    priorityFilter,
    priorityFilterOptions: PRIORITY_FILTER_OPTIONS,
    projectFilter,
    projectFilterOptions,
    projectionNodes,
    sections,
    toggleBoardStatusCollapse,
    viewOptions,
    waitingOnYouIssues,
  }
}

function hydrateViewState({ graph, settings, projectFilter, priorityFilter, boardGroup, boardSort, collapsedBoardStatuses }) {
  const saved = settings.businessGraphViewState || {}
  const savedViews = saved.sectionViews && typeof saved.sectionViews === 'object'
    ? saved.sectionViews
    : {}
  graph.sectionViews = {
    ...graph.sectionViews,
    ...Object.fromEntries(
      Object.entries(savedViews).filter(([section, view]) => (
        VIEWS_BY_SECTION[section]?.some(option => option.id === view)
      )),
    ),
  }
  const savedSection = BUSINESS_SECTIONS.some(item => item.id === saved.section)
    ? saved.section
    : 'work'
  graph.section = savedSection
  graph.view = graph.sectionViews[savedSection]

  const work = saved.work || {}
  if (['status', 'project'].includes(work.groupBy)) boardGroup.value = work.groupBy
  if (typeof work.project === 'string') projectFilter.value = work.project
  if (['rank', 'priority', 'due', 'updated', 'title'].includes(work.sortBy)) boardSort.value = work.sortBy
  if (['', 'urgent', 'high', 'normal', 'low'].includes(work.priority)) priorityFilter.value = work.priority

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

function buildProjectOptions(graph, selectedProject) {
  const options = [...graph.projects]
    .sort((left, right) => projectLabel(left).localeCompare(projectLabel(right)))
    .map(project => ({
      value: project.id,
      label: projectLabel(project),
      hint: project.properties?.slug || project.slug || '',
    }))
  const knownIds = new Set(graph.projects.map(project => project.id))
  const legacyProjects = [...new Set(
    graph.issues
      .map(issue => String(issue.projectId || '').trim())
      .filter(projectId => projectId && !knownIds.has(projectId)),
  )].sort((left, right) => left.localeCompare(right))
  for (const projectId of legacyProjects) {
    options.push({ value: projectId, label: projectId, hint: 'Legacy project' })
  }
  if (
    selectedProject
    && selectedProject !== '__unassigned__'
    && !options.some(option => option.value === selectedProject)
  ) {
    options.push({ value: selectedProject, label: selectedProject, hint: 'Unavailable project' })
  }
  return [
    { value: '', label: 'All projects', separatorAfter: true },
    ...options,
    { value: '__unassigned__', label: 'No project' },
  ]
}

function filterProjection(graph, filters) {
  let items = graph.visibleNodes
  if (graph.section === 'work') {
    if (filters.project === '__unassigned__') items = items.filter(item => !item.projectId)
    else if (filters.project) items = items.filter(item => item.projectId === filters.project)
    if (filters.priority) items = items.filter(item => item.priority === filters.priority)
    if (graph.view === 'attention') items = items.filter(needsAttention)
  }
  if (graph.section === 'all' && filters.kind) {
    items = items.filter(item => matchesAllKind(item, filters.kind))
  }
  return items
}

function matchesAllKind(item, filter) {
  if (filter === 'knowledge') {
    const definition = BUSINESS_SECTIONS.find(section => section.id === 'knowledge')
    return definition?.kinds?.includes(item.kind)
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

function needsAttention(issue) {
  if (issue.status === 'waiting' || issue.waitingFor) return true
  if (issue.priority === 'urgent' && !['done', 'cancelled'].includes(issue.status)) return true
  const today = new Date().toISOString().slice(0, 10)
  return Boolean(issue.dueDate)
    && issue.dueDate < today
    && !['done', 'cancelled'].includes(issue.status)
}

function projectLabel(project) {
  return project?.title || project?.properties?.slug || project?.slug || project?.id || 'Untitled project'
}
