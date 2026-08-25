<template>
  <section class="font-sans text-ink" aria-label="Scope settings">
    <div>
      <h2 class="section-title mb-0">Information scopes</h2>
      <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
        Choose where graph data is stored.
      </p>
    </div>

    <div class="mt-5 divide-y divide-rule-light border-y border-rule-light">
      <div class="scope-row">
        <div class="scope-mark scope-private"><IconLock :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Private</div>
          <p class="scope-copy">Local graph, skills, and agents for this machine.</p>
          <p class="scope-components">{{ componentLabel('private') }}</p>
        </div>
        <code class="scope-path">~/.mimir/private</code>
      </div>

      <div class="scope-row">
        <div class="scope-mark scope-project"><IconFolder :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Workspace</div>
          <p class="scope-copy">Graph, skills, and agents that travel with the open repository.</p>
          <p class="scope-components">{{ componentLabel('project') }}</p>
        </div>
        <span class="scope-badge">automatic</span>
      </div>

      <div class="scope-row scope-row-team">
        <div class="scope-mark scope-team"><IconUsersGroup :size="13" /></div>
        <div class="min-w-0 flex-1">
          <div class="scope-title">Team</div>
          <p class="scope-copy">Optional Git folder for shared graph, skills, and agents.</p>
          <p class="scope-components">{{ componentLabel('team') }}</p>
          <div class="mt-3 flex min-w-0 items-center gap-1.5">
            <input
              v-model="teamRoot"
              data-graph-team-root
              class="scope-input"
              type="text"
              aria-label="Team folder"
              placeholder="/path/to/team"
              spellcheck="false"
              @change="save"
              @keydown.enter.prevent="save"
            />
            <button
              type="button"
              data-graph-team-choose
              class="scope-button"
              @click="choose"
            >
              <IconFolderOpen :size="13" />
              Choose
            </button>
            <button
              v-if="teamRoot"
              type="button"
              data-graph-team-clear
              class="scope-icon-button"
              title="Stop mounting the Team folder"
              aria-label="Stop mounting the Team folder"
              @click="clear"
            >
              <IconX :size="13" />
            </button>
          </div>
          <p class="mt-1.5 text-[9px] leading-relaxed text-ink-4">
            The folder can contain <code>graph/</code>, <code>skills/</code>, and <code>agents/</code>.
          </p>
        </div>
      </div>
    </div>

    <p v-if="notice" role="status" class="mt-3 text-[10px] text-add">{{ notice }}</p>
    <p v-if="error" role="alert" class="mt-3 text-[10px] text-rem">{{ error }}</p>

    <div v-if="teamRoot && currentWorkspace" class="workspace-settings">
      <div>
        <h2 class="section-title mb-0">Current workspace</h2>
        <p class="workspace-path" :title="currentWorkspace">{{ currentWorkspace }}</p>
      </div>

      <div class="workspace-setting-rows">
        <label class="workspace-setting-row">
          <span>
            <strong>Project</strong>
            <small>Business context for agents and new work</small>
          </span>
          <GraphSelect
            v-model="workspaceProject"
            data-current-workspace-project
            variant="field"
            aria-label="Current workspace Project"
            :options="projectOptions"
            :menu-min-width="300"
            searchable
            search-placeholder="Find a Project"
          />
        </label>

        <label v-if="workspaceProject === NEW_PROJECT" class="workspace-setting-row">
          <span>
            <strong>New Project name</strong>
            <small>Created in the Team graph</small>
          </span>
          <input
            v-model="newProjectTitle"
            data-current-workspace-new-project
            class="workspace-name-input"
            type="text"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            placeholder="Project name"
          />
        </label>

        <div class="workspace-setting-row">
          <span>
            <strong>Graph scope</strong>
            <small>Default location for new graph items</small>
          </span>
          <div class="workspace-scope-options" role="radiogroup" aria-label="Current workspace graph scope">
            <button
              v-for="option in workspaceScopeOptions"
              :key="option.value"
              type="button"
              role="radio"
              :aria-checked="workspaceScope === option.value"
              :data-current-workspace-scope="option.value"
              class="workspace-scope-option"
              :class="{ 'workspace-scope-option-active': workspaceScope === option.value }"
              @click="workspaceScope = option.value"
            >
              <span class="workspace-radio" aria-hidden="true"><i v-if="workspaceScope === option.value" /></span>
              {{ option.label }}
            </button>
          </div>
        </div>

      </div>

      <div class="workspace-settings-actions">
        <p>Graph scope affects new items. Existing nodes stay where they are.</p>
        <button
          type="button"
          data-current-workspace-save
          class="scope-button"
          :disabled="workspaceSaving || !workspaceDirty || (workspaceProject === NEW_PROJECT && !newProjectTitle.trim())"
          @click="saveCurrentWorkspace"
        >
          {{ workspaceSaving ? 'Saving…' : 'Save changes' }}
        </button>
      </div>
      <p v-if="workspaceNotice" role="status" class="mt-2 text-[10px] text-add">{{ workspaceNotice }}</p>
      <p v-if="workspaceError" role="alert" class="mt-2 text-[10px] text-rem">{{ workspaceError }}</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  IconFolder,
  IconFolderOpen,
  IconLock,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-vue'
