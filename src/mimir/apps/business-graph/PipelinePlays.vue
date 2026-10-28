<template>
  <PipelineTable ref="table" view="plays" label="Sales plays" :columns="columns" :rows="pipeline.visiblePlayRows"
    :filters="pipeline.filters.plays" :has-filters="hasFilters" :expanded-id="expandedId"
    :empty-title="emptyTitle" :empty-copy="pipeline.playRows.length ? emptyCopy : emptyNoPlays"
    @toggle="id => expandedId = expandedId === id ? '' : id"
    @filter="(id, values) => pipeline.setFilter('plays', id, values)" @clear-filters="pipeline.clearFilters('plays')">
    <template #cell="{ row, column }">
      <span v-if="column.id === 'play'" class="pipeline-title">{{ row.title }}</span>
      <span v-else :title="row[column.id]">{{ row[column.id] || '—' }}</span>
    </template>
    <template #detail="{ row }">
      <div class="pipeline-detail" :data-pipeline-play-detail="row.id">
        <div class="pipeline-detail-main">
          <section aria-label="Steps">
            <h3>Steps</h3>
            <ol v-if="row.steps.length"><li v-for="(step, index) in row.steps" :key="index">{{ step }}</li></ol>
            <p v-else class="pipeline-note">No steps set.</p>
          </section>
          <section v-if="row.learned" aria-label="What we learned">
            <h3>What we learned</h3>
            <p class="pipeline-detail-text">{{ row.learned }}</p>
          </section>
        </div>
        <div class="pipeline-detail-main">
          <section aria-label="Triggers used">
            <h3>Triggers used</h3>
            <div v-if="row.triggers.length" class="pipeline-links">
              <template v-for="trigger in row.triggers" :key="trigger.id">
                <span v-if="trigger.missing" class="pipeline-note">{{ trigger.title }}</span>
                <button v-else type="button" class="pipeline-link"
                  :data-graph-control="`pipeline-open-trigger-${trigger.id}`" @click="$emit('openNode', trigger.id)">{{ trigger.title }}</button>
              </template>
            </div>
            <p v-else class="pipeline-note">No triggers set.</p>
          </section>
          <p class="pipeline-note">The history of uses is in the note text.</p>
          <button type="button" class="pipeline-detail-action" data-graph-control="pipeline-open-play"
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
import { PIPELINE_COLUMNS, PLAY_TAG } from './pipelineModel.js'
import './pipeline.css'

defineProps({
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
})
defineEmits(['openNode'])
const pipeline = usePipelineStore()
const table = ref(null), expandedId = ref('')
const emptyNoPlays = `Create a note with the tag ${PLAY_TAG} to add a play.`
const FILTERS = { for: { id: 'for', label: 'For' }, verdict: { id: 'verdict', label: 'Result' } }
const WIDTHS = { play: '220px', for: '140px', verdict: '130px' }
const columns = computed(() => PIPELINE_COLUMNS.plays
  .filter(column => !pipeline.hiddenColumns.plays.includes(column.id))
  .map(column => ({
    ...column,
    width: WIDTHS[column.id],
    filter: FILTERS[column.id] ? { ...FILTERS[column.id], options: pipeline.filterOptions.plays[column.id] } : null,
  })))
const hasFilters = computed(() => Object.values(pipeline.filters.plays).some(values => values.length))

defineExpose({
  closeMenus: options => table.value?.closeMenus(options) || false,
  focusEdge: edge => table.value?.focusEdge(edge) || false,
  focusRow: id => table.value?.focusRow(id) || false,
})
</script>
