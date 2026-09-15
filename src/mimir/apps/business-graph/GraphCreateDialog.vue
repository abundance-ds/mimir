<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-graph-create-dialog
      class="create-overlay"
      @click.self="$emit('close')"
    >
      <form
        ref="dialog"
        class="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-create-title"
        @submit.prevent="submit"
        @keydown.esc="onEscape"
        @keydown.tab="trapFocus"
      >
        <header class="create-header">
          <div>
            <span>Add to the graph</span>
            <h2 id="graph-create-title">Create {{ human(draft.kind) }}</h2>
          </div>
          <button
            type="button"
            data-graph-control="create-close"
            aria-label="Close create dialog"
            @click="close"
          >
            <IconX :size="16" />
          </button>
        </header>

        <div v-if="error" data-graph-create-error role="alert" class="create-error">
          <IconAlertTriangle :size="15" />
          <span>{{ error }}</span>
        </div>

        <div class="create-scroll">
          <div class="create-routing">
            <label>
              <span>Kind</span>
              <GraphSelect
                v-model="draft.kind"
                data-create-kind
                data-graph-control="create-kind"
                variant="field"
                aria-label="Graph item kind"
                :options="kinds"
                :menu-min-width="280"
                searchable
                search-placeholder="Find an entity kind"
              />
            </label>
            <label>
              <span>Scope</span>
              <GraphSelect
                v-model="draft.scopeId"
                data-create-scope
                data-graph-control="create-scope"
                variant="field"
                aria-label="Physical graph scope"
                :options="scopeOptions"
                :menu-min-width="280"
              />
            </label>
          </div>

          <label class="create-title-field">
            <span>Title</span>
            <input
              ref="titleInput"
              v-model="draft.title"
              data-create-title
              data-graph-control="create-title"
              type="text"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              placeholder="What should the team recognize this as?"
              required
            />
          </label>

          <div v-if="draft.kind === 'issue'" class="create-issue-properties">
            <label>
              <span>Status</span>
              <GraphSelect
                v-model="draft.status"
                data-create-status
                data-graph-control="create-status"
                variant="property"
                aria-label="Initial issue status"
                :options="statuses"
              />
            </label>
            <label>
              <span>Priority</span>
              <GraphSelect
                v-model="draft.priority"
                data-create-priority
                data-graph-control="create-priority"
                variant="property"
                aria-label="Initial issue priority"
                :options="priorities"
              />
            </label>
          </div>

          <div v-else-if="draft.kind === 'project'" class="create-kind-properties">
            <label>
              <span>Type</span>
              <GraphSelect
                v-model="draft.projectType"
                data-create-project-type
                variant="property"
                aria-label="Project type"
                :options="projectTypes"
              />
            </label>
            <label>
              <span>Status</span>
              <GraphSelect
                v-model="draft.projectStatus"
                data-create-project-status
                variant="property"
                aria-label="Project status"
                :options="projectStatuses"
              />
            </label>
          </div>

          <div v-else-if="draft.kind === 'company'" class="create-kind-properties">
            <label>
              <span>Relationship</span>
              <GraphSelect
                v-model="draft.companyRole"
                data-create-company-role
                variant="property"
                aria-label="Company relationship"
                :options="companyRoles"
              />
            </label>
            <label>
              <span>Status</span>
              <GraphSelect
                v-model="draft.entityStatus"
                data-create-entity-status
                variant="property"
                aria-label="Company status"
                :options="entityStatuses"
              />
            </label>
          </div>

          <div v-else-if="draft.kind === 'person'" class="create-kind-properties">
            <label>
              <span>Status</span>
              <GraphSelect
                v-model="draft.entityStatus"
                data-create-entity-status
                variant="property"
                aria-label="Person status"
                :options="entityStatuses"
              />
            </label>
            <div class="create-team-member">
              <span>Assignment</span>
              <GraphCheckbox v-model="draft.teamMember" data-create-team-member>
                Team member
              </GraphCheckbox>
            </div>
          </div>

          <div v-if="draft.kind === 'timesheet'" class="create-kind-properties">
            <label><span>Month</span><input v-model="draft.period" data-graph-control="create-time-period" aria-label="Time sheet month" placeholder="YYYY-MM" maxlength="7" pattern="[0-9]{4}-(0[1-9]|1[0-2])" required /></label>
            <label><span>Person</span><GraphSelect v-model="draft.personId" :options="timePeople" variant="property" aria-label="Time sheet person" searchable search-placeholder="Find a person" /></label>
            <label><span>Project</span><GraphSelect v-model="draft.projectId" :options="timeProjects" variant="property" aria-label="Time sheet project" searchable search-placeholder="Find a project" /></label>
          </div>

          <button
            type="button"
            data-graph-control="create-toggle-context"
            class="create-context-toggle"
            :aria-expanded="detailsOpen"
            @click="detailsOpen = !detailsOpen"
          >
            <span>
              <strong>{{ detailsOpen ? 'Hide context' : 'Add context' }}</strong>
              <small>Summary, tags, and Markdown working note</small>
            </span>
            <IconChevronDown :size="15" :class="{ 'rotate-180': detailsOpen }" />
          </button>

          <div v-if="detailsOpen" class="create-details">
            <label v-if="draft.kind !== 'issue'" class="create-field">
              <span>Retrieval summary</span>
              <input
                v-model="draft.summary"
                data-create-summary
                data-graph-control="create-summary"
                type="text"
                autocorrect="off"
                autocapitalize="off"
                placeholder="One concise hint for people and agents"
              />
            </label>

            <label class="create-field">
              <span>Tags <small>comma separated</small></span>
              <input
                v-model="draft.tags"
                data-create-tags
                data-graph-control="create-tags"
                type="text"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="heor, evidence, client"
              />
            </label>

            <div class="create-note">
              <span>Working note <small>Markdown</small></span>
              <GraphMarkdownEditor
                v-model="draft.body"
                data-create-body
                data-graph-control="create-working-note"
                :min-height="210"
                :scope-ids="scopeIds"
                :graph-revision="graphRevision"
                :disabled="saving"
                control-id="create-working-note"
                aria-label="Initial working note in Markdown"
                placeholder="Add context, acceptance criteria, rationale, or notes…"
              />
            </div>
          </div>
        </div>

        <footer class="create-footer">
          <GraphCheckbox
            v-model="createAnother"
            data-create-another
            data-graph-control="create-another"
          >
            Create another
          </GraphCheckbox>
          <button
            type="button"
            data-graph-control="create-cancel"
            class="create-cancel"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-create-submit
            data-graph-control="create-submit"
            class="create-submit"
            :disabled="saving || !draft.title.trim() || !draft.scopeId"
          >
            <span>{{ saving ? 'Creating…' : `Create ${human(draft.kind)}` }}</span>
            <kbd v-if="!saving">↵</kbd>
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { IconAlertTriangle, IconChevronDown, IconX } from '@tabler/icons-vue'
import GraphCheckbox from './GraphCheckbox.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphSelect from './GraphSelect.vue'
import { defaultGraphWriteScope } from '../../../stores/businessGraphScopes.js'
import { localTimeDate, validPeriod } from './timesheet.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  initialProjectId: { type: String, default: '' },
  selfPersonId: { type: String, default: '' },
  scopeIds: { type: Array, default: () => [] },
  initialKind: { type: String, default: 'issue' },
  initialStatus: { type: String, default: 'backlog' },
  defaultScope: { type: String, default: 'team' },
  saving: { type: Boolean, default: false },
  graphRevision: { type: [Number, String], default: 0 },
  error: { type: String, default: '' },
})

