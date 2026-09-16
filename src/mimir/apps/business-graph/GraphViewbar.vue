<template>
  <div ref="viewbarRoot" data-graph-viewbar class="graph-viewbar pane-subbar" :class="{ 'graph-viewbar-inline': inlineControls, 'graph-entry-viewbar': graphEntryView }">
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

    <div v-if="activeFilters.length && !inlineControls && !compactFilters && section !== 'all'" class="graph-active-filters" aria-label="Active filters">
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
      v-if="section === 'work' || graphEntryView"
      ref="filtersRoot"
      class="graph-filters-root"
    >
      <button
        v-show="!inlineControls"
        ref="filtersTrigger"
        type="button"
        data-graph-filters-trigger
        data-graph-control="filters-trigger"
        class="graph-filters-trigger"
        :class="{ 'graph-filter-active': activeFilters.length }"
        :title="activeFilters.length ? activeFilters.map(filter => filter.label).join('; ') : (section === 'work' ? 'Filter tasks' : 'Filter graph items')"
        aria-haspopup="dialog"
        :aria-expanded="filtersMenu"
        @click="toggleFiltersMenu"
        @keydown.down.prevent="openFiltersMenu"
      >
        <IconFilter :size="13" />
        <span>Filter</span>
        <span v-if="activeFilters.length" class="graph-filter-count">{{ activeFilters.length }}</span>
      </button>

      <div
        v-show="filtersMenu || inlineControls"
        :key="inlineControls ? 'inline' : 'popover'"
        ref="filtersMenuRoot"
        data-graph-filters-popover
        :role="inlineControls ? 'group' : 'dialog'"
        :aria-label="section === 'work' ? 'Task filters' : 'Graph filters'"
        class="graph-filters-popover"
        :style="{ maxWidth: availableWidth ? `${availableWidth}px` : undefined }"
        @keydown="onFiltersMenuKeydown"
      >
        <template v-if="section === 'work'">
          <div class="graph-filter-row">
            <span v-if="!inlineControls">Project</span>
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
              >
                <template #trigger="{ option }">
                  {{ inlineControls && !projectFilter ? 'Project' : option?.label }}
                </template>
              </GraphSelect>
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
            <span v-if="!inlineControls">Owner</span>
            <div class="graph-filter-control">
              <GraphSelect
                :model-value="assigneeFilter"
                data-board-assignee-filter
                data-graph-control="board-assignee"
                class="min-w-0 flex-1"
                :class="{ 'graph-project-view-active': assigneeFilter, 'graph-owner-empty': inlineControls && !assigneeFilter }"
                :chevron="!inlineControls || Boolean(assigneeFilter)"
                variant="bar"
                :aria-label="ownerViewAccessibleLabel"
                :title="ownerViewAccessibleLabel"
                :options="assigneeOptions"
                :searchable="assigneeOptions.length > 8"
                search-placeholder="Find a person"
                :menu-min-width="196"
                @update:model-value="$emit('update:assigneeFilter', $event)"
              >
                <template #trigger="{ option }">
                  <IconUser v-if="inlineControls && !assigneeFilter" :size="14" aria-hidden="true" />
                  <template v-else>{{ option?.label }}</template>
                </template>
              </GraphSelect>
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
            <span v-if="!inlineControls">Priority</span>
            <div class="graph-filter-control">
              <GraphSelect
                :model-value="priorityFilter"
                data-board-priority-filter
                data-graph-control="board-priority"
                class="min-w-0 flex-1"
                :class="{ 'graph-filter-active': priorityFilter }"
                variant="bar"
                aria-label="Filter issues by priority"
                :title="priorityFilter ? `Priority: ${human(priorityFilter)}` : 'Filter by priority'"
                :menu-min-width="160"
                :options="priorityOptions"
                @update:model-value="$emit('update:priorityFilter', $event)"
              >
                <template #trigger="{ option }">
                  <span v-if="inlineControls && !priorityFilter" class="graph-filter-label"><IconFilter :size="12" aria-hidden="true" />Filter</span>
                  <template v-else>{{ option?.label }}</template>
                </template>
              </GraphSelect>
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
    <button
      v-if="graphEntryView"
      type="button"
      data-graph-control="current-project"
      class="graph-current-project"
      :class="{ 'graph-current-project-active': currentProjectOnly }"
      :aria-pressed="currentProjectOnly"
      :disabled="projectLoading"
      :aria-label="currentProjectLabel"
      :title="currentProjectLabel"
      @click="currentProjectTitle || currentProjectOnly ? $emit('update:currentProjectOnly', !currentProjectOnly) : $emit('configureWorkspace')"
    >
      <IconCheck v-if="currentProjectOnly" :size="12" aria-hidden="true" />
      <IconFolder v-else :size="12" aria-hidden="true" />
      <span v-if="currentProjectTitle" class="graph-current-project-prefix">Project:</span>
      <span class="graph-current-project-name">{{ currentProjectTitle || (projectLoading ? 'Loading project…' : projectUnavailable ? 'Project unavailable' : 'No linked project') }}</span>
    </button>
    <div v-if="section === 'work'" ref="displayRoot" class="graph-display-root">
      <button
        ref="displayTrigger"
        type="button"
        data-graph-display-trigger
        data-graph-control="display-trigger"
        class="graph-display-trigger"
        aria-haspopup="dialog"
        :aria-expanded="displayMenu"
        :title="displaySummary"
        @click="toggleDisplayMenu"
        @keydown.down.prevent="openDisplayMenu"
      >
        Display
        <IconChevronDown :size="11" />
      </button>
      <div
        v-show="displayMenu"
        :key="String(displayMenu)"
        ref="displayMenuRoot"
        data-graph-display-popover
        class="graph-display-popover"
        :style="{ maxWidth: availableWidth ? `${availableWidth}px` : undefined }"
        role="dialog"
        aria-label="Display settings"
        @keydown.esc="onDisplayEscape"
      >
        <div class="graph-filter-row">
          <span>Group by</span>
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
        <GraphCheckbox
          :model-value="showClosedIssues"
          data-graph-control="work-show-closed"
          class="graph-display-checkbox"
          @update:model-value="$emit('update:showClosedIssues', $event)"
        >Show closed issues</GraphCheckbox>
        <GraphCheckbox
          v-if="view === 'board' && groupBy === 'project'"
          :model-value="showEmptyProjects"
          data-graph-control="work-show-empty-projects"
          class="graph-display-checkbox"
          @update:model-value="$emit('update:showEmptyProjects', $event)"
        >Show empty projects</GraphCheckbox>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconCheck, IconChevronDown, IconFilter, IconFolder, IconUser, IconX } from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'
