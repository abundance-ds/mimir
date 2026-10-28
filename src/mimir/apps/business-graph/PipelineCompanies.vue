<template>
  <PipelineTable ref="table" view="companies" label="Pipeline companies" :columns="columns" :rows="pipeline.visibleCompanyRows"
    :filters="pipeline.filters.companies" :has-filters="hasFilters" :expanded-id="expandedId"
    :empty-title="emptyTitle" :empty-copy="emptyCopy"
    @toggle="toggle" @filter="(id, values) => pipeline.setFilter('companies', id, values)"
    @clear-filters="pipeline.clearFilters('companies')">
    <template #cell="{ row, column }">
      <template v-if="column.id === 'company'">
        <span class="pipeline-title">{{ row.title }}</span>
        <small v-if="row.type" class="pipeline-sub">{{ row.type }}</small>
      </template>
      <span v-else-if="column.id === 'headquarters'" :title="headquarters(row)">{{ headquarters(row) || '—' }}</span>
      <span v-else-if="column.id === 'stage'">{{ row.stage || 'Not set' }}</span>
      <span v-else-if="column.id === 'trigger'" :title="row.triggerTitle">{{ row.triggerTitle || '—' }}</span>
      <span v-else-if="column.id === 'play'" :title="row.playTitle">{{ row.playTitle || '—' }}</span>
      <span v-else-if="column.id === 'connections'" class="pipeline-number"
        :aria-label="`${row.connectionCount} connections, ${row.messagedCount} messaged`">
        {{ row.connectionCount }}<small v-if="row.connectionCount"> · {{ row.messagedCount }} messaged</small>
      </span>
      <span v-else-if="column.id === 'nextStep'" :title="row.nextStep">{{ row.nextStep || '—' }}</span>
    </template>
    <template #detail="{ row }">
      <div class="pipeline-detail" :data-pipeline-company-detail="row.id">
        <div class="pipeline-detail-main">
          <section aria-label="Why now">
            <h3>Why now</h3>
            <p v-if="row.triggerTitle" class="pipeline-detail-lead">{{ row.triggerTitle }}</p>
            <p v-if="row.triggerSummary" class="pipeline-detail-text">{{ row.triggerSummary }}</p>
            <p v-if="row.triggerNote" class="pipeline-detail-text">{{ row.triggerNote }}</p>
            <p v-if="!row.triggerTitle && !row.triggerNote" class="pipeline-note">No trigger set.</p>
          </section>
          <section class="pipeline-detail-fields" aria-label="Sales status">
            <label class="pipeline-field">
              <span>Stage</span>
              <GraphSelect :model-value="row.stage" data-graph-control="pipeline-stage" variant="property"
                :aria-label="`Stage for ${row.title}`" :options="stageOptions" :disabled="saving"
                @update:model-value="saveStage(row, $event)" />
            </label>
            <div class="pipeline-field">
              <label :for="`pipeline-next-${row.id}`">Next step</label>
              <div class="pipeline-next-step">
                <input :id="`pipeline-next-${row.id}`" ref="nextStepInput" v-model="nextStepDraft" type="text"
                  data-graph-control="pipeline-next-step" placeholder="Add the next step"
                  autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" writingsuggestions="false"
                  :disabled="saving" @keydown="onNextStepKeydown($event, row)" />
                <button type="button" data-graph-control="pipeline-next-step-save" :disabled="saving || !nextStepDirty(row)"
                  @click="saveNextStep(row)">Save</button>
                <button v-if="nextStepDirty(row)" type="button" data-graph-control="pipeline-next-step-cancel"
                  :disabled="saving" @click="cancelNextStep(row)">Cancel</button>
              </div>
            </div>
            <p v-if="saving" class="pipeline-note" role="status">Saving</p>
            <p v-else-if="saveError" class="pipeline-error" role="alert">{{ saveError }}</p>
            <p v-if="row.portfolio" class="pipeline-detail-text"><strong>Portfolio:</strong> {{ row.portfolio }}</p>
            <button type="button" class="pipeline-detail-action" data-graph-control="pipeline-open-company"
              @click="$emit('openNode', row.id)">Open details</button>
          </section>
        </div>
        <PipelinePeople :people="row.people" :state="pipeline.connectionsState" @notice="$emit('notice', $event)" />
      </div>
    </template>
  </PipelineTable>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { usePipelineStore } from '../../../stores/businessGraphPipeline.js'
