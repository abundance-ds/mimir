<template>
  <section
    ref="root"
    data-business-graph-app
    :data-graph-mode="focusMode ? 'focus' : graph.selectedNode ? 'peek' : 'scan'"
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
      @retry="refresh"
      @choose-workspace="$emit('chooseWorkspace')"
      @undo="undoDelete"
    />

    <GraphWorkspace
      v-if="workspacePath"
      ref="workspaceSurface"
      :focus-mode="focusMode"
      :current-section="currentSection"
      :view-options="viewOptions"
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
      :all-kind-filter="allKindFilter"
      :all-kind-options="allKindOptions"
      :composing="composing"
      :projection-nodes="projectionNodes"
      :empty-title="emptyTitle"
      :empty-copy="emptyCopy"
      :waiting-on-you-issues="waitingOnYouIssues"
      :now-seen-at="nowSeenAt"
      :can-summarise="summaryAgents.length > 0"
      :pending-meetings="pendingMeetings"
      :filing-meeting-id="filingMeetingId"
      :filing-error="filingError"
      :board-issues="boardIssues"
      :save-error="saveError"
      :saving="saving"
      :related-activities="relatedActivities"
      @set-view="setView"
      @update:project-filter="projectFilter = $event"
      @update:assignee-filter="assigneeFilter = $event"
      @update:board-group="boardGroup = $event"
      @update:board-sort="boardSort = $event"
      @update:priority-filter="priorityFilter = $event"
      @update:all-kind-filter="allKindFilter = $event"
      @toggle-board-status-collapse="toggleBoardStatusCollapse"
      @expand-all-board-statuses="expandAllBoardStatuses"
      @expand-board-status="expandBoardStatus"
      @open-node="openNode"
      @open-create="openCreate"
      @load-now-page="loadNowPage"
      @mark-now-seen="markNowSeen"
      @open-summary="summaryOpen = true"
      @file-meeting="fileMeeting"
      @load-meeting-detail="loadMeetingDetail"
      @save-meeting-graph-draft="saveMeetingGraphDraft"
      @load-older-meetings="loadOlderMeetings"
      @move-issue="moveIssue"
      @patch-issue="patchIssue"
      @bulk-patch-issues="bulkPatchIssues"
      @bulk-move-issues="bulkMoveIssues"
      @reorder-issue="reorderIssue"
      @create-from-board="createFromBoard"
      @return-to-peek="returnToPeek"
      @finalize-object-close="finalizeObjectClose"
      @save-node="saveNode"
      @delete-node="deleteNode"
      @open-related-node="openRelatedNode"
      @open-file="openFile"
      @open-url="openUrl"
      @open-activity="$emit('openActivity', $event)"
      @open-meeting="$emit('openMeeting', $event)"
      @open-related-create="openRelatedCreate"
      @navigate-object-history="navigateObjectHistory"
      @enter-focus="enterFocus"
    />

    <DispatchBar
      ref="dispatchBar"
      :scope-ids="graph.activeScopeIds"
      :nodes="graph.nodes"
      :node-count="graph.status?.nodeCount || graph.nodes.length"
      :echoes="dispatchEchoes"
      :running="dispatchRunningCount"
      :queued="dispatchQueue.length"
      @open-node="openNode"
      @dispatch="submitDispatch"
      @delegate="delegateWork"
      @power="runPowerCommand"
    />

    <GraphCreateDialog
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
    <GraphConfirmDialog
      :open="deleteOpen"
      :title="deleteTitle"
      :copy="deleteCopy"
      :busy="deleting"
      :error="deleteError"
      @close="closeDeleteDialog"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useActivitiesStore } from '../../stores/activities.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useLaunchersStore } from '../../stores/launchers.js'
