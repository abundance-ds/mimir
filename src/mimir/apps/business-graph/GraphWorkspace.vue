<template>
  <div class="graph-workspace relative flex min-h-0 flex-1">
    <main class="flex min-w-0 flex-1 flex-col">
      <GraphViewbar
        v-if="graph.section === 'work'"
        ref="viewbar"
        :section="graph.section"
        :section-label="currentSection?.label"
        :view="graph.view"
        :view-options="viewOptions"
        :project-filter="projectFilter"
        :project-options="projectFilterOptions"
        :assignee-filter="assigneeFilter"
        :assignee-options="assigneeFilterOptions"
        :group-by="boardGroup"
        :group-options="boardGroupOptions"
        :sort-by="boardSort"
        :show-closed-issues="showClosedIssues"
        :show-empty-projects="showEmptyProjects"
        :sort-options="boardSortOptions"
        :priority-filter="priorityFilter"
        :priority-options="priorityFilterOptions"
        :collapsed-statuses="collapsedBoardStatuses"
        :statuses="boardStatuses"
        @configure-workspace="$emit('configureWorkspace')"
        @set-view="$emit('setView', $event)"
        @update:project-filter="$emit('update:projectFilter', $event)"
        @update:assignee-filter="$emit('update:assigneeFilter', $event)"
        @update:group-by="$emit('update:boardGroup', $event)"
        @update:sort-by="$emit('update:boardSort', $event)"
        @update:show-closed-issues="$emit('update:showClosedIssues', $event)"
        @update:show-empty-projects="$emit('update:showEmptyProjects', $event)"
        @update:priority-filter="$emit('update:priorityFilter', $event)"
        @toggle-status="$emit('toggleBoardStatusCollapse', $event)"
        @expand-all="$emit('expandAllBoardStatuses')"
      />
      <div v-if="composing" data-graph-loading class="graph-state" role="status">
        <span class="graph-loading-mark" aria-hidden="true" />
        <h2>Loading graph entries</h2>
      </div>
      <GraphEntries
        v-else-if="graph.section === 'all' && (graph.view !== 'changes' || graph.searchQuery.trim())"
        ref="entityList"
        :nodes="projectionNodes"
        :projects="graph.graphProjects"
        :current-project-id="graph.workspaceProjectId"
        :kinds="graph.graphKinds"
        :available-kinds="graph.graphAvailableKinds"
        :project-ids="graph.graphProjectIds"
        :search-active="Boolean(graph.searchQuery.trim())"
        :context-key="entryContext"
        @update:kinds="graph.graphKinds = $event"
        @update:project-ids="graph.graphProjectIds = $event"
        @changes="graph.clearSearch(); $emit('setView', 'changes')"
        :sort-by="graphSort.sortBy"
        :direction="graphSort.direction"
        :loading="graph.projectionLoading || graph.searching"
        :loading-more="graph.loadingMore"
        :can-load-more="graph.canLoadMore"
        :empty-title="emptyTitle"
        :empty-copy="emptyCopy"
        @open="$emit('openNode', $event)"
        @create="$emit('openCreate')"
        @sort="$emit('sortGraph', $event)"
        @load-more="graph.loadMoreGraphEntries()"
      />
      <div v-if="graph.section === 'all' && graph.view === 'changes' && !graph.searchQuery.trim()" class="graph-changes-nav">
        <button type="button" data-graph-control="graph-back-entries" @click="$emit('setView', 'list')">← Entries</button>
        <span>Changes</span>
      </div>
      <NowView
        v-if="!composing && graph.section === 'all' && graph.view === 'changes' && !graph.searchQuery.trim()"
        :events="graph.events"
        :waiting="waitingOnYouIssues"
        :nodes="graph.nodes"
        :seen-at="nowSeenAt"
        :total="graph.eventTotal"
        :offset="graph.eventOffset"
        :limit="graph.eventLimit"
        :loading="graph.eventsLoading"
        :can-summarise="canSummarise"
        @open="$emit('openNode', $event)"
        @page="$emit('loadNowPage', $event)"
        @seen="$emit('markNowSeen', $event)"
        @summarise="$emit('openSummary')"
      />
      <WorkBoard
        v-if="!composing && graph.section === 'work' && graph.view === 'board'"
        ref="workBoard"
        :search-query="graph.searchQuery.trim()"
        :empty-copy="emptyCopy"
        :issues="boardIssues"
        :unfiltered-issues="unsearchedWorkIssues"
        :show-empty-projects="showEmptyProjects"
        :statuses="boardStatuses"
        :nodes="graph.nodes"
        :projects="graph.projects"
        :group-by="boardGroup"
        :collapsed-statuses="collapsedBoardStatuses"
        :self-id="selfPersonId"
        :hide-project="projectScoped"
        @open="$emit('openNode', $event)"
        @move="$emit('moveIssue', $event)"
        @patch="$emit('patchIssue', $event)"
        @bulk-patch="$emit('bulkPatchIssues', $event)"
        @bulk-move="$emit('bulkMoveIssues', $event)"
        @reorder="$emit('reorderIssue', $event)"
        @create="$emit('createFromBoard', $event)"
        @expand-column="$emit('expandBoardStatus', $event)"
      />
      <EntityList
        v-else-if="!composing && graph.section === 'work' && graph.view === 'list'"
        ref="entityList"
        :nodes="graph.section === 'work' ? boardIssues : projectionNodes"
        :lookup="graph.nodes"
        :projects="graph.projects"
        :scopes="graph.scopes"
        :mode="graph.section === 'work' ? 'work' : 'generic'"
        :group-by="graph.section === 'work' ? listGroupBy : ''"
        :self-id="selfPersonId"
        :hide-project="projectScoped"
        :empty-title="emptyTitle"
        :empty-copy="emptyCopy"
        @open="$emit('openNode', $event)"
        @create="$emit('openCreate')"
      />
    </main>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import EntityList from './EntityList.vue'
