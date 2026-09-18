<template>
  <main ref="root" class="graph-home" data-graph-home tabindex="-1">
    <div class="graph-home-page">
      <header class="graph-home-heading">
        <h1><GraphSelect :model-value="selectedId" :options="projectOptions" variant="quiet" searchable
          data-home-project data-graph-control="home-project" aria-label="Home project" :title="project?.title" placeholder="Choose a project"
          search-placeholder="Find a project" :menu-min-width="240" @update:model-value="graph.homeProjectId = $event" /></h1>
        <span v-if="project" class="graph-home-status">{{ statusLabel }}</span>
      </header>
      <p v-if="error" class="graph-home-message" role="status">{{ error }} <button data-graph-control="home-retry" type="button" @click="load">Retry</button></p>
      <p v-else-if="loading && !project" class="graph-home-message" role="status">Loading Project home…</p>
      <ProjectHome v-if="project" :key="project.id" :project="project" :model-value="project.body"
        :scope-ids="graph.activeScopeIds" :graph-revision="graph.status?.graphRevision || 0"
        @edit="$emit('openNode', project.id)" @open-node="$emit('openNode', $event)" @open-work="openWork"
        @open-file="openFile" @open-url="openUrl" />
      <div v-else-if="!loading && !error" class="graph-home-empty">
        <p>Choose a Project above to see its brief, resources, and work.</p>
        <button type="button" data-graph-control="home-link-workspace" @click="$emit('configureWorkspace')">Link a Project to this workspace</button>
      </div>
    </div>
  </main>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import { getGraphNode } from '../../../services/businessGraph.js'
import { resolveProjectFile } from '../../../services/workspaceConfig.js'
import { openExternalUrl } from '../../../services/externalLinks.js'
import GraphSelect from './GraphSelect.vue'
import ProjectHome from './ProjectHome.vue'

const props = defineProps({ active: { type: Boolean, default: true } })
const emit = defineEmits(['openNode', 'openFile', 'configureWorkspace'])
const graph = useBusinessGraphStore()
const root = ref(null), project = ref(null), loading = ref(false), error = ref('')
let generation = 0, loadedWorkspace = ''
const selectedId = computed(() => graph.homeProjectId || graph.workspaceProjectId)
const projectOptions = computed(() => {
  const entries = new Map(graph.projects.map(item => [item.id, item]))
  if (graph.workspaceProject) entries.set(graph.workspaceProject.id, graph.workspaceProject)
  return [...entries.values()].sort((a, b) => Number(b.id === graph.workspaceProjectId) - Number(a.id === graph.workspaceProjectId)
    || a.title.localeCompare(b.title)).map(item => ({ value: item.id, label: item.title,
    hint: item.id === graph.workspaceProjectId ? 'Current workspace' : '' }))
})
const statusLabel = computed(() => {
  const value = project.value?.properties?.projectStatus || project.value?.properties?.status || ''
  return value ? value[0].toUpperCase() + value.slice(1).replaceAll('-', ' ') : ''
})
async function load() {
  const request = ++generation, id = selectedId.value
  if (project.value?.id !== id || loadedWorkspace !== graph.projectRoot) { project.value = null; if (root.value) root.value.scrollTop = 0 }
  error.value = ''
  if (!props.active || !id || graph.loading) { loading.value = false; return }
  loading.value = true
  try {
    const node = await getGraphNode(id)
    if (request !== generation) return
    if (!node || node.kind !== 'project') throw new Error('This Project is unavailable. Choose another Project above.')
    project.value = node
    loadedWorkspace = graph.projectRoot
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : 'Project home could not be loaded.'
  } finally { if (request === generation) loading.value = false }
}
watch(() => [props.active, selectedId.value, graph.projectRoot, graph.loading, graph.status?.graphRevision], () => { void load() }, { immediate: true })
onUnmounted(() => { generation++ })
async function openWork() {
  const node = project.value, workspace = graph.projectRoot
  const current = () => props.active && selectedId.value === node.id && graph.projectRoot === workspace
  const scopeId = node?.provenance?.scopeId
  try {
    if (scopeId && graph.scopes.some(scope => scope.id === scopeId) && !graph.activeScopeIds.includes(scopeId)) await graph.toggleScope(scopeId)
    if (current()) graph.requestedProjectWork = node
  } catch (cause) { if (current()) error.value = String(cause?.message || cause) }
}
async function openFile(path) {
  const node = project.value, workspace = graph.projectRoot
  const current = () => props.active && selectedId.value === node.id && graph.projectRoot === workspace
  error.value = ''
  try {
    const resolved = path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path) ? path
      : await resolveProjectFile({ projectId: node.id, scopeId: node.provenance?.scopeId, relativePath: path, fallbackWorkspace: graph.projectRoot })
    if (!current()) return
    if (!resolved) throw new Error(`${path} is not in a local folder for this Project.`)
    emit('openFile', { path: resolved })
  } catch (cause) { if (current()) error.value = String(cause?.message || cause) }
}
async function openUrl(url) {
  try { await openExternalUrl(url) }
  catch (cause) { error.value = String(cause?.message || cause) }
}
defineExpose({
  focus: () => root.value?.querySelector('[data-home-project]')?.focus({ preventScroll: true }),
  focusSearch: () => root.value?.querySelector('[data-home-project]')?.click(),
})
</script>

<style scoped>
.graph-home { min-height: 0; flex: 1; overflow: auto; container: graph-document / inline-size; background: var(--graph-canvas); }
.graph-home-page { max-width: 1120px; margin: 0 auto; padding: 28px clamp(16px, 4%, 44px); }
.graph-home-heading { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.graph-home-heading h1 { min-width: 0; flex: 1; }
.graph-home-heading :deep([data-home-project]) { width: auto; max-width: 100%; min-height: 36px; padding-left: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.025em; }
.graph-home-status { flex: 0 0 auto; color: var(--color-ink-3); font-size: 11px; }
.graph-home-message, .graph-home-empty { color: var(--color-ink-3); font-size: 12px; line-height: 1.6; }
.graph-home-message { margin: 0 0 16px; }
.graph-home-message button, .graph-home-empty button { color: var(--color-accent); min-height: 28px; }
.graph-home button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
</style>
