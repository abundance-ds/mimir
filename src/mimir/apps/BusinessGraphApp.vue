<template>
  <section
    ref="root"
    data-business-graph-app
    class="business-graph relative flex h-full min-h-0 flex-col overflow-hidden text-ink"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <GraphAppHeader
      ref="appHeader"
      :sections="sections"
      :section="graph.section"
      :section-label="currentSection?.label"
      :search-value="searchDraft"
      :search-query="graph.searchQuery"
      :search-pending="searchPending"
      :searching="graph.searching"
      :result-count="projectionNodes.length"
      :scopes="graph.scopes"
      :active-scope-ids="graph.activeScopeIds"
      :scope-counts="graph.scopeCounts"
      :refreshing="graph.refreshing"
      @set-section="setSection"
      @update:search-value="onSearchInput"
      @focus-search-results="focusSearchResults"
      @flush-search="flushSearch"
      @search-escape="onSearchEscape"
      @clear-search="clearSearch"
      @toggle-scope="toggleScope"
      @refresh="refresh"
      @create="openCreate()"
    />

    <GraphAppFeedback
      :error="graph.error"
      :has-workspace="Boolean(workspacePath)"
      :last-deletion="graph.lastDeletion"
      :undo-error="undoError"
      :closed-issue-undo="closedIssueUndo"
      :closed-issue-undo-error="closedIssueUndoError"
      :undoing-closed-issues="undoingClosedIssues"
      @undo-closed-issues="undoClosedIssues"
      @dismiss-closed-issue-undo="dismissClosedIssueUndo"
      @retry="refresh"
      @choose-workspace="$emit('chooseWorkspace')"
      @undo="undoDelete"
    />

    <GraphWorkspace
      @configure-workspace="$emit('configureWorkspace')"
      v-if="workspacePath"
      ref="workspaceSurface"
      :current-section="currentSection"
      :view-options="viewOptions"
      :graph-sort="graphSort"
      :project-filter="projectFilter"
      :project-filter-options="projectFilterOptions"
      :assignee-filter="assigneeFilter"
      :assignee-filter-options="assigneeFilterOptions"
      :self-person-id="selfPersonId"
      :project-scoped="projectScoped"
      :list-group-by="listGroupBy"
      :board-group="boardGroup"
      :board-group-options="boardGroupOptions"
      :board-sort="boardSort"
      :board-sort-options="boardSortOptions"
      :priority-filter="priorityFilter"
      :priority-filter-options="priorityFilterOptions"
      :collapsed-board-statuses="collapsedBoardStatuses"
      :board-statuses="boardStatuses"
      :composing="composing"
      :projection-nodes="projectionNodes"
      :empty-title="emptyTitle"
      :empty-copy="emptyCopy"
      :waiting-on-you-issues="waitingOnYouIssues"
      :now-seen-at="nowSeenAt"
      :can-summarise="summaryAgents.length > 0"
      :board-issues="boardIssues"
      :unsearched-work-issues="unsearchedWorkIssues"
      :show-closed-issues="showClosedIssues"
      :show-empty-projects="showEmptyProjects"
      @set-view="setView"
      @sort-graph="setGraphSort"
      @update:project-filter="projectFilter = $event"
      @update:assignee-filter="assigneeFilter = $event"
      @update:board-group="boardGroup = $event"
      @update:board-sort="boardSort = $event"
      @update:show-closed-issues="showClosedIssues = $event"
      @update:show-empty-projects="showEmptyProjects = $event"
      @update:priority-filter="priorityFilter = $event"
      @toggle-board-status-collapse="toggleBoardStatusCollapse"
      @expand-all-board-statuses="expandAllBoardStatuses"
      @expand-board-status="expandBoardStatus"
      @open-node="openNode"
      @open-create="openCreate"
      @load-now-page="loadNowPage"
      @mark-now-seen="markNowSeen"
      @open-summary="summaryOpen = true"
      @move-issue="moveIssue"
      @patch-issue="patchIssue"
      @bulk-patch-issues="bulkPatchIssues"
      @bulk-move-issues="bulkMoveIssues"
      @reorder-issue="reorderIssue"
      @create-from-board="createFromBoard"
    />

    <GraphCreateDialog
      :nodes="graph.nodes"
      :self-person-id="settings.businessGraphSelfPersonId || ''"
      :scope-ids="graph.activeScopeIds"
      :graph-revision="graph.status?.graphRevision || 0"
      :open="createOpen"
      :scopes="graph.scopes"
      :initial-kind="createKind"
      :initial-status="createStatus"
      :default-scope="graph.workspaceGraphScope"
      :saving="creating"
      :error="createError"
      @close="createOpen = false"
      @create="createNode"
    />
    <GraphSummaryDialog
      :open="summaryOpen"
      :agents="summaryAgents"
      :busy="summaryPreparing"
      @close="closeSummary"
      @launch="launchSummary"
    />
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings.js'
import { useLaunchersStore } from '../../stores/launchers.js'
import { useBusinessGraphStore } from '../../stores/businessGraph.js'
import GraphAppFeedback from './business-graph/GraphAppFeedback.vue'
import GraphAppHeader from './business-graph/GraphAppHeader.vue'
import GraphCreateDialog from './business-graph/GraphCreateDialog.vue'
import GraphSummaryDialog from './business-graph/GraphSummaryDialog.vue'
import GraphWorkspace from './business-graph/GraphWorkspace.vue'
import { useGraphKeyboard } from './business-graph/useGraphKeyboard.js'
import { useGraphMutations } from './business-graph/useGraphMutations.js'
import { useGraphNavigation } from './business-graph/useGraphNavigation.js'
import { useGraphSearch } from './business-graph/useGraphSearch.js'
import { useGraphSummary } from './business-graph/useGraphSummary.js'
import { useGraphViewState } from './business-graph/useGraphViewState.js'

