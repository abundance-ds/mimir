<template>
  <div
    class="flex flex-col min-w-[160px] flex-1"
    :data-kanban-column="column.status"
  >
    <div class="group flex items-center gap-2 px-1 py-2 border-b border-rule-light">
      <span class="ed-status-dot" :class="'ed-status--' + column.status" />
      <span class="font-sans text-[10px] font-semibold text-ink-2 uppercase tracking-wide">
        {{ column.label }}
      </span>
      <span class="font-mono text-[10px] text-ink-3 bg-chrome rounded-full px-1.5 py-px min-w-[18px] text-center">{{ column.entries.length }}</span>
      <div ref="menuAnchorRef" class="relative ml-auto opacity-0 group-hover:opacity-100">
        <button
          class="inline-flex items-center justify-center w-[18px] h-[18px] rounded text-ink-3 hover:text-ink-2 hover:bg-chrome-mid"
          @click.stop="menuOpen = !menuOpen"
        >
          <IconDots :size="12" />
        </button>
        <div v-if="menuOpen" class="col-menu">
          <button class="col-menu-item" @click.stop="hideColumn">
            <IconEyeOff :size="12" />
            Hide column
          </button>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-1 pt-2 flex-1 min-h-[40px]">
      <template v-for="(entry, i) in column.entries" :key="entry.id">
        <div
          v-if="showDropLine(i)"
          class="h-[2px] rounded-full bg-accent mx-1 -my-px"
        />
        <KanbanCard
          :entry="entry"
          :dimmed="isDragSource(entry.id)"
          :data-kanban-card="entry.id"
          @pointerdown="$emit('start-drag', entry.id, $event)"
          @click="$emit('select', entry.id)"
          @update-priority="$emit('update-priority', $event)"
          @update-due-date="$emit('update-due-date', $event)"
        />
      </template>
      <div v-if="isEmpty && !dragState.active" class="flex items-center justify-center py-6">
        <span class="font-sans text-[10px] text-ink-3">No issues</span>
      </div>
      <div
        v-if="showDropLineEnd"
        class="h-[2px] rounded-full bg-accent mx-1"
      />
      <button
        class="w-full text-left font-sans text-[10.5px] text-ink-3 hover:text-ink-2 hover:bg-chrome-mid rounded px-2 py-1"
        @click="$emit('add-issue', column.status)"
      >+ Add issue</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { IconDots, IconEyeOff } from '@tabler/icons-vue'
import { useBoardStore } from '../../../stores/panel/board.js'
import KanbanCard from './KanbanCard.vue'

const props = defineProps({
  column: { type: Object, required: true },
  dragState: { type: Object, required: true },
})

defineEmits(['start-drag', 'select', 'add-issue', 'update-priority', 'update-due-date'])

const boardStore = useBoardStore()
const menuOpen = ref(false)
const menuAnchorRef = ref(null)

const isEmpty = computed(() => props.column.entries.length === 0)

function isDragSource(entryId) {
  return props.dragState.active && props.dragState.entryId === entryId
}

function showDropLine(index) {
  return props.dragState.active &&
    props.dragState.dropStatus === props.column.status &&
    props.dragState.dropIndex === index
}

const showDropLineEnd = computed(() =>
  props.dragState.active &&
  props.dragState.dropStatus === props.column.status &&
  props.dragState.dropIndex === props.column.entries.length
)

function hideColumn() {
  menuOpen.value = false
  boardStore.toggleColumnHidden(props.column.status)
}

function onPointerDown(e) {
  if (menuOpen.value && menuAnchorRef.value && !menuAnchorRef.value.contains(e.target)) {
    menuOpen.value = false
  }
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown))
</script>

<style scoped>
.ed-status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.ed-status--backlog { background: var(--color-ink-4); }
.ed-status--plan { background: var(--color-ink-3); }
.ed-status--in-progress { background: var(--color-accent); }
.ed-status--review { background: color-mix(in srgb, var(--color-accent) 60%, var(--color-ink-3)); }
.ed-status--done { background: var(--color-add); }

.col-menu {
  position: absolute; z-index: 50;
  top: 100%; right: 0;
  min-width: 140px; padding: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}
.col-menu-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; height: 26px; padding: 0 8px;
  border-radius: 4px;
  color: var(--color-ink-2);
  font-family: var(--font-sans); font-size: 11px;
  text-align: left;
}
.col-menu-item:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
</style>