import GraphCheckbox from './GraphCheckbox.vue'

const props = defineProps({
  currentProjectOnly: { type: Boolean, default: false },
  currentProjectTitle: { type: String, default: '' },
  projectUnavailable: { type: Boolean, default: false },
  projectLoading: { type: Boolean, default: false },
  searchActive: { type: Boolean, default: false },
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
  showClosedIssues: { type: Boolean, default: false },
  showEmptyProjects: { type: Boolean, default: false },
  sortOptions: { type: Array, default: () => [] },
  priorityFilter: { type: String, default: '' },
  priorityOptions: { type: Array, default: () => [] },
  collapsedStatuses: { type: Array, default: () => [] },
  statuses: { type: Array, default: () => [] },
  kindFilter: { type: String, default: '' },
  kindOptions: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'update:currentProjectOnly',
  'configureWorkspace',
  'setView',
  'update:projectFilter',
  'update:assigneeFilter',
  'update:groupBy',
  'update:sortBy',
  'update:showClosedIssues',
  'update:showEmptyProjects',
  'update:priorityFilter',
  'update:kindFilter',
  'toggleStatus',
  'expandAll',
])

const filtersRoot = ref(null)
const graphEntryView = computed(() => props.section === 'all' && (props.searchActive || ['list', 'timeline'].includes(props.view)))
const currentProjectLabel = computed(() => props.currentProjectTitle
  ? `${props.currentProjectOnly ? 'Clear project filter' : 'Filter by current project'}: ${props.currentProjectTitle}. Includes direct links in both directions.`
  : `${props.projectUnavailable ? 'Project unavailable' : 'No linked project'}. ${props.currentProjectOnly ? 'Clear project filter.' : 'Open workspace setup.'}`)
