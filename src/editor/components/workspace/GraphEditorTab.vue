<template>
  <div class="graph-editor-tab" data-graph-editor-tab>
    <div v-if="file.graph?.closedUndo" class="graph-close-notice" role="status">
      <span>Issue closed.</span>
      <button type="button" :disabled="file.dirty || file.saveState === 'saving'" @click="undoClose">Undo</button>
    </div>
    <GraphInspector
      v-if="file.graph?.node"
      ref="inspector"
      :document-file="file"
      :view-state="viewState"
      :scope-ids="graph.activeScopeIds"
      :graph-revision="graph.status?.graphRevision || 0"
      :scopes="graph.scopes"
      :nodes="graph.nodes"
      :neighbors="neighbors"
      :activities="relatedActivities"
      :error="file.saveError || error"
      @draft-change="files.graphDraftChanged(file)"
      @save="save"
      @source="$emit('source')"
      @close-request="$emit('closeRequest')"
      @open-node="$emit('openGraph', $event)"
      @open-file="openFile"
      @open-url="$emit('openUrl', $event)"
      @open-activity="$emit('openActivity', $event)"
      @open-meeting="$emit('openMeeting', $event)"
      @quick-create="openRelatedCreate"
      @delete="deleteOpen = true"
    />
    <div v-else class="graph-document-empty" role="status">
      <p>{{ file.graph?.unavailable ? 'This entry is not available in the current graph.' : 'This entry cannot be shown in Details.' }}</p>
      <button type="button" @click="$emit('source')">Open Source</button>
    </div>
    <GraphCreateDialog
      :open="createOpen"
      :scopes="graph.scopes"
      :scope-ids="graph.activeScopeIds"
      :default-scope="graph.workspaceGraphScope"
      :initial-kind="createKind"
      :initial-status="createStatus"
      :saving="creating"
      :error="createError"
      :graph-revision="graph.status?.graphRevision || 0"
      @close="createOpen = false"
      @create="createNode"
    />
    <GraphConfirmDialog
      :open="deleteOpen"
      :title="`Move “${file.graph?.draft?.title || 'this entry'}” to Trash?`"
      copy="The entry leaves the graph. Links to it remain in the source and show as unavailable until it is restored."
      :busy="deleting"
      :error="error"
      @close="deleteOpen = false"
      @confirm="remove"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { graphDocumentViewState } from '../../graphDocumentViewState.js'
import { useFileStore } from '../../../stores/files.js'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import { useActivitiesStore } from '../../../stores/activities.js'
import { resolveProjectFile } from '../../../services/workspaceConfig.js'
import { graphNeighbors, graphSource } from '../../../services/businessGraph.js'
import GraphInspector from '../../../mimir/apps/business-graph/GraphInspector.vue'
import GraphCreateDialog from '../../../mimir/apps/business-graph/GraphCreateDialog.vue'
import GraphConfirmDialog from '../../../mimir/apps/business-graph/GraphConfirmDialog.vue'
import { useGraphMutations } from '../../../mimir/apps/business-graph/useGraphMutations.js'

const props = defineProps({ file: { type: Object, required: true } })
const emit = defineEmits(['source', 'closeRequest', 'openGraph', 'openFile', 'openUrl', 'openActivity', 'openMeeting', 'diagnostic'])
const viewState = graphDocumentViewState(props.file)
const files = useFileStore()
const graph = useBusinessGraphStore()
const activities = useActivitiesStore()
const inspector = ref(null)
const neighbors = ref([])
const error = ref('')
const deleteOpen = ref(false)
const deleting = ref(false)
let neighborsRequest = 0
const relatedActivities = computed(() => activities.activities.filter(activity => (
  activity.source?.graphNodeId === props.file.graph?.node?.id
)))

watch(() => [props.file.graph?.node?.id, graph.status?.graphRevision, graph.activeScopeIds.join('\0')], async () => {
  const request = ++neighborsRequest
  error.value = ''
  const id = props.file.graph?.node?.id
  neighbors.value = []
  if (!id || props.file.graph?.unavailable) return
  try {
    const result = await graphNeighbors(id, { scopeIds: graph.activeScopeIds })
    if (request === neighborsRequest) neighbors.value = Array.isArray(result) ? result : []
  } catch (cause) {
    if (request === neighborsRequest) error.value = String(cause?.message || cause)
  }
}, { immediate: true })

const { createOpen, createKind, createStatus, creating, createError, createNode, openRelatedCreate } = useGraphMutations({
  graph,
  boardIssues: computed(() => []),
  diagnostic: message => emit('diagnostic', message),
  echoToolCall: () => {},
  restoreGraphFocus: () => inspector.value?.focusEntry(),
  openNode: id => emit('openGraph', { id }),
})

async function undoClose() {
  error.value = ''
  try { await files.undoGraphClose(props.file) }
  catch (cause) { error.value = String(cause?.message || cause) }
}

async function save() {
  error.value = ''
  try { await files.save(props.file) } catch { /* The tab owns its save error. */ }
}

async function openFile(request) {
  const target = typeof request === 'string' ? { path: request } : request
  if (!target?.path) return
  if (target.path === props.file.path && !target.history) { emit('source'); return }
  if (target.path.startsWith('/') || target.path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(target.path)) {
    emit('openFile', target)
    return
  }
  const file = props.file
  const node = file.graph.node
  const draft = file.graph.draft
  const projectId = node.kind === 'project' ? node.id
    : draft.projectId || draft.relations.find(edge => edge.relation === 'part_of')?.target || ''
  try {
    const path = await resolveProjectFile({
      projectId,
      scopeId: node.provenance.scopeId,
      relativePath: target.path,
      fallbackWorkspace: graph.projectRoot,
    })
    if (!path) throw new Error(`${target.path} is not in a local folder for this entry.`)
    emit('openFile', { ...target, path })
  } catch (cause) { error.value = String(cause?.message || cause) }
}

async function remove() {
  if (deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    const file = props.file
    await files.waitForFile(file)
    if (file.graph?.unavailable) throw new Error('This entry is not available in the current graph.')
    if (file.dirty && !await files.save(file)) throw new Error('Save the entry before moving it to Trash.')
    const source = await graphSource(file.path)
    if (!source?.node || source.sourceRevision !== file.graph.sourceRevision) {
      throw new Error('The source changed. Your draft remains in this tab.')
    }
    await graph.remove(source.node.id, file.graph.sourceRevision, file.path)
    deleteOpen.value = false
    const index = files.openFiles.findIndex(candidate => candidate.id === file.id)
    if (index >= 0) files.closeFile(index)
  } catch (cause) { error.value = String(cause?.message || cause) }
  finally { deleting.value = false }
}

defineExpose({
  focus: () => inspector.value?.focusEntry(),
  revealReference: request => inspector.value?.revealReference(request),
})
</script>

<style scoped>
.graph-editor-tab { display: flex; flex-direction: column; flex: 1; width: 100%; min-width: 0; min-height: 0; font-family: var(--font-sans); }
.graph-document-empty { display: grid; align-content: start; gap: 12px; padding: 24px; color: var(--color-ink-3); font-size: 12px; }
.graph-document-empty button { justify-self: start; color: var(--color-accent); }
.graph-close-notice { display: flex; flex-shrink: 0; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--color-rule-light); color: var(--color-ink-3); font-size: 11px; }
.graph-close-notice button { color: var(--color-accent); }
.graph-close-notice button:disabled { opacity: 0.45; cursor: default; }
</style>
