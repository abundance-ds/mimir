<template>
  <div v-if="section !== 'now'" class="graph-viewbar">
    <nav class="graph-views" :aria-label="`${sectionLabel} views`">
      <button
        v-for="option in viewOptions"
        :key="option.id"
        type="button"
        :data-graph-view="option.id"
        :data-graph-control="`view-${option.id}`"
        class="graph-view"
        :class="{ 'graph-view-active': view === option.id }"
        :aria-pressed="view === option.id"
        @click="$emit('setView', option.id)"
      >
        {{ option.label }}
      </button>
    </nav>

    <div v-if="section === 'work'" class="graph-project-view">
      <GraphSelect
        :model-value="projectFilter"
        data-board-project-filter
        data-graph-control="board-project"
        class="graph-project-view-select w-[156px]"
        :class="{ 'graph-project-view-active': projectFilter }"
        variant="toolbar"
        :aria-label="projectViewAccessibleLabel"
        :title="projectViewAccessibleLabel"
        :options="projectOptions"
        :searchable="projectOptions.length > 8"
        search-placeholder="Find a project"
        :menu-min-width="196"
        @update:model-value="$emit('update:projectFilter', $event)"
      />
      <button
        type="button"
        data-graph-control="board-project-filter-clear"
        class="graph-filter-reset graph-project-view-reset"
        :class="{ 'graph-filter-reset-active': projectFilter }"
        :disabled="!projectFilter"
        :title="projectFilter ? 'Show all projects' : undefined"
        :aria-label="projectFilter ? 'Show all projects' : 'All projects are shown'"
        @click="$emit('update:projectFilter', '')"
      >
        <IconX :size="12" />
      </button>
    </div>

    <div v-if="section === 'work'" class="graph-work-controls">
      <GraphSelect
        v-if="view === 'board'"
        :model-value="groupBy"
        data-board-group
        data-graph-control="board-group"
        class="w-[104px]"
        variant="toolbar"
        aria-label="Group board"
        :options="groupOptions"
        @update:model-value="$emit('update:groupBy', $event)"
      />
      <GraphSelect
        :model-value="sortBy"
        data-board-sort
        data-graph-control="board-sort"
        class="w-[100px]"
        variant="toolbar"
        aria-label="Sort issues"
        :options="sortOptions"
        @update:model-value="$emit('update:sortBy', $event)"
      />
      <GraphSelect
        :model-value="priorityFilter"
        data-board-priority-filter
        data-graph-control="board-priority"
        class="w-[118px]"
        :class="{ 'graph-filter-active': priorityFilter }"
        variant="toolbar"
        aria-label="Filter issues by priority"
        :options="priorityOptions"
        @update:model-value="$emit('update:priorityFilter', $event)"
      />
      <button
        type="button"
        data-graph-control="board-priority-filter-clear"
        class="graph-filter-reset"
        :class="{ 'graph-filter-reset-active': priorityFilter }"
        :disabled="!priorityFilter"
        :title="priorityFilter ? `Clear priority filter: ${human(priorityFilter)}` : undefined"
        :aria-label="priorityFilter ? `Clear priority filter: ${human(priorityFilter)}` : 'No priority filter to clear'"
        @click="$emit('update:priorityFilter', '')"
      >
        <IconX :size="12" />
      </button>
      <div
        v-if="view === 'board' && groupBy === 'status'"
        ref="columnsRoot"
        class="relative flex items-center gap-[5px]"
        data-board-columns-root
      >
        <button
          ref="columnsTrigger"
          type="button"
          data-board-columns-trigger
          data-graph-control="board-columns"
          class="graph-icon-button graph-toolbar-icon"
          :class="{ 'graph-filter-active': collapsedLabels.length }"
          title="Collapse columns"
          aria-label="Choose collapsed board columns"
          :aria-expanded="columnsMenu"
          @click="toggleColumnsMenu"
          @keydown.down.prevent="openColumnsMenu('first')"
          @keydown.up.prevent="openColumnsMenu('last')"
        >
          <IconColumns3 :size="14" />
        </button>
        <button
          type="button"
          data-graph-control="board-columns-expand-all"
          class="graph-filter-reset"
          :class="{ 'graph-filter-reset-active': collapsedLabels.length }"
          :disabled="!collapsedLabels.length"
          :title="collapsedLabels.length ? 'Expand all board columns' : undefined"
          :aria-label="collapsedLabels.length ? `Expand all board columns. Collapsed: ${collapsedLabels.join(', ')}` : 'All board columns are expanded'"
          @click="$emit('expandAll')"
        >
          <IconX :size="12" />
        </button>
        <Teleport to="body">
          <div
            v-if="columnsMenu"
            ref="columnsMenuRoot"
            data-board-columns-menu
            role="menu"
            class="graph-columns-menu"
            :style="columnsMenuStyle"
            @keydown="onColumnsMenuKeydown"
          >
            <p>Collapse columns</p>
            <button
              v-for="status in statuses"
              :key="status.id"
              type="button"
              role="menuitemcheckbox"
              :aria-checked="collapsedStatuses.includes(status.id)"
              :data-graph-control="`board-column-${status.id}`"
              @click="$emit('toggleStatus', status.id)"
            >
              <span
                class="graph-checkbox"
                :class="{ 'graph-checkbox-checked': collapsedStatuses.includes(status.id) }"
              >
                <IconCheck v-if="collapsedStatuses.includes(status.id)" :size="11" />
              </span>
              {{ status.label }}
            </button>
          </div>
        </Teleport>
      </div>
    </div>

    <div v-if="section === 'all'" class="graph-work-controls">
      <GraphSelect
        :model-value="kindFilter"
        data-all-kind-filter
        data-graph-control="all-kind"
        class="w-[138px]"
        :class="{ 'graph-filter-active': kindFilter }"
        variant="toolbar"
        aria-label="Filter by kind"
        :options="kindOptions"
        @update:model-value="$emit('update:kindFilter', $event)"
      />
      <button
        type="button"
        data-graph-control="all-kind-filter-clear"
        class="graph-filter-reset"
        :class="{ 'graph-filter-reset-active': kindFilter }"
        :disabled="!kindFilter"
        :title="kindFilter ? `Clear kind filter: ${human(kindFilter)}` : undefined"
        :aria-label="kindFilter ? `Clear kind filter: ${human(kindFilter)}` : 'No kind filter to clear'"
        @click="$emit('update:kindFilter', '')"
      >
        <IconX :size="12" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { IconCheck, IconColumns3, IconX } from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  section: { type: String, required: true },
  sectionLabel: { type: String, default: '' },
  view: { type: String, required: true },
  viewOptions: { type: Array, default: () => [] },
  projectFilter: { type: String, default: '' },
  projectOptions: { type: Array, default: () => [] },
  groupBy: { type: String, default: 'status' },
  groupOptions: { type: Array, default: () => [] },
  sortBy: { type: String, default: 'rank' },
  sortOptions: { type: Array, default: () => [] },
  priorityFilter: { type: String, default: '' },
  priorityOptions: { type: Array, default: () => [] },
  collapsedStatuses: { type: Array, default: () => [] },
  statuses: { type: Array, default: () => [] },
  kindFilter: { type: String, default: '' },
  kindOptions: { type: Array, default: () => [] },
})