const viewbarRoot = ref(null)
const availableWidth = ref(0)
// Budget for bounded selectors, view tabs, clear buttons, and pane insets.
// Observe this pane, not the window: Peek can consume half the graph width.
const inlineControls = computed(() => availableWidth.value >= 520)
const compactFilters = computed(() => availableWidth.value > 0 && availableWidth.value < 420)
let resizeObserver
const filtersTrigger = ref(null)
const filtersMenuRoot = ref(null)
const filtersMenu = ref(false)
const displayRoot = ref(null)
const displayTrigger = ref(null)
const displayMenuRoot = ref(null)
const displayMenu = ref(false)
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
const displaySummary = computed(() => [
  optionLabel(props.groupOptions, props.groupBy),
  optionLabel(props.sortOptions, props.sortBy),
  props.showClosedIssues ? 'Closed issues shown' : 'Closed issues hidden',
  props.view === 'board' && props.groupBy === 'project'
    ? (props.showEmptyProjects ? 'Empty projects shown' : 'Empty projects hidden') : '',
  props.view === 'board' && props.groupBy === 'status' && collapsedLabels.value.length
    ? `${collapsedLabels.value.length} columns collapsed` : '',
].filter(Boolean).join('. '))
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
  ].filter(Boolean)
})

async function toggleFiltersMenu() {
  if (filtersMenu.value) return closeFiltersMenu()
  await openFiltersMenu({ focus: false })
}

async function openFiltersMenu({ focus = true } = {}) {
  closeDisplayMenu()
  filtersMenu.value = true
  await nextTick()
  if (focus) focusable(filtersMenuRoot.value)[0]?.focus()
}

function closeFiltersMenu({ restoreFocus = false } = {}) {
  const wasOpen = filtersMenu.value
  filtersMenu.value = false
  if (wasOpen && restoreFocus) void nextTick(() => filtersTrigger.value?.focus())
  return wasOpen
}

function onFiltersMenuKeydown(event) {
  if (event.key !== 'Escape' || inlineControls.value) return
  event.preventDefault()
  event.stopPropagation()
  closeFiltersMenu({ restoreFocus: true })
}

async function toggleDisplayMenu() {
  if (displayMenu.value) return closeDisplayMenu()
  await openDisplayMenu({ focus: false })
}

async function openDisplayMenu({ focus = true } = {}) {
  closeFiltersMenu()
  displayMenu.value = true
  await nextTick()
  if (focus) focusable(displayMenuRoot.value)[0]?.focus()
}

function closeDisplayMenu({ restoreFocus = false } = {}) {
  const wasOpen = displayMenu.value
  displayMenu.value = false
  closeColumnsMenu()
  if (wasOpen && restoreFocus) void nextTick(() => displayTrigger.value?.focus())
  return wasOpen
}

function onDisplayEscape(event) {
  event.preventDefault()
  event.stopPropagation()
  closeDisplayMenu({ restoreFocus: true })
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
  if (displayMenu.value) return closeDisplayMenu({ restoreFocus })
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
  if (displayMenu.value && !displayRoot.value?.contains(target)) closeDisplayMenu()
}