import GraphSelect from './GraphSelect.vue'
import PipelinePeople from './PipelinePeople.vue'
import PipelineTable from './PipelineTable.vue'
import { PIPELINE_COLUMNS, PIPELINE_STAGES, headquarters } from './pipelineModel.js'
import { graphErrorMessage } from './graphErrors.js'
import './pipeline.css'

defineProps({
  emptyTitle: { type: String, default: '' },
  emptyCopy: { type: String, default: '' },
})
defineEmits(['openNode', 'notice'])
const pipeline = usePipelineStore()
const table = ref(null), nextStepInput = ref(null)
const expandedId = ref('')
const nextStepDraft = ref('')
const saving = ref(false)
const saveError = ref('')
const stageOptions = [{ value: '', label: 'Not set' }, ...PIPELINE_STAGES.map(stage => ({ value: stage, label: stage }))]
const FILTERS = {
  company: { id: 'type', label: 'Type', searchable: true },
  headquarters: { id: 'country', label: 'Country', searchable: true },
  stage: { id: 'stage', label: 'Stage' },
  trigger: { id: 'trigger', label: 'Trigger', searchable: true },
  play: { id: 'play', label: 'Play', searchable: true },
  connections: { id: 'connections', label: 'Connections' },
}
const WIDTHS = { company: '220px', headquarters: '150px', stage: '120px', connections: '140px' }
const columns = computed(() => PIPELINE_COLUMNS.companies
  .filter(column => !pipeline.hiddenColumns.companies.includes(column.id))
  .map(column => ({
    ...column,
    width: WIDTHS[column.id],
    filter: FILTERS[column.id] ? { ...FILTERS[column.id], options: pipeline.filterOptions.companies[FILTERS[column.id].id] } : null,
  })))
const hasFilters = computed(() => Object.values(pipeline.filters.companies).some(values => values.length) || pipeline.includeUnstaged)
const expandedRow = computed(() => pipeline.companyRows.find(row => row.id === expandedId.value))

function toggle(id) {
  expandedId.value = expandedId.value === id ? '' : id
  saveError.value = ''
  nextStepDraft.value = expandedRow.value?.nextStep || ''
}
// Follow saved changes while the field holds no local edit.
watch(() => expandedRow.value?.nextStep, (value, previous) => {
  if (nextStepDraft.value === (previous || '')) nextStepDraft.value = value || ''
})
function nextStepDirty(row) { return nextStepDraft.value.trim() !== row.nextStep }

async function save(row, key, value) {
  if (saving.value) return false
  saving.value = true
  saveError.value = ''
  try {
    await pipeline.setCompanyProperty(row, key, value)
    return true
  } catch (cause) {
    saveError.value = `Not saved. ${graphErrorMessage(cause)}`
    return false
  } finally {
    saving.value = false
  }
}
function saveStage(row, value) {
  if (value !== row.stage) void save(row, 'pipelineStage', value)
}
// Commit only on Enter or Save. Blur keeps the draft and never writes.
async function saveNextStep(row) {
  if (!nextStepDirty(row)) return
  const value = nextStepDraft.value.trim()
  if (await save(row, 'pipelineNextStep', value)) nextStepDraft.value = value
  await nextTick()
  nextStepInput.value?.focus?.({ preventScroll: true })
}
function cancelNextStep(row) {
  nextStepDraft.value = row.nextStep
  saveError.value = ''
}
function onNextStepKeydown(event, row) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void saveNextStep(row)
  } else if (event.key === 'Escape' && nextStepDirty(row)) {
    event.preventDefault()
    event.stopPropagation()
    cancelNextStep(row)
  }
}

defineExpose({
  closeMenus: options => table.value?.closeMenus(options) || false,
  focusEdge: edge => table.value?.focusEdge(edge) || false,
  focusRow: id => table.value?.focusRow(id) || false,
})
</script>