defineEmits([
  'setView',
  'update:projectFilter',
  'update:groupBy',
  'update:sortBy',
  'update:priorityFilter',
  'update:kindFilter',
  'toggleStatus',
  'expandAll',
])

const columnsRoot = ref(null)
const columnsTrigger = ref(null)
const columnsMenuRoot = ref(null)
const columnsMenu = ref(false)
const columnsMenuStyle = ref({})
const collapsedLabels = computed(() => {
  const collapsed = new Set(props.collapsedStatuses)
  return props.statuses.filter(status => collapsed.has(status.id)).map(status => status.label)
})
const projectViewAccessibleLabel = computed(() => {
  const selected = props.projectOptions.find(option => option.value === props.projectFilter)
  return `Project view: ${selected?.label || 'All projects'}`
})

async function toggleColumnsMenu() {
  if (columnsMenu.value) return closeMenus()
  columnsMenu.value = true
  window.addEventListener('resize', positionColumnsMenu)
  window.addEventListener('scroll', positionColumnsMenu, true)
  await nextTick()
  positionColumnsMenu()
}

async function openColumnsMenu(edge = 'first') {
  if (!columnsMenu.value) await toggleColumnsMenu()
  await nextTick()
  focusMenuEdge(edge)
}

function closeMenus({ restoreFocus = false } = {}) {
  if (!columnsMenu.value) return false
  columnsMenu.value = false
  window.removeEventListener('resize', positionColumnsMenu)
  window.removeEventListener('scroll', positionColumnsMenu, true)
  if (restoreFocus) void nextTick(() => columnsTrigger.value?.focus())
  return true
}

