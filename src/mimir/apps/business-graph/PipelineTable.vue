<template>
  <div class="pipeline-table" data-graph-entries :data-pipeline-table="view">
    <div ref="root" class="pipeline-table-scroll">
      <table :aria-label="label" @keydown="onKeydown">
        <thead><tr>
          <th v-for="column in columns" :key="column.id" scope="col" :class="`pipeline-col-${column.id}`"
            :style="column.width ? { width: column.width } : undefined">
            <div class="pipeline-heading">
              <span>{{ column.label }}</span>
              <GraphColumnFilter v-if="column.filter" ref="filterMenus" :column="`${view}-${column.filter.id}`"
                :label="column.filter.label" :searchable="column.filter.searchable"
                :model-value="filters[column.filter.id] || []" :options="column.filter.options"
                @update:model-value="$emit('filter', column.filter.id, $event)" />
            </div>
          </th>
        </tr></thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr class="pipeline-row" :data-pipeline-row="row.id"
              :class="{ 'pipeline-row-selected': selectedId === row.id, 'pipeline-row-open': expandedId === row.id }"
              @click="toggle(row)">
              <td v-for="(column, index) in columns" :key="column.id" :class="`pipeline-col-${column.id}`">
                <button v-if="index === 0" type="button" class="pipeline-row-toggle"
                  :data-pipeline-row-button="row.id" :data-graph-control="`pipeline-row-${view}-${row.id}`"
                  :tabindex="selectedId === row.id ? 0 : -1" :aria-expanded="expandedId === row.id"
                  :aria-label="`${rowLabel(row)}. ${expandedId === row.id ? 'Close' : 'Show'} details`"
                  @focus="selectedId = row.id" @click.stop="toggle(row)">
                  <IconChevronRight :size="12" class="pipeline-row-chevron" :class="{ open: expandedId === row.id }" aria-hidden="true" />
                  <span class="pipeline-row-name"><slot name="cell" :row="row" :column="column" /></span>
                </button>
                <slot v-else name="cell" :row="row" :column="column" />
              </td>
            </tr>
            <tr v-if="expandedId === row.id" class="pipeline-detail-row" :data-pipeline-detail="row.id">
              <td :colspan="columns.length"><slot name="detail" :row="row" /></td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="!rows.length" class="pipeline-table-empty">
        <h2>{{ emptyTitle }}</h2><p>{{ emptyCopy }}</p>
        <button v-if="hasFilters" type="button" data-graph-control="pipeline-empty-clear-filters" @click="$emit('clearFilters')">Clear filters</button>
      </div>
      <div v-if="canLoadMore" class="pipeline-table-more">
        <button type="button" data-graph-control="pipeline-load-more" @click="$emit('loadMore')">Show more</button>
        <span>{{ moreLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { IconChevronRight } from '@tabler/icons-vue'
import GraphColumnFilter from './GraphColumnFilter.vue'

const props = defineProps({
  view: { type: String, required: true },
  label: { type: String, required: true },
  columns: { type: Array, required: true },
  rows: { type: Array, default: () => [] },
  filters: { type: Object, default: () => ({}) },
  hasFilters: { type: Boolean, default: false },
  expandedId: { type: String, default: '' },
  emptyTitle: { type: String, default: 'Nothing matches this view' },
  emptyCopy: { type: String, default: '' },
  canLoadMore: { type: Boolean, default: false },
  moreLabel: { type: String, default: '' },
})
const emit = defineEmits(['toggle', 'filter', 'clearFilters', 'loadMore'])
const root = ref(null), filterMenus = ref([]), selectedId = ref('')

function rowLabel(row) { return row.title || 'Untitled' }
function toggle(row) {
  selectedId.value = row.id
  emit('toggle', row.id)
}
function rowButton(id) {
  return [...root.value?.querySelectorAll('[data-pipeline-row-button]') || []].find(element => element.dataset.pipelineRowButton === id)
}
function focusRow(id) {
  if (!props.rows.some(row => row.id === id)) return false
  selectedId.value = id
  void nextTick(() => {
    const button = rowButton(id)
    button?.focus({ preventScroll: true })
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
  return true
}
function focusEdge(edge) {
  const row = edge === 'last' ? props.rows.at(-1) : props.rows[0]
  return row ? focusRow(row.id) : false
}
function closeMenus(options) {
  return (filterMenus.value || []).reduce((closed, menu) => menu?.closeMenus(options) || closed, false)
}
// Row keys move between rows. Fields in an open detail keep their own keys.
function onKeydown(event) {
  if (event.isComposing || event.keyCode === 229) return
  const button = event.target.closest?.('[data-pipeline-row-button]')
  if (!button || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = props.rows.findIndex(row => row.id === button.dataset.pipelineRowButton)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.rows.length - 1
    : Math.max(0, Math.min(props.rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  if (props.rows[next]) focusRow(props.rows[next].id)
}
watch(() => props.rows, rows => {
  if (!rows.some(row => row.id === selectedId.value)) selectedId.value = rows[0]?.id || ''
}, { immediate: true })

defineExpose({ closeMenus, focusEdge, focusRow })
</script>

<style scoped>
.pipeline-table { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; background: var(--color-surface); }
.pipeline-table-scroll { min-height: 0; flex: 1; overflow: auto; overflow-anchor: none; }
.pipeline-table table { width: 100%; min-width: 720px; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 11.5px; color: var(--color-ink); }
.pipeline-table th, .pipeline-table td { padding: 0 10px; text-align: left; vertical-align: middle; }
.pipeline-table thead th { position: sticky; top: 0; z-index: 3; height: 28px; border-bottom: 1px solid var(--color-rule); background: var(--color-chrome-high); color: var(--color-ink-2); font-weight: 600; white-space: nowrap; }
.pipeline-heading { display: flex; min-width: 0; align-items: center; gap: 4px; }
.pipeline-heading > span { overflow: hidden; text-overflow: ellipsis; }
.pipeline-row { cursor: pointer; background: var(--color-surface); }
.pipeline-row td { height: 34px; padding-block: 3px; color: var(--color-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pipeline-row td:first-child { color: var(--color-ink); }
.pipeline-row:hover { background: var(--color-chrome-mid); }
.pipeline-row-selected, .pipeline-row-selected:hover, .pipeline-row-open { background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface)); }
.pipeline-row-toggle { display: flex; width: 100%; min-width: 0; min-height: 28px; align-items: center; gap: 4px; text-align: left; }
.pipeline-row-chevron { flex: 0 0 auto; color: var(--color-ink-3); }
.pipeline-row-chevron.open { transform: rotate(90deg); }
.pipeline-row-name { display: flex; min-width: 0; flex-direction: column; }
.pipeline-detail-row td { padding: 0; border-top: 1px solid var(--color-rule-light); border-bottom: 1px solid var(--color-rule); background: var(--color-chrome-high); white-space: normal; }
.pipeline-table button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.pipeline-table-empty { display: grid; min-height: 200px; padding: 28px 16px; place-content: center; justify-items: center; gap: 8px; text-align: center; font-size: 12px; }
.pipeline-table-empty h2 { font-size: 14px; font-weight: 600; }
.pipeline-table-empty p { max-width: 360px; color: var(--color-ink-3); }
.pipeline-table-empty button, .pipeline-table-more button { min-height: 28px; padding: 0 10px; border: 1px solid var(--color-rule); font-size: 12px; }
.pipeline-table-more { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; color: var(--color-ink-3); font-size: 11px; }
@container business-graph (max-width: 700px) {
  .pipeline-table th:first-child { position: sticky; left: 0; z-index: 4; }
  .pipeline-table .pipeline-row td:first-child { position: sticky; left: 0; z-index: 1; background: inherit; }
}
</style>
