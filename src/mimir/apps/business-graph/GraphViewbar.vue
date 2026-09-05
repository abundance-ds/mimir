<template>
  <div data-graph-viewbar class="graph-viewbar pane-subbar">
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

    <div v-if="activeFilters.length" class="graph-active-filters" aria-label="Active filters">
      <button
        v-for="filter in activeFilters"
        :key="filter.id"
        type="button"
        :data-graph-filter-chip="filter.id"
        :data-graph-control="`clear-${filter.id}-filter-chip`"
        class="graph-filter-chip"
        :aria-label="`Clear ${filter.label}`"
        :title="`Clear ${filter.label}`"
        @click="clearActiveFilter(filter.id)"
      >
        <span class="truncate">{{ filter.label }}</span>
        <IconX :size="11" />
      </button>
    </div>

    <div
      v-if="section === 'work' || (section === 'all' && ['list', 'timeline'].includes(view))"
      ref="filtersRoot"
      class="graph-filters-root"
    >
      <button
        ref="filtersTrigger"
        type="button"
        data-graph-filters-trigger
        data-graph-control="filters-trigger"
        class="graph-filters-trigger"
        :class="{ 'graph-filter-active': activeFilters.length }"
        aria-haspopup="dialog"
        :aria-expanded="filtersMenu"
        @click="toggleFiltersMenu"
        @keydown.down.prevent="openFiltersMenu"
      >
        <IconFilter :size="13" />
        <span>Filters</span>
        <span v-if="activeFilters.length" class="graph-filter-count">{{ activeFilters.length }}</span>
      </button>

      <div
        v-show="filtersMenu"
        ref="filtersMenuRoot"
        data-graph-filters-popover
        role="dialog"
        aria-label="Graph filters"
        class="graph-filters-popover"
        @keydown="onFiltersMenuKeydown"
      >
        <template v-if="section === 'work'">
          <div class="graph-filter-row">
            <span>Project</span>
            <div class="graph-filter-control">
              <GraphSelect
                :model-value="projectFilter"
                data-board-project-filter
                data-graph-control="board-project"
                class="min-w-0 flex-1"
                :class="{ 'graph-project-view-active': projectFilter }"
                variant="bar"
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
                class="graph-filter-reset"
                :disabled="!projectFilter"
                :title="projectFilter ? 'Show all projects' : undefined"
                :aria-label="projectFilter ? 'Show all projects' : 'All projects are shown'"
                @click="$emit('update:projectFilter', '')"
              >
                <IconX :size="12" />
              </button>
            </div>
          </div>

          <div class="graph-filter-row">
            <span>Owner</span>
            <div class="graph-filter-control">
              <GraphSelect
                :model-value="assigneeFilter"
                data-board-assignee-filter
                data-graph-control="board-assignee"
                class="min-w-0 flex-1"
                :class="{ 'graph-project-view-active': assigneeFilter }"
                variant="bar"
                :aria-label="ownerViewAccessibleLabel"
                :title="ownerViewAccessibleLabel"
                :options="assigneeOptions"
                :searchable="assigneeOptions.length > 8"
                search-placeholder="Find a person"
                :menu-min-width="196"
                @update:model-value="$emit('update:assigneeFilter', $event)"
              />
              <button
                type="button"
                data-graph-control="board-assignee-filter-clear"
                class="graph-filter-reset"
                :disabled="!assigneeFilter"
                :title="assigneeFilter ? 'Show work for anyone' : undefined"
                :aria-label="assigneeFilter ? 'Show work for anyone' : 'Work for anyone is shown'"
                @click="$emit('update:assigneeFilter', '')"
              >
                <IconX :size="12" />
              </button>
            </div>
          </div>

          <div class="graph-filter-row">
            <span>Group</span>
            <GraphSelect
              :model-value="groupBy"
              data-board-group
              data-graph-control="board-group"
              class="min-w-0"
              variant="bar"
              aria-label="Group work"
              :options="groupOptions"
              @update:model-value="$emit('update:groupBy', $event)"
            />
          </div>

          <div class="graph-filter-row">
            <span>Sort</span>
            <GraphSelect
              :model-value="sortBy"
              data-board-sort
              data-graph-control="board-sort"
              class="min-w-0"
              variant="bar"
              aria-label="Sort issues"
              :options="sortOptions"
              @update:model-value="$emit('update:sortBy', $event)"
            />
          </div>

          <div class="graph-filter-row">
            <span>Priority</span>
            <div class="graph-filter-control">
              <GraphSelect
                :model-value="priorityFilter"
                data-board-priority-filter
                data-graph-control="board-priority"
                class="min-w-0 flex-1"
                :class="{ 'graph-filter-active': priorityFilter }"
                variant="bar"
                aria-label="Filter issues by priority"
                :options="priorityOptions"
                @update:model-value="$emit('update:priorityFilter', $event)"
              />
              <button
                type="button"
                data-graph-control="board-priority-filter-clear"
                class="graph-filter-reset"
                :disabled="!priorityFilter"
                :title="priorityFilter ? `Clear priority filter: ${human(priorityFilter)}` : undefined"
                :aria-label="priorityFilter ? `Clear priority filter: ${human(priorityFilter)}` : 'No priority filter to clear'"
                @click="$emit('update:priorityFilter', '')"
              >
                <IconX :size="12" />
              </button>
            </div>
          </div>

          <div
            v-if="view === 'board' && groupBy === 'status'"
            ref="columnsRoot"
            class="graph-filter-row"
            data-board-columns-root
          >
            <span>Columns</span>
            <div class="graph-filter-control">
              <button
                ref="columnsTrigger"
                type="button"
                data-board-columns-trigger
                data-graph-control="board-columns"
                class="graph-columns-trigger"
                :class="{ 'graph-filter-active': collapsedLabels.length }"
                aria-haspopup="menu"
                :aria-expanded="columnsMenu"
                @click="toggleColumnsMenu"
                @keydown.down.prevent="openColumnsMenu('first')"
                @keydown.up.prevent="openColumnsMenu('last')"
              >
                <span>{{ collapsedLabels.length ? `${collapsedLabels.length} collapsed` : 'All shown' }}</span>
                <IconChevronDown :size="11" />
              </button>
              <button
                type="button"
                data-graph-control="board-columns-expand-all"
                class="graph-filter-reset"
                :disabled="!collapsedLabels.length"
                :title="collapsedLabels.length ? 'Expand all board columns' : undefined"
                :aria-label="collapsedLabels.length ? `Expand all board columns. Collapsed: ${collapsedLabels.join(', ')}` : 'All board columns are expanded'"
                @click="$emit('expandAll')"
              >
                <IconX :size="12" />
              </button>
            </div>
            <Teleport to="body">
              <div
                v-if="columnsMenu"
                ref="columnsMenuRoot"
                data-board-columns-menu
                data-modal-portal
                role="menu"
                aria-label="Collapsed board columns"
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
        </template>

        <div v-else class="graph-filter-row">
          <span>Kind</span>
          <div class="graph-filter-control">
            <GraphSelect
              :model-value="kindFilter"
              data-all-kind-filter
              data-graph-control="all-kind"
              class="min-w-0 flex-1"
              :class="{ 'graph-filter-active': kindFilter }"
              variant="bar"
              aria-label="Filter by kind"
              :options="kindOptions"
              @update:model-value="$emit('update:kindFilter', $event)"
            />
            <button
              type="button"
              data-graph-control="all-kind-filter-clear"
              class="graph-filter-reset"
              :disabled="!kindFilter"
              :title="kindFilter ? `Clear kind filter: ${human(kindFilter)}` : undefined"
              :aria-label="kindFilter ? `Clear kind filter: ${human(kindFilter)}` : 'No kind filter to clear'"
              @click="$emit('update:kindFilter', '')"
            >
              <IconX :size="12" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { IconCheck, IconChevronDown, IconFilter, IconX } from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  section: { type: String, required: true },
  sectionLabel: { type: String, default: '' },
  view: { type: String, required: true },
  viewOptions: { type: Array, default: () => [] },
  projectFilter: { type: String, default: '' },
  projectOptions: { type: Array, default: () => [] },
  assigneeFilter: { type: String, default: '' },
  assigneeOptions: { type: Array, default: () => [] },
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

