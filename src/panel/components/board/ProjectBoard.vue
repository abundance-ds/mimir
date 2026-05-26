<template>
  <main class="flex flex-1 flex-col min-w-0 overflow-hidden" style="background: var(--color-chrome-high)">
    <!-- Full-page detail: hides header entirely -->
    <div v-if="boardStore.selectedEntry" class="flex-1 overflow-y-auto">
      <EntryDetail
        :entry="boardStore.selectedEntry"
        :back-label="boardStore.viewMode === 'board' ? 'Board' : 'Knowledge'"
        @close="onCloseEntry"
        @save="onSaveEntry"
        @delete="onDeleteEntry"
      />
    </div>

    <!-- Normal hub: pill nav + tabbed content -->
    <template v-else>
      <BoardHeader />
      <div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
        <NewChat v-show="boardStore.viewMode === 'chat'" :key="projectId" :project-id="projectId" embedded />
        <KanbanView v-show="boardStore.viewMode === 'board'" />
        <KnowledgeView v-show="boardStore.viewMode === 'knowledge'" />
        <HistoryView v-show="boardStore.viewMode === 'history'" />
        <ProjectSettings v-show="boardStore.viewMode === 'settings'" :key="projectId" :project-id="projectId" />
      </div>
    </template>
  </main>
</template>

<script setup>
import { onMounted, watch } from 'vue'
import { useBoardStore } from '../../../stores/panel/board.js'
import { usePanelUIStore } from '../../../stores/panel/ui.js'
import BoardHeader from './BoardHeader.vue'
import KanbanView from './KanbanView.vue'
import KnowledgeView from './KnowledgeView.vue'
import HistoryView from './HistoryView.vue'
import EntryDetail from './EntryDetail.vue'
import ProjectSettings from '../project/ProjectSettings.vue'
import NewChat from '../NewChat.vue'

const props = defineProps({
  projectId: { type: String, required: true },
})

const boardStore = useBoardStore()
const panelUI = usePanelUIStore()

onMounted(() => {
  boardStore.loadBoard(props.projectId)
})

watch(() => props.projectId, (id) => {
  boardStore.loadBoard(id)
  if (!panelUI.isNavigatingHistory()) {
    boardStore.clearSelection()
    boardStore.viewMode = 'chat'
  }
})

function onCloseEntry() {
  boardStore.clearSelection()
  panelUI.pushProjectNav(boardStore.viewMode, null)
}

async function onSaveEntry({ entryId, meta, body }) {
  await boardStore.updateEntry(entryId, meta, body)
}

async function onDeleteEntry(entryId) {
  await boardStore.removeEntry(entryId)
}
</script>