import { useSettingsStore } from '../../../stores/settings.js'
import { useBusinessGraphStore } from '../../../stores/businessGraph.js'
import {
  createGraphNode,
  queryGraph,
} from '../../../services/businessGraph.js'
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../../../services/workspaceConfig.js'
import GraphSelect from '../../../mimir/apps/business-graph/GraphSelect.vue'

const NEW_PROJECT = '__new_project__'

const settings = useSettingsStore()
const graph = useBusinessGraphStore()
const teamRoot = ref(settings.mimirTeamFolder || '')
const inventory = ref([])
const notice = ref('')
const error = ref('')
const workspaceConfig = ref(null)
const workspaceProject = ref('')
const workspaceScope = ref('team')
const newProjectTitle = ref('')
const projects = ref([])
const workspaceSaving = ref(false)
const workspaceNotice = ref('')
const workspaceError = ref('')
const currentWorkspace = computed(() => String(settings.mimirWorkspaceFolder || '').trim())
const projectOptions = computed(() => [
  { value: '', label: 'None' },
  { value: NEW_PROJECT, label: 'New Project…', separatorAfter: projects.value.length > 0 },
  ...[...projects.value].sort(compareProjects).map(project => ({
    value: project.id,
    label: project.title || project.id,
  })),
])
const workspaceScopeOptions = Object.freeze([
  { value: 'team', label: 'Team' },
  { value: 'workspace', label: 'Workspace' },
])
const workspaceDirty = computed(() => (
  workspaceProject.value === NEW_PROJECT
  || workspaceProject.value !== String(workspaceConfig.value?.project || '')
  || workspaceScope.value !== (workspaceConfig.value?.graphScope || 'team')
))

watch(() => settings.mimirTeamFolder, (value) => {
  if (String(value || '') !== teamRoot.value) teamRoot.value = String(value || '')
})

watch(currentWorkspace, () => void loadCurrentWorkspace())

async function save() {
  const path = teamRoot.value.trim()
  teamRoot.value = path
  settings.set('mimirTeamFolder', path)
  error.value = ''
  notice.value = path
    ? 'Team folder saved. Graph, skills, and agents now compose automatically.'
    : 'Team folder disabled. Private and Workspace remain available.'
  if (!await settings.flush()) {
    notice.value = ''
    error.value = 'Could not save the Team folder.'
    return
  }
  await refreshInventory()
  await loadCurrentWorkspace()
}

async function choose() {
  error.value = ''
  try {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Choose Team folder',
    })
    const path = Array.isArray(selection) ? selection[0] : selection
    if (!path) return
    teamRoot.value = typeof path === 'string' ? path : path.path
    await save()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function clear() {
  teamRoot.value = ''
  void save()
}

function componentLabel(scope) {
  const entry = inventory.value.find(item => item.scope === scope)
  if (!entry?.mounted) return scope === 'team' ? 'not mounted' : 'empty'
  return entry.components?.length ? entry.components.join(' · ') : 'empty'
}

async function refreshInventory() {
  try {
    const value = await invoke('scope_inventory', {
      workspace: settings.mimirWorkspaceFolder || '.',
    })
    inventory.value = Array.isArray(value) ? value : []
  } catch { /* inventory is informative; the saved path remains authoritative */ }
}