const emit = defineEmits([
  'setView',
  'update:projectFilter',
  'update:assigneeFilter',
  'update:groupBy',
  'update:sortBy',
  'update:priorityFilter',
  'update:kindFilter',
  'toggleStatus',
  'expandAll',
])

const filtersRoot = ref(null)
const filtersTrigger = ref(null)
const filtersMenuRoot = ref(null)
const filtersMenu = ref(false)
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
const ownerViewAccessibleLabel = computed(() => {
  const selected = props.assigneeOptions.find(option => option.value === props.assigneeFilter)
  return `Owner view: ${selected?.label || 'Anyone'}`
})
const activeFilters = computed(() => {
  if (props.section === 'all') {
    return ['list', 'timeline'].includes(props.view) && props.kindFilter
      ? [{ id: 'kind', label: `Kind: ${optionLabel(props.kindOptions, props.kindFilter)}` }]
      : []
  }
  if (props.section !== 'work') return []
  return [
    props.projectFilter && {
      id: 'project',
      label: `Project: ${optionLabel(props.projectOptions, props.projectFilter)}`,
    },
    props.assigneeFilter && {
      id: 'owner',
      label: `Owner: ${optionLabel(props.assigneeOptions, props.assigneeFilter)}`,
    },
    props.priorityFilter && {
      id: 'priority',
      label: `Priority: ${optionLabel(props.priorityOptions, props.priorityFilter)}`,
    },
    collapsedLabels.value.length && {
      id: 'columns',
      label: `Columns: ${collapsedLabels.value.join(', ')}`,
    },
  ].filter(Boolean)
})

