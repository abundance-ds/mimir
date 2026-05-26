<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="px-4 pt-3 pb-1">
      <div class="board-search max-w-[320px] ml-auto">
        <IconSearch :size="12" class="text-ink-3 shrink-0" />
        <input
          v-model="boardStore.issueSearch"
          type="search"
          placeholder="Search issues..."
          class="flex-1 min-w-0 bg-transparent font-sans text-[11px] text-ink outline-none placeholder:text-ink-3"
          autocorrect="off"
          autocapitalize="off"
        />
      </div>
    </div>

    <div class="flex gap-4 flex-1 min-h-0 px-4 py-2 overflow-x-auto">
      <template v-for="col in boardStore.columns" :key="col.status">
        <button
          v-if="boardStore.hiddenStatuses.has(col.status)"
          class="kv-collapsed"
          :class="dragState.active && dragState.dropStatus === col.status && 'kv-collapsed-drop'"
          :data-kanban-column="col.status"
          :title="col.label + ' (' + col.entries.length + ')'"
          @click="boardStore.toggleColumnHidden(col.status)"
        >
          <span class="kv-collapsed-dot" :class="'kv-dot--' + col.status" />
          <span class="kv-collapsed-count">{{ col.entries.length }}</span>
          <span class="kv-collapsed-label">{{ col.label }}</span>
        </button>
        <KanbanColumn
          v-else
          :column="col"
          :drag-state="dragState"
          @start-drag="(entryId, e) => startDrag(entryId, col.status, e)"
          @select="boardStore.selectEntry($event)"
          @add-issue="addIssueInStatus"
          @update-priority="updateCardField"
          @update-due-date="updateCardField"
        />
      </template>
    </div>

    <div
      v-if="dragState.active && draggedEntry"
      class="fixed pointer-events-none z-50 opacity-80"
      :style="{ left: (dragState.ghostX - 80) + 'px', top: (dragState.ghostY - 20) + 'px' }"
    >
      <KanbanCard :entry="draggedEntry" :ghost="true" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { IconSearch } from '@tabler/icons-vue'
import { useBoardStore } from '../../../stores/panel/board.js'
import { useKanbanDrag } from '../../composables/useKanbanDrag.js'
import KanbanColumn from './KanbanColumn.vue'
import KanbanCard from './KanbanCard.vue'

const boardStore = useBoardStore()

const { dragState, startDrag } = useKanbanDrag({
  onDrop(entryId, newStatus) {
    boardStore.moveIssue(entryId, newStatus)
  },
})

const draggedEntry = computed(() =>
  dragState.entryId ? boardStore.entries.find(e => e.id === dragState.entryId) : null
)

async function addIssueInStatus(status) {
  const id = await boardStore.createEntry('issue', { title: '', status })
  if (id) boardStore.selectEntry(id)
}

async function updateCardField({ entryId, priority, dueDate }) {
  const entry = boardStore.entries.find(e => e.id === entryId)
  if (!entry) return
  const meta = { ...entry.meta }
  if (priority !== undefined) meta.priority = priority
  if (dueDate !== undefined) meta.dueDate = dueDate || undefined
  await boardStore.updateEntry(entryId, meta, entry.body)
}
</script>

<style scoped>
.board-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
}
.board-search:focus-within {
  border-color: var(--color-accent);
}

.kv-collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  min-width: 28px;
  border-radius: 4px;
  flex-shrink: 0;
}
.kv-collapsed:hover { background: var(--color-chrome-mid); }
.kv-collapsed-drop { background: var(--color-accent-soft); }

.kv-collapsed-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.kv-dot--backlog { background: var(--color-ink-4); }
.kv-dot--plan { background: var(--color-ink-3); }
.kv-dot--in-progress { background: var(--color-accent); }
.kv-dot--review { background: color-mix(in srgb, var(--color-accent) 60%, var(--color-ink-3)); }
.kv-dot--done { background: var(--color-add); }

.kv-collapsed-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-ink-3);
  background: var(--color-chrome);
  border-radius: 100px;
  padding: 1px 5px;
  min-width: 18px;
  text-align: center;
}
.kv-collapsed-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  color: var(--color-ink-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
</style>