const emit = defineEmits(['close', 'create'])
const dialog = ref(null)
const titleInput = ref(null)
const createAnother = ref(false)
const detailsOpen = ref(false)
const kinds = Object.freeze([
  { id: 'issue', label: 'Task', hint: 'Operational work and next actions' },
  { id: 'project', label: 'Project', hint: 'Client or internal delivery context' },
  { id: 'company', label: 'Company', hint: 'Client, partner, or organization' },
  { id: 'person', label: 'Person', hint: 'Team member, client, or collaborator' },
  { id: 'meeting', label: 'Meeting', hint: 'Durable meeting context and outcomes' },
  { id: 'timesheet', label: 'Time sheet', hint: 'Record work and prepare invoice totals' },
  { id: 'note', label: 'Knowledge note', hint: 'Reusable context and understanding' },
  { id: 'resource', label: 'Resource', hint: 'A useful source, asset, or reference' },
  { id: 'journal', label: 'Journal', hint: 'Chronological notes and daily logs' },
  { id: 'decision', label: 'Decision', hint: 'A durable choice and its rationale' },
  { id: 'record', label: 'Sensitive record', hint: 'Structured material that needs explicit handling' },
])
const statuses = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
])
const priorities = Object.freeze([
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
])
const projectTypes = Object.freeze([
  { id: '', label: 'Not set' },
  { id: 'client-engagement', label: 'Client engagement' },
  { id: 'product', label: 'Product' },
  { id: 'lead', label: 'Lead' },
  { id: 'grant', label: 'Grant' },
  { id: 'internal', label: 'Internal' },
])
const projectStatuses = Object.freeze([
  { id: 'warm-lead', label: 'Warm lead' },
  { id: 'planned', label: 'Planned' },
  { id: 'active', label: 'Active' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'completed', label: 'Completed' },
  { id: 'archived', label: 'Archived' },
])
const companyRoles = Object.freeze([
  { id: '', label: 'Not set' },
  { id: 'own', label: 'Our company' },
  { id: 'client', label: 'Client' },
  { id: 'prospect', label: 'Prospect' },
  { id: 'partner', label: 'Partner' },
  { id: 'vendor', label: 'Vendor' },
])
const entityStatuses = Object.freeze([
  { id: 'active', label: 'Active' },
  { id: 'former', label: 'Former' },
])
const draft = reactive(emptyDraft())
const timePeople = computed(() => [{ value: '', label: 'Unassigned' }, ...props.nodes.filter(node => node.kind === 'person').map(node => ({ value: node.id, label: node.title }))])
const timeProjects = computed(() => [{ value: '', label: 'No project' }, ...props.nodes.filter(node => node.kind === 'project').map(node => ({ value: node.id, label: node.title }))])
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: scopeName(scope.kind),
  hint: scopeHint(scope),
})))