const props = defineProps({
  workspacePath: { type: String, default: '' },
  active: { type: Boolean, default: false },
})

const emit = defineEmits([
  'openGraphNode',
  'startWork',
  'chooseWorkspace',
  'configureWorkspace',
  'diagnostic',
])
const settings = useSettingsStore()
const launchers = useLaunchersStore()
const graph = useBusinessGraphStore()
const root = ref(null)
const appHeader = ref(null)
const workspaceSurface = ref(null)

const {
  graphSort,
  setGraphSort,
  assigneeFilter,
  assigneeFilterOptions,
  boardGroup,
  boardGroupOptions,
  boardIssues,
  unsearchedWorkIssues,
  showClosedIssues,
  showEmptyProjects,
  boardSort,
  boardSortOptions,
  boardStatuses,
  collapsedBoardStatuses,
  currentSection,
  emptyCopy,
  emptyTitle,
  expandAllBoardStatuses,
  expandBoardStatus,
  listGroupBy,
  priorityFilter,
  priorityFilterOptions,
  projectFilter,
  projectFilterOptions,
  projectionNodes,
  projectScoped,
  sections,
  selfPersonId,
  toggleBoardStatusCollapse,
  viewOptions,
  waitingOnYouIssues,
} = useGraphViewState({ graph, settings })
const {
  clearSearch,
  flushSearch,
  focusSearchResults,
  onSearchEscape,
  onSearchInput,
  searchDraft,
  searchPending,
} = useGraphSearch({
  graph,
  projectionNodes,
  focusResults: edge => workspaceSurface.value?.focusListEdge(edge),
  focusInput: () => appHeader.value?.focusSearch(),
})
const {
  closeSummary,
  launchSummary,
  loadNowPage,
  markNowSeen,
  nowSeenAt,
  summaryAgents,
  summaryOpen,
  summaryPreparing,
} = useGraphSummary({
  graph,
  launchers,
  settings,
  diagnostic: message => emit('diagnostic', message),
  startWork: request => emit('startWork', request),
})
const {
  focusEntry,
  openNode,
  refresh,
  restoreGraphFocus,
  setSection,
  setView,
  toggleScope,
} = useGraphNavigation({
  graph,
  root,
  workspaceSurface,
  appHeader,
  diagnostic: message => emit('diagnostic', message),
  openGraphNode: request => emit('openGraphNode', request),
})
defineExpose({ focusEntry })
watch(
  [() => graph.requestedNodeId, () => props.active, () => graph.loading, () => graph.projectRoot],
  ([id, active, loading, workspace]) => {
    if (!id || !active || loading || workspace !== props.workspacePath) return
    graph.requestedNodeId = ''
    openNode(id)
  },
  { immediate: true, flush: 'post' },
)
const {
  bulkMoveIssues,
  bulkPatchIssues,
  createError,
  createFromBoard,
  createKind,
  createNode,
  createOpen,
  createStatus,
  creating,
  moveIssue,
  openCreate,
  patchIssue,
  reorderIssue,
  undoDelete,
  undoError,
  closedIssueUndo,
  closedIssueUndoError,
  undoingClosedIssues,
  undoClosedIssues,
  dismissClosedIssueUndo,
} = useGraphMutations({
  graph,
  boardIssues,
  diagnostic: message => emit('diagnostic', message),
  restoreGraphFocus,
  openNode,
})
const { onKeydown } = useGraphKeyboard({
  sections,
  appHeader,
  workspaceSurface,
  createOpen,
  openCreate,
  setSection,
})
// Keep navigation mounted while the first projection loads.
const composing = computed(() => graph.loading && !graph.nodes.length)
</script>

<style scoped>
.business-graph {
  container: business-graph / inline-size;
  --graph-canvas: var(--color-chrome-high);
  --graph-raised: var(--color-surface);
  --graph-hover: var(--color-chrome-mid);
  --graph-focus: color-mix(in srgb, var(--color-accent) 24%, transparent);
  --graph-shadow:
    0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent);
  font-family: var(--font-sans);
  background: var(--graph-canvas);
}

@media (prefers-reduced-motion: reduce) {
  .business-graph *,
  .business-graph *::before,
  .business-graph *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
</style>