function onColumnsMenuKeydown(event) {
  const items = menuItems()
  const current = items.indexOf(document.activeElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenus({ restoreFocus: true })
  } else if (items.length && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
  } else if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const index = current < 0
      ? (delta > 0 ? 0 : items.length - 1)
      : (current + delta + items.length) % items.length
    items[index]?.focus()
  }
}

function focusMenuEdge(edge) {
  const items = menuItems()
  items[edge === 'last' ? items.length - 1 : 0]?.focus()
}

function menuItems() {
  return [...(columnsMenuRoot.value?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])]
}

function positionColumnsMenu() {
  const rect = columnsTrigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = 180
  columnsMenuStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${Math.max(6, Math.min(rect.right - width, window.innerWidth - width - 6))}px`,
  }
}

function onDocumentPointerDown(event) {
  if (
    columnsMenu.value
    && !columnsRoot.value?.contains(event.target)
    && !columnsMenuRoot.value?.contains(event.target)
  ) closeMenus()
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onUnmounted(() => {
  closeMenus()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

defineExpose({ closeMenus })
</script>

<style scoped>
.graph-viewbar { display: flex; min-height: 34px; flex: 0 0 auto; align-items: center; gap: 10px; overflow-x: auto; border-bottom: 1px solid var(--color-rule-light); background: color-mix(in srgb, var(--graph-canvas) 82%, var(--graph-raised)); padding: 3px 10px; scrollbar-width: none; }
.graph-viewbar::-webkit-scrollbar { display: none; }
.graph-views, .graph-project-view, .graph-work-controls { display: flex; min-width: max-content; align-items: center; }
.graph-views { flex: 0 0 auto; gap: 2px; }
.graph-project-view { gap: 3px; }
.graph-work-controls { gap: 5px; margin-left: auto; }
.graph-view { height: 25px; border-radius: 3px; padding: 0 8px; color: var(--color-ink-3); font-size: 10px; font-weight: 540; }
.graph-view:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-view:focus-visible, .graph-filter-reset-active:focus-visible, .graph-icon-button:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: 1px; }
.graph-view-active { background: transparent; color: var(--color-ink); font-weight: 700; }
.graph-project-view .graph-project-view-active { border-color: color-mix(in srgb, var(--color-accent) 72%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); font-weight: 680; }
.graph-project-view .graph-project-view-active:hover, .graph-project-view .graph-project-view-active[aria-expanded='true'] { background: color-mix(in srgb, var(--color-accent) 16%, var(--graph-raised)); color: var(--color-accent); }
.graph-project-view-reset.graph-filter-reset-active { color: var(--color-accent); }
.graph-filter-active { border-color: color-mix(in srgb, var(--color-accent) 48%, var(--color-rule)); color: var(--color-ink); }
.graph-filter-reset { display: grid; width: 25px; height: 25px; flex: 0 0 auto; place-items: center; visibility: hidden; border-radius: 3px; color: var(--color-ink-3); pointer-events: none; }
.graph-filter-reset-active { visibility: visible; pointer-events: auto; }
.graph-filter-reset-active:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-icon-button { display: grid; width: 30px; height: 30px; flex: 0 0 auto; place-items: center; border-radius: 5px; color: var(--color-ink-3); }
.graph-icon-button:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-toolbar-icon { border: 1px solid var(--color-rule-light); background: var(--graph-raised); }
.graph-columns-menu { position: fixed; z-index: 90; width: 180px; max-height: min(320px, calc(100vh - 80px)); overflow-y: auto; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); padding: 5px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.graph-columns-menu > p { padding: 7px 8px 6px; color: var(--color-ink-3); font-size: 11px; font-weight: 650; }
.graph-columns-menu > button { display: flex; width: 100%; min-height: 36px; align-items: center; gap: 9px; border-radius: 4px; padding: 0 8px; color: var(--color-ink-2); font-size: 11px; text-align: left; }
.graph-columns-menu > button:hover { background: var(--color-chrome-mid); }
.graph-columns-menu > button:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: -2px; }
.graph-checkbox { display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid var(--color-rule); border-radius: 4px; color: transparent; }
.graph-checkbox-checked { border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); }
@container business-graph (max-width: 680px) {
  .graph-viewbar { align-items: flex-start; gap: 8px; }
  .graph-work-controls { margin-left: 0; }
}
</style>
