<template>
  <PipelineTable ref="table" view="triggers" label="Sales triggers" :columns="columns" :rows="pipeline.visibleTriggerRows"
    :filters="pipeline.filters.triggers" :has-filters="hasFilters" :expanded-id="expandedId"
    :empty-title="emptyTitle" :empty-copy="pipeline.triggerRows.length ? emptyCopy : emptyNoTriggers"
    @toggle="id => expandedId = expandedId === id ? '' : id"
    @filter="(id, values) => pipeline.setFilter('triggers', id, values)" @clear-filters="pipeline.clearFilters('triggers')">
    <template #cell="{ row, column }">
      <span v-if="column.id === 'trigger'" class="pipeline-title">{{ row.title }}</span>
      <span v-else :title="row[column.id]">{{ row[column.id] || '—' }}</span>
    </template>
    <template #detail="{ row }">
      <div class="pipeline-detail" :data-pipeline-trigger-detail="row.id">
        <div class="pipeline-detail-main">
          <section aria-label="Why it matters">
            <h3>Why it matters</h3>
            <p class="pipeline-detail-text">{{ row.why || 'Not set.' }}</p>
          </section>
          <section aria-label="Opener">
            <h3>Opener</h3>
            <p class="pipeline-detail-text">{{ row.opener || 'Not set.' }}</p>
          </section>
        </div>
        <div class="pipeline-detail-main">
          <section aria-label="Plays that use this trigger">
            <h3>Plays that use it</h3>
            <div v-if="row.plays.length" class="pipeline-links">
              <button v-for="play in row.plays" :key="play.id" type="button" class="pipeline-link"
                :data-graph-control="`pipeline-open-play-${play.id}`" @click="$emit('openNode', play.id)">{{ play.title }}</button>
            </div>
            <p v-else class="pipeline-note">No play uses this trigger.</p>
          </section>
          <button type="button" class="pipeline-detail-action" data-graph-control="pipeline-open-trigger"
            @click="$emit('openNode', row.id)">Open details</button>
        </div>
      </div>
    </template>
  </PipelineTable>
</template>

<script setup>
import { computed, ref } from 'vue'
import { usePipelineStore } from '../../../stores/businessGraphPipeline.js'
import PipelineTable from './PipelineTable.vue'
import { PIPELINE_COLUMNS, TRIGGER_TAG } from './pipelineModel.js'
import './pipeline.css'

defineProps({
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
})
defineEmits(['openNode'])
const pipeline = usePipelineStore()
const table = ref(null), expandedId = ref('')
const emptyNoTriggers = `Create a note with the tag ${TRIGGER_TAG} to add a trigger.`
const FILTERS = { category: { id: 'category', label: 'Category' }, for: { id: 'for', label: 'For' }, rating: { id: 'rating', label: 'Rating' } }
const WIDTHS = { trigger: '200px', category: '120px', for: '110px', rating: '96px' }
const columns = computed(() => PIPELINE_COLUMNS.triggers
  .filter(column => !pipeline.hiddenColumns.triggers.includes(column.id))
  .map(column => ({
    ...column,
    width: WIDTHS[column.id],
    filter: FILTERS[column.id] ? { ...FILTERS[column.id], options: pipeline.filterOptions.triggers[column.id] } : null,
  })))
const hasFilters = computed(() => Object.values(pipeline.filters.triggers).some(values => values.length))

defineExpose({
  closeMenus: options => table.value?.closeMenus(options) || false,
  focusEdge: edge => table.value?.focusEdge(edge) || false,
  focusRow: id => table.value?.focusRow(id) || false,
})
</script>