function clearActiveFilter(id) {
  if (id === 'project') emit('update:projectFilter', '')
  else if (id === 'owner') emit('update:assigneeFilter', '')
  else if (id === 'priority') emit('update:priorityFilter', '')
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

watch(inlineControls, async () => {
  const focusedControl = filtersMenuRoot.value?.contains(document.activeElement)
    ? document.activeElement?.getAttribute('data-graph-control')
    : filtersMenuRoot.value?.querySelector('[aria-expanded="true"]')?.getAttribute('data-graph-control')
  const triggerFocused = document.activeElement === filtersTrigger.value
  closeFiltersMenu()
  await nextTick()
  if (focusedControl && inlineControls.value) {
    filtersMenuRoot.value?.querySelector(`[data-graph-control="${focusedControl}"]`)?.focus()
  } else if (focusedControl) filtersTrigger.value?.focus()
  else if (triggerFocused && inlineControls.value) focusable(filtersMenuRoot.value)[0]?.focus()
})
watch(() => [props.section, props.view], () => {
  closeFiltersMenu()
  closeDisplayMenu()
})
watch(() => props.groupBy, () => closeColumnsMenu())

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(entries => {
    availableWidth.value = entries[0]?.contentRect.width || 0
  })
  resizeObserver.observe(viewbarRoot.value)
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  closeFiltersMenu()
  closeDisplayMenu()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

defineExpose({ closeMenus })
</script>

<style scoped>
.graph-viewbar { position: relative; min-width: 0; gap: 8px; }
.graph-current-project { display: inline-flex; height: 22px; min-width: 50px; flex: 0 1 auto; align-items: center; gap: 4px; padding: 0 5px; color: var(--color-ink-3); font-size: 10px; }
.graph-current-project svg, .graph-current-project-prefix { flex: 0 0 auto; }
.graph-current-project-name { min-width: 0; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-current-project:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-current-project:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: 1px; }
.graph-current-project-active { background: var(--color-accent-soft); color: var(--color-ink); }
.graph-current-project:disabled { opacity: 0.5; }
.graph-views { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
.graph-view { height: 22px; border-radius: 3px; padding: 0 8px; color: var(--color-ink-3); font-size: 10px; font-weight: 540; }
.graph-view:hover { background: var(--graph-hover); color: var(--color-ink); }
.graph-display-trigger:focus-visible, .graph-view:focus-visible, .graph-filters-trigger:focus-visible, .graph-filter-chip:focus-visible, .graph-filter-reset:focus-visible, .graph-columns-trigger:focus-visible { outline: 2px solid var(--graph-focus); outline-offset: 1px; }
.graph-view-active { background: transparent; color: var(--color-ink); font-weight: 700; }

.graph-active-filters { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 4px; overflow: hidden; }
.graph-filter-chip { display: inline-flex; height: 22px; min-width: 0; max-width: 150px; align-items: center; gap: 4px; border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule)); border-radius: 3px; background: var(--color-accent-soft); padding: 0 5px 0 7px; color: var(--color-ink-2); font-size: 9.5px; }
.graph-filter-chip:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-filter-chip svg { flex: 0 0 auto; color: var(--color-accent); }
.graph-filters-root { margin-left: 4px; flex: 0 0 auto; }
.graph-filters-trigger, .graph-display-trigger { display: inline-flex; height: 24px; align-items: center; gap: 5px; border: 1px solid var(--color-rule-light); border-radius: 3px; background: var(--color-chrome-high); padding: 0 7px; color: var(--color-ink-3); font-size: 10px; }
.graph-display-trigger:hover, .graph-display-trigger[aria-expanded='true'], .graph-filters-trigger:hover, .graph-filters-trigger[aria-expanded='true'] { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-display-root { position: relative; margin-left: auto; flex: 0 0 auto; }
.graph-display-trigger { border-color: transparent; background: transparent; }
.graph-filter-label { display: inline-flex; align-items: center; gap: 4px; }
.graph-filter-count { min-width: 14px; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; text-align: center; }
.graph-filter-active { border-color: color-mix(in srgb, var(--color-accent) 48%, var(--color-rule)); color: var(--color-ink); }

.graph-filters-popover, .graph-display-popover { position: absolute; z-index: 250; top: 28px; right: 0; width: min(340px, calc(100cqw - 24px)); max-height: min(430px, calc(100vh - 80px)); overflow-y: auto; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); padding: 6px; box-shadow: 0 8px 24px color-mix(in srgb, var(--color-ink) 12%, transparent); }
.graph-filters-popover { right: 12px; }
.graph-filter-row { display: grid; min-height: 36px; grid-template-columns: 70px minmax(0, 1fr); align-items: center; gap: 8px; border-bottom: 1px solid var(--color-rule-light); padding: 4px 5px; }
.graph-filter-row:last-child { border-bottom: 0; }
.graph-display-popover .graph-display-checkbox { display: flex; width: 100%; margin-top: 4px; }
.graph-filter-row > span { color: var(--color-ink-3); font-size: 10px; }
.graph-filter-control { display: flex; min-width: 0; align-items: center; gap: 4px; }
:deep(.graph-project-view-active) { border-color: color-mix(in srgb, var(--color-accent) 72%, var(--color-rule)); background: var(--color-accent-soft); color: var(--color-accent); font-weight: 680; }
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