async function toggleFiltersMenu() {
  if (filtersMenu.value) return closeFiltersMenu()
  await openFiltersMenu({ focus: false })
}

async function openFiltersMenu({ focus = true } = {}) {
  filtersMenu.value = true
  await nextTick()
  if (focus) focusable(filtersMenuRoot.value)[0]?.focus()
}

function closeFiltersMenu({ restoreFocus = false } = {}) {
  const wasOpen = filtersMenu.value
  filtersMenu.value = false
  closeColumnsMenu()
  if (wasOpen && restoreFocus) void nextTick(() => filtersTrigger.value?.focus())
  return wasOpen
}

function onFiltersMenuKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeFiltersMenu({ restoreFocus: true })
}

async function toggleColumnsMenu() {
  if (columnsMenu.value) return closeColumnsMenu()
  columnsMenu.value = true
  window.addEventListener('resize', positionColumnsMenu)
  window.addEventListener('scroll', positionColumnsMenu, true)
  await nextTick()
  positionColumnsMenu()
}

async function openColumnsMenu(edge = 'first') {
  if (!columnsMenu.value) await toggleColumnsMenu()
  await nextTick()
  const items = menuItems(columnsMenuRoot.value)
  items[edge === 'last' ? items.length - 1 : 0]?.focus()
}

function closeColumnsMenu({ restoreFocus = false } = {}) {
  const wasOpen = columnsMenu.value
  columnsMenu.value = false
  window.removeEventListener('resize', positionColumnsMenu)
  window.removeEventListener('scroll', positionColumnsMenu, true)
  if (wasOpen && restoreFocus) void nextTick(() => columnsTrigger.value?.focus())
  return wasOpen
}

function closeMenus({ restoreFocus = false } = {}) {
  if (columnsMenu.value) return closeColumnsMenu({ restoreFocus })
  return closeFiltersMenu({ restoreFocus })
}

