<template>
  <div v-if="pipeline.connectionsState !== 'ready' && !pipeline.networkRows.length" class="pipeline-network-state">
    <p v-if="pipeline.connectionsState === 'loading' || pipeline.connectionsState === 'idle'" class="pipeline-note" role="status">Loading connections</p>
    <template v-else-if="pipeline.connectionsState === 'error'">
      <p class="pipeline-error" role="alert">The connections file could not be read. {{ pipeline.connectionsError }}</p>
      <button type="button" class="pipeline-detail-action" data-graph-control="pipeline-connections-retry"
        @click="pipeline.loadConnections()">Retry</button>
    </template>
    <p v-else class="pipeline-note">No connections file. Add {{ path }} to the Team repository to show your network.</p>
  </div>
  <PipelineTable v-else ref="table" view="network" label="Network companies" :columns="columns" :rows="pipeline.shownNetworkRows"
    :filters="pipeline.filters.network" :has-filters="hasFilters" :expanded-id="expandedId"
    :empty-title="emptyTitle" :empty-copy="emptyCopy"
    :can-load-more="pipeline.shownNetworkRows.length < pipeline.visibleNetworkRows.length"
    :more-label="`${pipeline.shownNetworkRows.length} of ${pipeline.visibleNetworkRows.length} shown`"
    @toggle="id => expandedId = expandedId === id ? '' : id"
    @filter="(id, values) => pipeline.setFilter('network', id, values)" @clear-filters="pipeline.clearFilters('network')"
    @load-more="pipeline.showMoreNetwork()">
    <template #cell="{ row, column }">
      <template v-if="column.id === 'company'">
        <span class="pipeline-title">{{ row.title }}</span>
        <small class="pipeline-sub">{{ row.type }} (guess)</small>
      </template>
      <span v-else-if="column.id === 'connections'" class="pipeline-number">{{ row.connectionCount }}</span>
      <span v-else-if="column.id === 'messaged'" class="pipeline-number">{{ row.messagedCount ? `Yes, ${row.messagedCount}` : 'No' }}</span>
      <span v-else-if="column.id === 'roles'" :title="row.roles">{{ row.roles || '—' }}</span>
      <span v-else-if="column.id === 'inPipeline'" class="pipeline-in">
        <template v-if="row.inPipeline">Yes</template>
        <template v-else>
          <span>No</span>
          <button type="button" class="pipeline-inline-action" :data-graph-control="`pipeline-add-${row.key.replaceAll(' ', '-')}`"
            :disabled="adding === row.id" :aria-label="`Add ${row.title} to the pipeline`"
            @click.stop="add(row)">{{ adding === row.id ? 'Adding' : 'Add to pipeline' }}</button>
        </template>
      </span>
    </template>
    <template #detail="{ row }">
      <div class="pipeline-detail pipeline-network-detail" :data-pipeline-network-detail="row.id">
        <PipelinePeople :people="row.people" state="ready" show-company @notice="$emit('notice', $event)" />
        <div v-if="row.company" class="pipeline-detail-main">
          <button type="button" class="pipeline-detail-action" data-graph-control="pipeline-open-network-company"
            @click="$emit('openNode', row.company.id)">Open company details</button>
        </div>
      </div>
    </template>
  </PipelineTable>
</template>

<script setup>
import { computed, ref } from 'vue'
import { CONNECTIONS_PATH, usePipelineStore } from '../../../stores/businessGraphPipeline.js'
import PipelinePeople from './PipelinePeople.vue'
import PipelineTable from './PipelineTable.vue'
import { PIPELINE_COLUMNS } from './pipelineModel.js'
import { graphErrorMessage } from './graphErrors.js'
import './pipeline.css'

defineProps({
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
})
const emit = defineEmits(['openNode', 'notice'])
const pipeline = usePipelineStore()
const table = ref(null), expandedId = ref(''), adding = ref('')
const path = CONNECTIONS_PATH
const FILTERS = {
  company: { id: 'type', label: 'Type' },
  connections: { id: 'connections', label: 'Connections' },
  messaged: { id: 'messaged', label: 'Messaged' },
  inPipeline: { id: 'inPipeline', label: 'In pipeline' },
}
const WIDTHS = { company: '240px', connections: '120px', messaged: '110px', inPipeline: '170px' }
const columns = computed(() => PIPELINE_COLUMNS.network
  .filter(column => !pipeline.hiddenColumns.network.includes(column.id))
  .map(column => ({
    ...column,
    width: WIDTHS[column.id],
    filter: FILTERS[column.id] ? { ...FILTERS[column.id], options: pipeline.filterOptions.network[FILTERS[column.id].id] } : null,
  })))
const hasFilters = computed(() => Object.values(pipeline.filters.network).some(values => values.length))

async function add(row) {
  if (adding.value) return
  adding.value = row.id
  try {
    await pipeline.addToPipeline(row)
    emit('notice', `${row.title} is in the pipeline at stage Target.`)
  } catch (cause) {
    emit('notice', `${row.title} was not added. ${graphErrorMessage(cause)}`)
  } finally {
    adding.value = ''
  }
}

defineExpose({
  closeMenus: options => table.value?.closeMenus(options) || false,
  focusEdge: edge => table.value?.focusEdge(edge) || false,
  focusRow: id => table.value?.focusRow(id) || false,
})
</script>

<style scoped>
.pipeline-network-state { display: grid; min-height: 200px; padding: 28px 16px; place-content: center; justify-items: center; gap: 10px; text-align: center; background: var(--color-surface); }
.pipeline-in { display: inline-flex; align-items: center; gap: 8px; }
.pipeline-network-detail { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
</style>