import GraphViewbar from './GraphViewbar.vue'
import NowView from './NowView.vue'
import GraphEntries from './GraphEntries.vue'
import WorkBoard from './WorkBoard.vue'

defineProps({
  graphSort: { type: Object, default: () => ({ sortBy: 'updated', direction: 'desc' }) },
  currentSection: { type: Object, default: null },
  viewOptions: { type: Array, default: () => [] },
  projectFilter: { type: String, default: '' },
  projectFilterOptions: { type: Array, default: () => [] },
  assigneeFilter: { type: String, default: '' },
  assigneeFilterOptions: { type: Array, default: () => [] },
  selfPersonId: { type: String, default: '' },
  projectScoped: { type: Boolean, default: false },
  listGroupBy: { type: String, default: 'status' },
  boardGroup: { type: String, default: 'status' },
  boardGroupOptions: { type: Array, default: () => [] },
  boardSort: { type: String, default: 'rank' },
  boardSortOptions: { type: Array, default: () => [] },
  priorityFilter: { type: String, default: '' },
  priorityFilterOptions: { type: Array, default: () => [] },
  collapsedBoardStatuses: { type: Array, default: () => [] },
  boardStatuses: { type: Array, default: () => [] },
  composing: { type: Boolean, default: false },
  projectionNodes: { type: Array, default: () => [] },
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
  waitingOnYouIssues: { type: Array, default: () => [] },
  nowSeenAt: { type: String, default: '' },
  canSummarise: { type: Boolean, default: false },
  boardIssues: { type: Array, default: () => [] },
  unsearchedWorkIssues: { type: Array, default: () => [] },
  showClosedIssues: { type: Boolean, default: false },
  showEmptyProjects: { type: Boolean, default: false },
})

defineEmits([
  'sortGraph',
  'configureWorkspace',
  'bulkMoveIssues', 'bulkPatchIssues', 'createFromBoard',
  'expandAllBoardStatuses', 'expandBoardStatus',
  'loadNowPage', 'markNowSeen', 'moveIssue', 'openCreate',
  'openNode', 'openSummary', 'patchIssue', 'reorderIssue',
  'setView', 'toggleBoardStatusCollapse', 'update:assigneeFilter',
  'update:boardGroup', 'update:boardSort', 'update:priorityFilter', 'update:projectFilter',
  'update:showClosedIssues', 'update:showEmptyProjects',
])

const graph = useBusinessGraphStore()
const entryContext = computed(() => JSON.stringify([graph.activeScopeIds, graph.searchQuery, graph.graphKinds, graph.graphProjectIds, graph.searchQuery.trim() ? graph.graphSearchOrder : graph.graphOrder]))
const entityList = ref(null)
const workBoard = ref(null)
const viewbar = ref(null)

defineExpose({
  closeMenus: options => entityList.value?.closeMenus?.(options) || viewbar.value?.closeMenus(options) || false,
  focusListEdge(edge) {
    if (workBoard.value) return workBoard.value.focusEdge(edge)
    if (!entityList.value) return false
    entityList.value.focusEdge(edge)
    return true
  },
  focusNode: id => entityList.value?.focusNode(id),
})
</script>

<style scoped>
.graph-changes-nav { display: flex; min-height: 28px; flex-shrink: 0; align-items: center; gap: 16px; padding: 0 12px; border-bottom: 1px solid var(--color-rule); color: var(--color-ink-3); font-size: 11px; }
.graph-changes-nav button { min-height: 28px; color: var(--color-ink); }
.graph-changes-nav button:focus-visible { outline: 2px solid var(--color-accent); }
.graph-workspace {
  gap: 1px;
  background: var(--color-rule);
}

.graph-workspace > main {
  background: var(--graph-canvas);
}

.graph-state {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  place-content: center;
  justify-items: center;
  padding: 40px 24px;
  text-align: center;
}

.graph-state h2 {
  margin-top: 15px;
  color: var(--color-ink);
  font-size: 16px;
  font-weight: 660;
  letter-spacing: -0.018em;
}

.graph-state p {
  max-width: 400px;
  margin-top: 7px;
  color: var(--color-ink-3);
  font-size: 12px;
  line-height: 1.55;
}

.graph-loading-mark {
  width: 24px;
  height: 24px;
  border: 2px solid var(--color-rule);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: graph-spin 750ms linear infinite;
}

@keyframes graph-spin {
  to { transform: rotate(360deg); }
}
</style>