/* One set of controls changes layout; values and event ownership stay shared. */
.graph-viewbar-inline .graph-filters-root { min-width: 0; flex: 0 1 auto; }
.graph-viewbar-inline .graph-filters-popover { position: static; display: flex; width: auto; max-height: none; align-items: center; gap: 8px; overflow: visible; border: 0; border-radius: 0; background: transparent; padding: 0; box-shadow: none; }
.graph-viewbar-inline .graph-filters-popover .graph-filter-row { display: flex; min-width: 0; min-height: 0; gap: 3px; border: 0; padding: 0; }
.graph-viewbar-inline .graph-filters-popover .graph-filter-row > span { display: flex; flex: 0 0 auto; }
.graph-viewbar-inline .graph-filters-popover .graph-filter-control { gap: 0; }
.graph-viewbar-inline .graph-filters-popover :deep(.graph-select-trigger) { width: 74px; height: 22px; border-color: transparent; background: transparent; padding: 0 4px; font-size: 10px; }
.graph-viewbar-inline .graph-filters-popover :deep([data-board-project-filter]) { width: 100px; }
.graph-viewbar-inline .graph-filters-popover :deep([data-board-assignee-filter]) { width: 80px; }
.graph-viewbar-inline .graph-filters-popover :deep(.graph-owner-empty) { width: 26px; padding: 0 6px; }
.graph-viewbar-inline .graph-filters-popover :deep(.graph-project-view-active),
.graph-viewbar-inline .graph-filters-popover :deep(.graph-filter-active) { background: var(--color-accent-soft); }
.graph-viewbar-inline .graph-filters-popover :deep(.graph-select-trigger:hover),
.graph-viewbar-inline .graph-filters-popover :deep(.graph-select-trigger[aria-expanded='true']) { background: var(--color-chrome-mid); color: var(--color-ink); }
.graph-viewbar-inline .graph-filters-popover .graph-filter-reset { width: 18px; height: 22px; }
.graph-viewbar-inline .graph-filters-popover .graph-filter-reset:disabled { display: none; }

@container business-graph (max-width: 520px) {
  .graph-filter-chip { max-width: 108px; }
}
@container business-graph (max-width: 419px) {
  .graph-entry-viewbar { gap: 5px; }
  .graph-entry-viewbar .graph-view { padding-inline: 4px; }
  .graph-entry-viewbar .graph-filters-trigger > span:first-of-type,
  .graph-current-project-prefix { display: none; }
}
</style>