import { useMeetingsStore } from '../../stores/meetings.js'
import { useBusinessGraphStore } from '../../stores/businessGraph.js'
import DispatchBar from './business-graph/DispatchBar.vue'
import GraphAppFeedback from './business-graph/GraphAppFeedback.vue'
import GraphAppHeader from './business-graph/GraphAppHeader.vue'
import GraphConfirmDialog from './business-graph/GraphConfirmDialog.vue'
import GraphCreateDialog from './business-graph/GraphCreateDialog.vue'
import GraphSummaryDialog from './business-graph/GraphSummaryDialog.vue'
import GraphWorkspace from './business-graph/GraphWorkspace.vue'
import { useGraphMeetings } from './business-graph/useGraphMeetings.js'
import { useGraphLifecycle } from './business-graph/useGraphLifecycle.js'
import { useGraphKeyboard } from './business-graph/useGraphKeyboard.js'
import { useGraphDispatch } from './business-graph/useGraphDispatch.js'
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
  'openFile',
  'openActivity',
  'startWork',
  'chooseWorkspace',
  'diagnostic',
  'openMeeting',
])
const activities = useActivitiesStore()
const settings = useSettingsStore()
const launchers = useLaunchersStore()
const meetings = useMeetingsStore()
const graph = useBusinessGraphStore()
const root = ref(null)
const appHeader = ref(null)
const workspaceSurface = ref(null)
const dispatchBar = ref(null)
useGraphLifecycle({
  graph,
  meetings,
  active: () => props.active,
  workspacePath: () => props.workspacePath,
  diagnostic: message => emit('diagnostic', message),
})

const {
  allKindFilter,
  allKindOptions,
  assigneeFilter,
  assigneeFilterOptions,
  boardGroup,
  boardGroupOptions,
  boardIssues,
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
  fileMeeting,
  filingError,
  filingMeetingId,
  loadMeetingDetail,
  loadOlderMeetings,
  pendingMeetings,
  saveMeetingGraphDraft,
} = useGraphMeetings({
  graph,
  meetings,
  diagnostic: message => emit('diagnostic', message),
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
  closeObject,
  enterFocus,
  finalizeObjectClose,
  focusEntry,
  focusMode,
  navigateObjectHistory,
  openFile,
  openNode,
  openRelatedNode,
  openUrl,
  refresh,
  restoreGraphFocus,
  returnToPeek,
  setSection,
  setView,
  toggleScope,
} = useGraphNavigation({
  graph,
  root,
  workspaceSurface,
  appHeader,
  workspacePath: () => props.workspacePath,
  diagnostic: message => emit('diagnostic', message),
  openFileResult: path => emit('openFile', path),
})
defineExpose({ focusEntry })
const {
  delegateWork,
  dispatchEchoes,
  dispatchQueue,
  dispatchRunningCount,
  echoToolCall,
  runPowerCommand,
  submitDispatch,
} = useGraphDispatch({
  graph,
  activities,
  sections,
  priorityFilter,
  kindFilter: allKindFilter,
  setSection,
  setView,
  openNode,
  startWork: request => emit('startWork', request),
  diagnostic: message => emit('diagnostic', message),
})
const {
  bulkMoveIssues,
  bulkPatchIssues,
  closeDeleteDialog,
  confirmDelete,
  createError,
  createFromBoard,
  createKind,
  createNode,
  createOpen,
  createStatus,
  creating,
  deleteCopy,
  deleteError,
  deleteNode,
  deleteOpen,
  deleteTitle,
  deleting,
  moveIssue,
  openCreate,
  openRelatedCreate,
  patchIssue,
  reorderIssue,
  saveError,
  saveNode,
  saving,
  undoDelete,
  undoError,
} = useGraphMutations({
  graph,
  boardIssues,
  diagnostic: message => emit('diagnostic', message),
  echoToolCall,
  restoreGraphFocus,
})
const { onKeydown } = useGraphKeyboard({
  graph,
  sections,
  appHeader,
  workspaceSurface,
  dispatchBar,
  deleteOpen,
  createOpen,
  focusMode,
  closeDeleteDialog,
  closeObject,
  enterFocus,
  navigateObjectHistory,
  openCreate,
  setSection,
})
// The shell stays mounted while the graph mounts so the topbar, viewbar, and
// dispatch bar paint immediately; only the projection waits for the first
// query, and a reload keeps the nodes already on screen.
const composing = computed(() => graph.loading && !graph.nodes.length)
const relatedActivities = computed(() => {
  const nodeId = graph.selectedNode?.id
  if (!nodeId) return []
  return activities.activities.filter(activity => activity.source?.graphNodeId === nodeId)
})
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