watch(() => props.open, async open => {
  if (!open) {
    restoreDialogFocus()
    return
  }
  rememberDialogFocus()
  Object.assign(draft, emptyDraft())
  detailsOpen.value = false
  await nextTick()
  titleInput.value?.focus()
})

watch(() => props.initialKind, kind => {
  if (props.open && kinds.some(option => option.id === kind)) draft.kind = kind
})

watch(() => props.initialStatus, status => {
  if (props.open && statuses.some(option => option.id === status)) draft.status = status
})

watch(() => draft.kind, kind => {
  if (props.open) draft.scopeId = defaultScope(kind)
})

watch(() => props.scopes, applyDefaultScope, { immediate: true, deep: true })

function emptyDraft() {
  return {
    kind: props.initialKind || 'issue',
    scopeId: defaultScope(props.initialKind),
    title: '',
    summary: '',
    tags: '',
    body: '',
    status: props.initialStatus || 'backlog',
    priority: 'normal',
    projectType: '',
    projectStatus: 'planned',
    companyRole: '',
    entityStatus: 'active',
    teamMember: false,
    period: localTimeDate().slice(0, 7),
    personId: props.selfPersonId,
    projectId: props.initialProjectId,
  }
}

function applyDefaultScope() {
  if (!props.scopes.some(scope => scope.id === draft.scopeId)) {
    draft.scopeId = defaultScope()
  }
}

function defaultScope(kind = draft.kind) {
  return defaultGraphWriteScope(props.scopes, kind, props.defaultScope)
}

function submit() {
  if (!draft.title.trim() || !draft.scopeId || props.saving) return
  if (draft.kind === 'timesheet' && !validPeriod(draft.period)) return
  const properties = createProperties()
  emit('create', {
    kind: draft.kind,
    scopeId: draft.scopeId,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    body: draft.body,
    tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    properties,
    ...(draft.kind === 'timesheet' ? { relations: [
      ...(draft.projectId ? [{ relation: 'part_of', target: draft.projectId }] : []),
      ...(draft.personId ? [{ relation: 'assigned_to', target: draft.personId }] : []),
    ] } : {}),
  }, {
    another: createAnother.value,
    reset() {
      const { kind, scopeId, status, priority } = draft
      Object.assign(draft, emptyDraft(), { kind, scopeId, status, priority })
      detailsOpen.value = false
      void nextTick(() => titleInput.value?.focus())
    },
  })
}

function createProperties() {
  if (draft.kind === 'timesheet') return { period: draft.period, entries: [] }
  if (draft.kind === 'issue') {
    return { status: draft.status, priority: draft.priority }
  }
  if (draft.kind === 'project') {
    return {
      ...(draft.projectType ? { projectType: draft.projectType } : {}),
      projectStatus: draft.projectStatus,
    }
  }
  if (draft.kind === 'company') {
    return {
      ...(draft.companyRole ? { roles: [draft.companyRole] } : {}),
      status: draft.entityStatus,
    }
  }
  if (draft.kind === 'person') {
    return { status: draft.entityStatus, teamMember: draft.teamMember }
  }
  return {}
}

let restoreFocusTo = null

function rememberDialogFocus() {
  restoreFocusTo = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
}

function restoreDialogFocus() {
  const target = restoreFocusTo
  restoreFocusTo = null
  void nextTick(() => target?.isConnected && target.focus())
}

function onEscape(event) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  event.stopPropagation()
  close()
}

function close() {
  emit('close')
}