async function loadCurrentWorkspace() {
  workspaceNotice.value = ''
  workspaceError.value = ''
  newProjectTitle.value = ''
  if (!currentWorkspace.value || !teamRoot.value) {
    workspaceConfig.value = null
    projects.value = []
    return
  }
  try {
    const [config, result] = await Promise.all([
      loadWorkspaceConfig(currentWorkspace.value),
      queryGraph({ kinds: ['project'], limit: 500 }),
    ])
    workspaceConfig.value = config || { project: '', graphScope: 'team' }
    workspaceProject.value = String(config?.project || '')
    workspaceScope.value = config?.graphScope === 'workspace' ? 'workspace' : 'team'
    projects.value = Array.isArray(result?.items) ? result.items : []
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function saveCurrentWorkspace() {
  if (!workspaceDirty.value || workspaceSaving.value) return
  workspaceSaving.value = true
  workspaceNotice.value = ''
  workspaceError.value = ''
  try {
    let project = workspaceProject.value === NEW_PROJECT ? '' : workspaceProject.value
    if (workspaceProject.value === NEW_PROJECT) {
      const created = await createGraphNode({
        kind: 'project',
        title: newProjectTitle.value.trim(),
        scopeId: 'team:main',
        properties: { projectStatus: 'planned' },
      })
      project = created.id
    }
    const saved = await saveWorkspaceConfig(currentWorkspace.value, {
      id: workspaceConfig.value?.id,
      project,
      graphScope: workspaceScope.value,
    })
    workspaceConfig.value = saved
    workspaceProject.value = String(saved.project || '')
    workspaceScope.value = saved.graphScope
    newProjectTitle.value = ''
    graph.setWorkspaceConfiguration(saved)
    workspaceNotice.value = 'Workspace settings saved.'
    await loadCurrentWorkspaceProjects()
  } catch (cause) {
    workspaceError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    workspaceSaving.value = false
  }
}

async function loadCurrentWorkspaceProjects() {
  const result = await queryGraph({ kinds: ['project'], limit: 500 })
  projects.value = Array.isArray(result?.items) ? result.items : []
}

function compareProjects(left, right) {
  return String(left.title || left.id).localeCompare(
    String(right.title || right.id),
    undefined,
    { sensitivity: 'base' },
  )
}

onMounted(() => {
  void refreshInventory()
  void loadCurrentWorkspace()
})
</script>

<style scoped>
.scope-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 0;
}

.scope-row-team {
  padding-bottom: 14px;
}

.scope-mark {
  display: grid;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 5px;
}

.scope-private {
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
}

.scope-project {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.scope-team {
  color: var(--color-add);
  background: color-mix(in srgb, var(--color-add) 9%, transparent);
}

.scope-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-ink-2);
}

.scope-copy {
  margin-top: 2px;
  font-size: 9.5px;
  line-height: 1.45;
  color: var(--color-ink-3);
}

.scope-components {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 8px;
  color: var(--color-ink-4);
}

.scope-path {
  max-width: 160px;
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 8.5px;
  color: var(--color-ink-4);
  white-space: nowrap;
}

.scope-badge {
  flex: 0 0 auto;
  border: 1px solid var(--color-rule-light);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 8px;
  color: var(--color-ink-3);
}

.scope-input {
  min-width: 0;
  height: 28px;
  flex: 1 1 auto;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-surface);
  padding: 0 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-2);
}

.scope-input:focus-visible,
.scope-button:focus-visible,
.scope-icon-button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

.scope-button {
  display: inline-flex;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: var(--color-chrome-mid);
  padding: 0 8px;
  font-size: 9px;
  color: var(--color-ink-2);
}

.scope-button:hover,
.scope-icon-button:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.scope-icon-button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 4px;
  color: var(--color-ink-3);
}

.workspace-settings {
  margin-top: 28px;
}

.workspace-path {
  margin-top: 3px;
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 8.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-setting-rows {
  margin-top: 12px;
  border-block: 1px solid var(--color-rule-light);
}

.workspace-setting-row {
  display: grid;
  min-height: 58px;
  grid-template-columns: minmax(0, 1fr) 220px;
  align-items: center;
  gap: 16px;
  border-bottom: 1px solid var(--color-rule-light);
}

.workspace-setting-row:last-child {
  border-bottom: 0;
}

.workspace-setting-row strong {
  display: block;
  color: var(--color-ink-2);
  font-size: 10.5px;
  font-weight: 600;
}

.workspace-setting-row small {
  display: block;
  margin-top: 2px;
  color: var(--color-ink-3);
  font-size: 9px;
}

.workspace-name-input {
  height: 30px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink);
  font-size: 10px;
  outline: none;
}

.workspace-name-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}

.workspace-scope-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
}

.workspace-scope-option {
  display: flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  color: var(--color-ink-3);
  font-size: 9.5px;
}

.workspace-scope-option + .workspace-scope-option {
  border-left: 1px solid var(--color-rule);
}

.workspace-scope-option:hover,
.workspace-scope-option:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.workspace-scope-option-active {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}

.workspace-radio {
  display: grid;
  width: 10px;
  height: 10px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.workspace-radio i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent);
}

.workspace-settings-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 9px;
}

.workspace-settings-actions p {
  color: var(--color-ink-4);
  font-size: 8.5px;
  line-height: 1.35;
}

.workspace-settings-actions .scope-button:disabled {
  opacity: 0.45;
}
</style>