function onColumnsMenuKeydown(event) {
  const items = menuItems(columnsMenuRoot.value)
  const current = items.indexOf(document.activeElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeColumnsMenu({ restoreFocus: true })
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

function positionColumnsMenu() {
  const rect = columnsTrigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = 190
  columnsMenuStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${Math.max(6, Math.min(rect.right - width, window.innerWidth - width - 6))}px`,
  }
}

function onDocumentPointerDown(event) {
  const target = event.target
  if (target.closest?.('[data-graph-select-menu]')) return
  if (columnsMenuRoot.value?.contains(target)) return
  if (columnsMenu.value && !columnsRoot.value?.contains(target) && !columnsMenuRoot.value?.contains(target)) {
    closeColumnsMenu()
  }
  if (filtersMenu.value && !filtersRoot.value?.contains(target) && !filtersMenuRoot.value?.contains(target)) {
    closeFiltersMenu()
  }
}

function clearActiveFilter(id) {
  if (id === 'project') emit('update:projectFilter', '')
  else if (id === 'owner') emit('update:assigneeFilter', '')
  else if (id === 'priority') emit('update:priorityFilter', '')
  else if (id === 'columns') emit('expandAll')
  else if (id === 'kind') emit('update:kindFilter', '')
}

function optionLabel(options, value) {
  return options.find(option => option.value === value)?.label || human(value)
}

function menuItems(root) {
  return [...(root?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])]
}

function focusable(root) {
  return [...(root?.querySelectorAll('button:not(:disabled), [role="combobox"]') || [])]
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onUnmounted(() => {
  closeFiltersMenu()
  closeColumnsMenu()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

defineExpose({ closeMenus })
</script>

<style scoped>
.graph-viewbar { min-width: 0; gap: 8px; }
.graph-views { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
.graph-view { height: 22px; border-radius: 3px; padding: 0 8px; color: var(--color-ink-3); font-size: 10px; font-weight: 540; }
.graph-view:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-view:focus-visible, .graph-filters-trigger:focus-visible, .graph-filter-chip:focus-visible, .graph-filter-reset:focus-visible, .graph-columns-trigger:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: 1px; }
.graph-view-active { background: transparent; color: var(--color-ink); font-weight: 700; }

.graph-active-filters { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 4px; overflow: hidden; }
.graph-filter-chip { display: inline-flex; height: 22px; min-width: 0; max-width: 150px; align-items: center; gap: 4px; border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule)); border-radius: 3px; background: var(--color-accent-soft); padding: 0 5px 0 7px; color: var(--color-ink-2); font-size: 9.5px; }
.graph-filter-chip:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-filter-chip svg { flex: 0 0 auto; color: var(--color-accent); }
.graph-filters-root { position: relative; margin-left: auto; flex: 0 0 auto; }
.graph-filters-trigger { display: inline-flex; height: 24px; align-items: center; gap: 5px; border: 1px solid var(--color-rule-light); border-radius: 3px; background: var(--color-chrome-high); padding: 0 7px; color: var(--color-ink-3); font-size: 10px; }
.graph-filters-trigger:hover, .graph-filters-trigger[aria-expanded='true'] { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-filter-count { min-width: 14px; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; text-align: center; }
.graph-filter-active { border-color: color-mix(in srgb, var(--color-accent) 48%, var(--color-rule)); color: var(--color-ink); }

.graph-filters-popover { position: absolute; z-index: 250; top: 28px; right: 0; width: min(340px, calc(100cqw - 24px)); max-height: min(430px, calc(100vh - 80px)); overflow-y: auto; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); padding: 6px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.graph-filter-row { display: grid; min-height: 36px; grid-template-columns: 70px minmax(0, 1fr); align-items: center; gap: 8px; border-bottom: 1px solid var(--color-rule-light); padding: 4px 5px; }
.graph-filter-row:last-child { border-bottom: 0; }
.graph-filter-row > span { color: var(--color-ink-3); font-size: 10px; }
.graph-filter-control { display: flex; min-width: 0; align-items: center; gap: 4px; }
.graph-project-view-active { border-color: color-mix(in srgb, var(--color-accent) 72%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); font-weight: 680; }
.graph-filter-reset { display: grid; width: 24px; height: 24px; flex: 0 0 auto; place-items: center; border-radius: 3px; color: var(--color-ink-3); }
.graph-filter-reset:hover:not(:disabled) { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-filter-reset:disabled { opacity: 0.28; }
.graph-columns-trigger { display: flex; height: 28px; min-width: 0; flex: 1 1 auto; align-items: center; justify-content: space-between; gap: 6px; border: 1px solid var(--color-rule-light); border-radius: 3px; background: var(--color-surface); padding: 0 9px; color: var(--color-ink-2); font-size: 10px; }
.graph-columns-trigger:hover, .graph-columns-trigger[aria-expanded='true'] { background: var(--color-chrome-mid); color: var(--color-ink); }

.graph-columns-menu { position: fixed; z-index: 270; width: 190px; max-height: min(320px, calc(100vh - 80px)); overflow-y: auto; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); padding: 5px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.graph-columns-menu > p { padding: 7px 8px 6px; color: var(--color-ink-3); font-size: 11px; font-weight: 650; }
.graph-columns-menu > button { display: flex; width: 100%; min-height: 34px; align-items: center; gap: 9px; border-radius: 3px; padding: 0 8px; color: var(--color-ink-2); font-size: 11px; text-align: left; }
.graph-columns-menu > button:hover { background: var(--color-chrome-mid); }
.graph-columns-menu > button:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: -2px; }
.graph-checkbox { display: grid; width: 17px; height: 17px; place-items: center; border: 1px solid var(--color-rule); border-radius: 3px; color: transparent; }
.graph-checkbox-checked { border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); }

@container business-graph (max-width: 520px) {
  .graph-filter-chip { max-width: 108px; }
}
</style>