function trapFocus(event) {
  const focusable = [...(dialog.value?.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function scopeHint(scope) {
  const meaning = {
    private: 'Local to this device',
    project: 'Stored with this workspace',
    team: 'Shared across the team',
  }[scope.kind] || 'Graph source'
  return `${meaning} · ${scope.root}`
}

function human(value) {
  if (value === 'timesheet') return 'time sheet'
  return String(value || '').replaceAll('-', ' ')
}

function scopeName(value) {
  if (value === 'project') return 'Workspace'
  const label = human(value)
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : ''
}
</script>

<style scoped>
.create-overlay {
  position: fixed;
  z-index: 150;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-ink) 36%, transparent);
  padding: 18px;
}

.create-dialog {
  display: flex;
  width: min(590px, 100%);
  max-height: min(780px, calc(100vh - 36px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 16px 48px color-mix(in srgb, var(--color-ink) 22%, transparent);
}

.create-header {
  display: flex;
  min-height: 65px;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 10px 15px 10px 19px;
}

.create-header > div {
  min-width: 0;
  flex: 1 1 auto;
}

.create-header span {
  display: block;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.create-header h2 {
  margin-top: 3px;
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 670;
  letter-spacing: -0.018em;
  text-transform: capitalize;
}

.create-header > button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 5px;
  color: var(--color-ink-4);
}

.create-header > button:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.create-header > button:focus-visible,
.create-context-toggle:focus-visible,
.create-cancel:focus-visible,
.create-submit:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: 1px;
}

.create-scroll {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 20px;
}

.create-error {
  display: flex;
  min-height: 42px;
  flex: 0 0 auto;
  align-items: flex-start;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 25%, var(--color-rule));
  background: color-mix(in srgb, var(--color-rem) 5%, var(--color-surface));
  padding: 9px 18px;
  color: var(--color-rem);
  font-size: 11px;
  line-height: 1.45;
}

.create-error svg {
  flex: 0 0 auto;
}

.create-routing,
.create-issue-properties,
.create-kind-properties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.create-routing label > span,
.create-title-field > span,
.create-issue-properties label > span,
.create-kind-properties label > span,
.create-team-member > span,
.create-field > span,
.create-note > span {
  display: block;
  margin: 0 0 6px 2px;
  color: var(--color-ink-4);
  font-size: 10px;
  font-weight: 680;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.create-title-field {
  display: block;
  margin-top: 18px;
}

.create-title-field input {
  width: 100%;
  height: 45px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-chrome-high);
  padding: 0 13px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 570;
}

.create-title-field input::placeholder,
.create-field input::placeholder {
  color: var(--color-ink-4);
  font-weight: 400;
}

.create-title-field input:focus-visible,
.create-field input:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid color-mix(in srgb, var(--color-accent) 22%, transparent);
  outline-offset: 1px;
}

.create-issue-properties,
.create-kind-properties {
  margin-top: 14px;
}

.create-kind-properties {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.create-team-member :deep(.graph-checkbox-control) {
  min-height: 34px;
}

.create-context-toggle {
  display: flex;
  width: 100%;
  min-height: 54px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
  border-top: 1px solid var(--color-rule-light);
  border-bottom: 1px solid var(--color-rule-light);
  padding: 7px 5px;
  text-align: left;
}

.create-context-toggle strong,
.create-context-toggle small {
  display: block;
}

.create-context-toggle strong {
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 640;
}

.create-context-toggle small {
  margin-top: 3px;
  color: var(--color-ink-4);
  font-size: 9px;
}

.create-context-toggle svg {
  color: var(--color-ink-4);
  transition: transform 120ms ease;
}

.create-details {
  padding-top: 17px;
}

.create-field {
  display: block;
}

.create-field + .create-field,
.create-note {
  margin-top: 15px;
}

.create-field > span small,
.create-note > span small {
  margin-left: 5px;
  color: var(--color-ink-4);
  font-size: 9px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.create-field input {
  width: 100%;
  height: 38px;
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  background: var(--color-chrome-high);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 12px;
}

.create-footer {
  display: flex;
  min-height: 59px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
  padding: 9px 14px;
}

.create-cancel,
.create-submit {
  min-height: 35px;
  border-radius: 5px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 650;
}

.create-cancel {
  margin-left: auto;
  color: var(--color-ink-3);
}

.create-cancel:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.create-submit {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  background: var(--color-accent);
  color: var(--color-accent-ink, white);
}

.create-submit:hover {
  background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink));
}

.create-submit:disabled {
  cursor: default;
  opacity: 0.42;
  filter: none;
}

.create-submit kbd {
  font-family: var(--font-mono);
  font-size: 9px;
  opacity: 0.7;
}

@media (max-width: 560px) {
  .create-overlay {
    padding: 0;
  }

  .create-dialog {
    width: 100%;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
  }

  .create-routing,
  .create-issue-properties,
  .create-kind-properties {
    grid-template-columns: 1fr;
  }

  .create-footer :deep(.graph-checkbox-control) {
    font-size: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .create-context-toggle svg {
    transition: none;
  }
}
</style>
