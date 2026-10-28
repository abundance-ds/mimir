<template>
  <div class="pipeline-workspace" data-pipeline>
    <div data-pipeline-viewbar class="pipeline-viewbar pane-subbar">
      <nav class="pipeline-views" aria-label="Pipeline views">
        <button v-for="option in viewOptions" :key="option.id" type="button" :data-graph-view="option.id"
          :data-graph-control="`view-${option.id}`" class="pipeline-view" :class="{ 'pipeline-view-active': view === option.id }"
          :aria-pressed="view === option.id" @click="$emit('setView', option.id)">{{ option.label }}</button>
      </nav>
      <div v-if="activeFilters.length" class="pipeline-active-filters" aria-label="Active filters">
        <button v-for="filter in activeFilters" :key="filter.id" type="button" class="pipeline-filter-chip"
          :data-graph-control="`pipeline-clear-filter-${filter.id}`" :aria-label="`Clear filter ${filter.label}`"
          :title="`Clear filter ${filter.label}`" @click="clearFilter(filter.id)">
          <span>{{ filter.label }}</span><IconX :size="11" aria-hidden="true" />
        </button>
      </div>
      <div class="pipeline-actions">
        <GraphCheckbox v-if="view === 'companies'" :model-value="pipeline.includeUnstaged" data-graph-control="pipeline-show-unstaged"
          class="pipeline-unstaged" title="Show companies that have no stage"
          @update:model-value="pipeline.includeUnstaged = $event">Show all companies</GraphCheckbox>
        <PipelineColumnsMenu ref="columnsMenu" :view="view" :view-label="viewLabel" :columns="columns"
          :hidden="pipeline.hiddenColumns[view] || []" @toggle="(column, hidden) => pipeline.setColumnHidden(view, column, hidden)" />
        <button v-if="view === 'companies'" type="button" class="pipeline-bar-button" data-graph-control="pipeline-export" aria-label="Export CSV"
          :disabled="!pipeline.visibleCompanyRows.length" title="Export the rows shown as CSV. The file has all columns."
          @click="exportCompanies"><IconDownload :size="13" aria-hidden="true" /><span>Export CSV</span></button>
        <button v-if="view === 'companies'" type="button" class="pipeline-bar-button" data-graph-control="pipeline-new-company" aria-label="New company"
          @click="$emit('openCreate', 'company')"><IconPlus :size="13" aria-hidden="true" /><span>New company</span></button>
      </div>
    </div>
    <p v-if="notice" class="pipeline-notice" role="status">
      <span>{{ notice }}</span>
      <button type="button" data-graph-control="pipeline-notice-dismiss" aria-label="Dismiss message" @click="notice = ''"><IconX :size="11" aria-hidden="true" /></button>
    </p>
    <div v-if="pipeline.error && !pipeline.loaded" class="pipeline-state" role="alert">
      <h2>The pipeline could not load</h2>
      <p>{{ pipeline.error }}</p>
      <button type="button" data-graph-control="pipeline-retry" @click="pipeline.load({ withConnections: true })">Retry</button>
    </div>
    <div v-else-if="!pipeline.loaded" class="pipeline-state" role="status">
      <span class="pipeline-loading-mark" aria-hidden="true" />
      <h2>Loading the pipeline</h2>
    </div>
    <template v-else>
      <p v-if="pipeline.error" class="pipeline-notice pipeline-notice-error" role="alert">
        <span>Not updated. {{ pipeline.error }}</span>
        <button type="button" data-graph-control="pipeline-reload" @click="pipeline.load()">Retry</button>
      </p>
      <PipelineCompanies v-if="view === 'companies'" ref="surface" :empty-title="emptyTitle" :empty-copy="companiesEmptyCopy"
        @open-node="$emit('openNode', $event)" @notice="notice = $event" />
      <PipelineTriggers v-else-if="view === 'triggers'" ref="surface" :empty-title="emptyTitle" :empty-copy="emptyCopy"
        @open-node="$emit('openNode', $event)" />
      <PipelinePlays v-else-if="view === 'plays'" ref="surface" :empty-title="emptyTitle" :empty-copy="emptyCopy"
        @open-node="$emit('openNode', $event)" />
      <PipelineNetwork v-else-if="view === 'network'" ref="surface" :empty-title="emptyTitle" :empty-copy="emptyCopy"
        @open-node="$emit('openNode', $event)" @notice="notice = $event" />
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { IconDownload, IconPlus, IconX } from '@tabler/icons-vue'
import { usePipelineStore } from '../../../stores/businessGraphPipeline.js'
import { exportCsvFile } from '../../../services/timesheetExport.js'
import GraphCheckbox from './GraphCheckbox.vue'
import PipelineColumnsMenu from './PipelineColumnsMenu.vue'
import PipelineCompanies from './PipelineCompanies.vue'
import PipelineNetwork from './PipelineNetwork.vue'
import PipelinePlays from './PipelinePlays.vue'
import PipelineTriggers from './PipelineTriggers.vue'
import { NOT_SET, PIPELINE_COLUMNS, companyCsv } from './pipelineModel.js'
import { graphErrorMessage } from './graphErrors.js'

