<template>
  <div class="graph-entries" :aria-busy="loading" data-graph-entries>
    <div class="graph-entries-tools">
      <div class="graph-entry-filters" aria-label="Active entry filters">
        <button v-for="filter in activeFilters" :key="filter.id" type="button"
          :data-graph-control="`graph-clear-${filter.id}`" class="graph-entry-filter-chip"
          :title="`Clear ${filter.label}`" :aria-label="`Clear ${filter.label}`" @click="$emit(`update:${filter.id}`, [])">
          <span>{{ filter.label }}</span><IconX :size="12" aria-hidden="true" />
        </button>
        <button v-if="activeFilters.length" type="button" data-graph-control="graph-clear-filters" @click="clearFilters">Clear filters</button>
        <button v-if="searchActive" type="button" data-graph-control="graph-best-match"
          :class="{ 'graph-best-match-active': sortBy === 'relevance' }" :aria-pressed="sortBy === 'relevance'"
          @click="$emit('sort', { sortBy: 'relevance', direction: 'desc' })">Best match</button>
      </div>
      <button type="button" data-graph-control="graph-changes" class="graph-entries-changes" @click="$emit('changes')">
        <IconHistory :size="13" aria-hidden="true" />Changes
      </button>
    </div>
    <div ref="root" class="graph-entries-scroll">
      <table aria-label="Graph entries" @keydown="onRowKeydown">
        <thead><tr>
          <th v-for="column in columns" :key="column.id" scope="col" :class="`graph-entry-${column.id}`"
            :aria-sort="sortBy === column.id ? (direction === 'asc' ? 'ascending' : 'descending') : undefined">
            <div class="graph-entry-heading">
              <button type="button" class="graph-entry-sort" :data-graph-control="`graph-sort-${column.id}`"
                :aria-label="`Sort by ${column.label.toLowerCase()}${sortBy === column.id ? ', reverse order' : ''}`" @click="sortColumn(column.id)">
                {{ column.label }}
                <component :is="direction === 'asc' ? IconArrowUp : IconArrowDown" v-if="sortBy === column.id" :size="12" aria-hidden="true" />
              </button>
              <GraphColumnFilter v-if="column.id === 'kind'" ref="kindMenu" column="kind" label="Kind"
                :model-value="kinds" :options="kindOptions" @update:model-value="$emit('update:kinds', $event)" />
              <GraphColumnFilter v-if="column.id === 'project'" ref="projectMenu" column="project" label="Project" searchable
                :model-value="projectIds" :options="projectOptions" @update:model-value="$emit('update:projectIds', $event)" />
            </div>
          </th>
        </tr></thead>
        <tbody>
          <tr v-for="node in nodes" :key="node.id" class="graph-entry-row" :data-entry-row="node.id"
            :class="{ 'graph-entry-selected': selectedId === node.id }" @click="openRow(node)">
            <td class="graph-entry-title">
              <button type="button" :data-graph-node="node.id" :data-graph-control="`list-open-${node.id}`"
                :tabindex="selectedId === node.id ? 0 : -1" :aria-label="`${node.title || 'Untitled entry'}. ${kindLabel(node.kind)}`"
                :title="node.title" @focus="selectedId = node.id" @click.stop="openRow(node)">
                <span>{{ node.title || 'Untitled entry' }}</span>
              </button>
            </td>
            <td class="graph-entry-kind" :title="kindLabel(node.kind)">{{ kindLabel(node.kind) }}</td>
            <td class="graph-entry-project" :title="projectNames(node).join(', ') || 'No project'">
              <span>{{ projectNames(node)[0] || '—' }}</span><small v-if="projectNames(node).length > 1">+{{ projectNames(node).length - 1 }}</small>
            </td>
            <td v-for="field in ['created', 'updated']" :key="field" :class="`graph-entry-${field}`">
              <time v-if="validDate(node[`${field}At`])" :datetime="node[`${field}At`]" :title="fullDate(node[`${field}At`])">{{ shortDate(node[`${field}At`]) }}</time>
              <span v-else aria-label="No date">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading && !nodes.length" class="graph-entries-empty" role="status">Loading graph entries</div>
      <div v-else-if="!nodes.length" class="graph-entries-empty">
        <h2>{{ emptyTitle }}</h2><p>{{ emptyCopy }}</p>
        <button v-if="!activeFilters.length && !searchActive" type="button" data-graph-control="graph-empty-create" @click="$emit('create')">Create an item</button>
      </div>
      <div v-if="canLoadMore" class="graph-entries-more">
        <button type="button" data-graph-control="graph-load-more" :disabled="loading || loadingMore" @click="$emit('loadMore')">
          {{ loadingMore ? 'Loading entries…' : 'Show more' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { IconArrowDown, IconArrowUp, IconHistory, IconX } from '@tabler/icons-vue'
import GraphColumnFilter from './GraphColumnFilter.vue'
import { entryProjects, graphKindLabel as kindLabel, NO_PROJECT } from './graphEntryMetadata.js'
const props = defineProps({
  nodes: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  currentProjectId: { type: String, default: '' },
  kinds: { type: Array, default: () => [] },
  availableKinds: { type: Array, default: () => [] },
  projectIds: { type: Array, default: () => [] },
  sortBy: { type: String, default: 'updated' },
  direction: { type: String, default: 'desc' },
  searchActive: { type: Boolean, default: false },
  contextKey: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  loadingMore: { type: Boolean, default: false },
  canLoadMore: { type: Boolean, default: false },
  emptyTitle: { type: String, default: 'The graph is empty' },
  emptyCopy: { type: String, default: 'Create an item or choose another scope.' },
})
const emit = defineEmits(['open', 'create', 'sort', 'loadMore', 'changes', 'update:kinds', 'update:projectIds'])
const columns = [{ id: 'title', label: 'Title' }, { id: 'kind', label: 'Kind' }, { id: 'project', label: 'Project' }, { id: 'created', label: 'Created' }, { id: 'updated', label: 'Updated' }]
const root = ref(null), kindMenu = ref([]), projectMenu = ref([]), selectedId = ref('')
const kindOptions = computed(() => {
  const options = new Map()
  for (const kind of [...props.availableKinds, ...props.kinds, ...props.nodes.map(node => node.kind)]) {
    if (kind && !options.has(kind)) options.set(kind, { value: kind, label: kindLabel(kind) })
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
})
const projectOptions = computed(() => {
  const options = props.projects.map(project => ({ value: project.id, label: project.title,
    hint: project.id === props.currentProjectId ? 'Current workspace' : (props.projects.some(other => other.id !== project.id && other.title === project.title) ? project.scopeId : '') }))
    .sort((a, b) => Number(b.value === props.currentProjectId) - Number(a.value === props.currentProjectId) || a.label.localeCompare(b.label))
  for (const id of props.projectIds) {
    if (id !== NO_PROJECT && !options.some(option => option.value === id)) options.push({ value: id, label: 'Unavailable project', hint: 'Not found in these scopes' })
  }
  return [...options, { value: NO_PROJECT, label: 'No project' }]
})
const activeFilters = computed(() => [
  props.kinds.length && { id: 'kinds', label: `Kind: ${props.kinds.map(kindLabel).join(', ')}` },
  props.projectIds.length && { id: 'projectIds', label: `Project: ${props.projectIds.map(id => projectOptions.value.find(option => option.value === id)?.label || id).join(', ')}` },
].filter(Boolean))
const projectLabels = computed(() => new Map(props.nodes.map(node => [node.id, entryProjects(node, props.projects).map(project => project.title)])))
function projectNames(node) { return projectLabels.value.get(node.id) || [] }
function clearFilters() { emit('update:kinds', []); emit('update:projectIds', []) }
function sortColumn(sortBy) {
  emit('sort', { sortBy, direction: sortBy === props.sortBy ? (props.direction === 'asc' ? 'desc' : 'asc') : undefined })
}
function openRow(node) { selectedId.value = node.id; emit('open', node.id) }
function rowButton(id) { return [...root.value?.querySelectorAll('[data-graph-node]') || []].find(element => element.dataset.graphNode === id) }
function focusRow(id) {
  selectedId.value = id
  void nextTick(() => {
    const button = rowButton(id)
    button?.focus({ preventScroll: true })
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
}
function focusNode(id) { if (!props.nodes.some(node => node.id === id)) return false; focusRow(id); return true }
function focusEdge(edge) { const node = edge === 'last' ? props.nodes.at(-1) : props.nodes[0]; return node ? focusNode(node.id) : false }
function closeMenus(options) {
  return [...kindMenu.value, ...projectMenu.value].reduce((closed, menu) => menu.closeMenus(options) || closed, false)
}
watch([() => props.nodes, () => props.loading], () => {
  if (!props.loading && !props.nodes.some(node => node.id === selectedId.value)) selectedId.value = props.nodes[0]?.id || ''
}, { immediate: true })
// Keep the first visible entry at the same pixel when background updates reorder rows.
// Explicit search, sort, and filter changes start at the top instead.
watch(() => props.nodes, async () => {
  const scroller = root.value
  if (!scroller) return
  const context = props.contextKey
  const focused = scroller.contains(document.activeElement) ? document.activeElement?.dataset.graphNode : ''
  const edge = scroller.getBoundingClientRect().top + 29
  const anchor = scroller.scrollTop > 0 ? [...scroller.querySelectorAll('[data-entry-row]')].find(row => row.getBoundingClientRect().bottom > edge) : null
  const top = anchor?.getBoundingClientRect().top
  await nextTick()
  if (context !== props.contextKey) return
  if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - top
  if (focused && document.activeElement === document.body) rowButton(focused)?.focus({ preventScroll: true })
})
watch(() => props.contextKey, () => { if (root.value) root.value.scrollTop = 0 })
function onRowKeydown(event) {
  if (event.isComposing) return
  const button = event.target.closest('[data-graph-node]')
  if (!button || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = props.nodes.findIndex(node => node.id === button.dataset.graphNode)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.nodes.length - 1
    : Math.max(0, Math.min(props.nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  if (props.nodes[next]) focusRow(props.nodes[next].id)
}
function validDate(value) { return Boolean(value) && !Number.isNaN(Date.parse(value)) }
const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
function shortDate(value) {
  const date = new Date(value), today = new Date(), yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.getFullYear() === today.getFullYear() ? dateFormat.format(date) : `${dateFormat.format(date)} ${date.getFullYear()}`
}
function fullDate(value) { return new Date(value).toLocaleString() }
defineExpose({ focusEdge, focusNode, closeMenus })
</script>

<style scoped>
.graph-entries { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; background: var(--color-surface); }
.graph-entries-tools { display: flex; min-height: 28px; flex-shrink: 0; gap: 8px; align-items: flex-start; padding: 0 10px; border-bottom: 1px solid var(--color-rule-light); background: var(--color-chrome-high); font-size: 11px; color: var(--color-ink-3); }
.graph-entry-filters { display: flex; min-width: 0; flex: 1; flex-wrap: wrap; gap: 0 8px; }
.graph-entries-tools button { display: inline-flex; min-height: 28px; min-width: 0; align-items: center; gap: 5px; text-align: left; }
.graph-entry-filter-chip { max-width: 100%; color: var(--color-accent); }
.graph-entry-filter-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-entry-filter-chip svg { flex-shrink: 0; }
.graph-entries-changes { flex-shrink: 0; }
.graph-best-match-active { color: var(--color-ink); font-weight: 600; }
.graph-entries-scroll { min-height: 0; flex: 1; overflow: auto; overflow-anchor: none; }
.graph-entries table { width: 100%; min-width: 690px; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 11.5px; color: var(--color-ink); }
.graph-entries th, .graph-entries td { padding: 0 12px; text-align: left; }
.graph-entries thead th { position: sticky; top: 0; z-index: 3; height: 28px; border-bottom: 1px solid var(--color-rule); background: var(--color-chrome-high); color: var(--color-ink-2); font-weight: 600; }
.graph-entry-heading { display: flex; align-items: center; }
.graph-entry-sort { display: flex; min-height: 28px; min-width: 0; align-items: center; gap: 5px; }
.graph-entry-sort svg { flex-shrink: 0; }
.graph-entry-kind { width: 122px; }
.graph-entry-project { width: 152px; }
.graph-entry-created, .graph-entry-updated { width: 100px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.graph-entry-row { cursor: pointer; background: var(--color-surface); }
.graph-entry-row td { height: 32px; color: var(--color-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-entry-row .graph-entry-title { color: var(--color-ink); }
.graph-entry-row:hover { background: var(--color-chrome-mid); }
.graph-entry-selected, .graph-entry-selected:hover { background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
.graph-entry-project > span { display: inline-block; max-width: calc(100% - 18px); overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.graph-entry-project small { margin-inline-start: 4px; font-size: 10px; }
td.graph-entry-title button { display: flex; width: 100%; min-width: 0; min-height: 32px; align-items: center; text-align: left; }
td.graph-entry-title button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-entries button:hover { color: var(--color-ink); }
.graph-entries button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.graph-entries-empty { display: grid; min-height: 200px; padding: 28px 16px; place-content: center; justify-items: center; gap: 8px; text-align: center; font-size: 12px; }
.graph-entries-empty h2 { font-size: 14px; font-weight: 600; }
.graph-entries-empty p { max-width: 340px; color: var(--color-ink-3); }
.graph-entries-empty button, .graph-entries-more button { min-height: 28px; padding: 0 10px; border: 1px solid var(--color-rule); font-size: 12px; }
.graph-entries-more { display: flex; justify-content: center; padding: 12px; }
.graph-entries-more button:disabled { opacity: .5; cursor: default; }
@container business-graph (max-width: 700px) {
  .graph-entries th.graph-entry-title { position: sticky; left: 0; z-index: 4; width: 200px; }
  .graph-entries td.graph-entry-title { position: sticky; left: 0; z-index: 1; background: inherit; }
  .graph-entries tr { background: inherit; }
  .graph-entries .graph-entry-row { background: var(--color-surface); }
  .graph-entries .graph-entry-row:hover { background: var(--color-chrome-mid); }
  .graph-entries .graph-entry-selected, .graph-entries .graph-entry-selected:hover { background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
}
@container business-graph (max-width: 419px) {
  .graph-entries th.graph-entry-title { width: 160px; }
  .graph-entries th, .graph-entries td { padding-inline: 8px; }
}
</style>