const props = defineProps({
  view: { type: String, default: 'companies' },
  viewOptions: { type: Array, default: () => [] },
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
})
defineEmits(['setView', 'openNode', 'openCreate'])
const pipeline = usePipelineStore()
const surface = ref(null), columnsMenu = ref(null), notice = ref('')
const columns = computed(() => PIPELINE_COLUMNS[props.view] || [])
const viewLabel = computed(() => props.viewOptions.find(option => option.id === props.view)?.label || '')
const FILTER_LABELS = {
  type: 'Type', country: 'Country', stage: 'Stage', trigger: 'Trigger', play: 'Play', connections: 'Connections',
  category: 'Category', for: 'For', rating: 'Rating', verdict: 'Result', messaged: 'Messaged', inPipeline: 'In pipeline',
}
const activeFilters = computed(() => {
  const view = props.view
  const options = pipeline.filterOptions[view] || {}
  const chips = Object.entries(pipeline.filters[view] || {}).filter(([, values]) => values.length).map(([id, values]) => ({
    id,
    label: `${FILTER_LABELS[id] || id}: ${values.map(value => options[id]?.find(option => option.value === value)?.label
      || (value === NOT_SET ? 'Not set' : value)).join(', ')}`,
  }))
  if (view === 'companies' && pipeline.includeUnstaged) chips.push({ id: 'unstaged', label: 'All companies' })
  return chips
})
const companiesEmptyCopy = computed(() => (!pipeline.includeUnstaged && pipeline.companyRows.length && !pipeline.companyRows.some(row => row.stage)
  ? 'No company has a stage. Select Show all companies, or set a stage.'
  : props.emptyCopy))

function clearFilter(id) {
  if (id === 'unstaged') pipeline.includeUnstaged = false
  else pipeline.setFilter(props.view, id, [])
}

async function exportCompanies() {
  // Freeze the rows before the dialog opens.
  const content = companyCsv(pipeline.visibleCompanyRows)
  try {
    if (await exportCsvFile('Pipeline companies', content, 'pipeline')) notice.value = 'CSV exported.'
  } catch (cause) {
    notice.value = `CSV not exported. ${graphErrorMessage(cause)}`
  }
}

watch(() => props.view, () => { notice.value = '' })

defineExpose({
  closeMenus: options => columnsMenu.value?.closeMenus(options) || surface.value?.closeMenus?.(options) || false,
  focusListEdge: edge => surface.value?.focusEdge?.(edge) || false,
  focusNode: id => surface.value?.focusRow?.(id) || false,
})
</script>

<style scoped>
.pipeline-workspace { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; }
.pipeline-viewbar { position: relative; min-width: 0; gap: 8px; }
.pipeline-views { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
.pipeline-view { height: 22px; border-radius: 3px; padding: 0 8px; color: var(--color-ink-3); font-size: 10px; font-weight: 540; }
.pipeline-view:hover { background: var(--graph-hover); color: var(--color-ink); }
.pipeline-view-active { color: var(--color-ink); font-weight: 700; }
.pipeline-active-filters { display: flex; min-width: 0; flex: 1 1 auto; align-items: center; gap: 4px; overflow: hidden; }
.pipeline-filter-chip { display: inline-flex; height: 22px; min-width: 0; max-width: 180px; flex: 0 1 auto; align-items: center; gap: 4px; border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule)); border-radius: 3px; background: var(--color-accent-soft); padding: 0 5px 0 7px; color: var(--color-ink-2); font-size: 9.5px; }
.pipeline-filter-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pipeline-filter-chip:hover { background: var(--color-chrome-mid); color: var(--color-ink); }
.pipeline-filter-chip svg { flex: 0 0 auto; color: var(--color-accent); }
.pipeline-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; margin-left: auto; }
.pipeline-unstaged { min-height: 24px; font-size: 10px; }
.pipeline-bar-button { display: inline-flex; height: 24px; align-items: center; gap: 5px; border: 1px solid var(--color-rule-light); border-radius: 3px; background: var(--color-chrome-high); padding: 0 7px; color: var(--color-ink-2); font-size: 10px; }
.pipeline-bar-button:hover:not(:disabled) { background: var(--color-chrome-mid); color: var(--color-ink); }
.pipeline-bar-button:disabled { color: var(--color-ink-4); cursor: default; }
.pipeline-view:focus-visible, .pipeline-filter-chip:focus-visible, .pipeline-bar-button:focus-visible, .pipeline-notice button:focus-visible, .pipeline-state button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.pipeline-notice { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--color-rule); background: var(--color-surface); padding: 5px 12px; color: var(--color-ink-2); font-size: 11px; }
.pipeline-notice span { flex: 1 1 auto; }
.pipeline-notice button { display: inline-flex; min-height: 22px; align-items: center; padding: 0 6px; color: var(--color-ink-3); font-size: 11px; }
.pipeline-notice-error { color: var(--color-rem); }
.pipeline-state { display: grid; min-height: 0; flex: 1 1 auto; place-content: center; justify-items: center; gap: 8px; padding: 40px 24px; background: var(--color-surface); text-align: center; }
.pipeline-state h2 { color: var(--color-ink); font-size: 14px; font-weight: 640; }
.pipeline-state p { max-width: 420px; color: var(--color-ink-3); font-size: 12px; }
.pipeline-state button { min-height: 28px; padding: 0 10px; border: 1px solid var(--color-rule); font-size: 12px; }
.pipeline-loading-mark { width: 24px; height: 24px; border: 2px solid var(--color-rule); border-top-color: var(--color-accent); border-radius: 50%; animation: pipeline-spin 750ms linear infinite; }
@keyframes pipeline-spin { to { transform: rotate(360deg); } }
@container business-graph (max-width: 620px) {
  .pipeline-bar-button span, .pipeline-columns-label { display: none; }
}
</style>
