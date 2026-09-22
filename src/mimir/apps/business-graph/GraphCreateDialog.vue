<template>
  <Teleport to="body">
    <div
      v-if="open"
      data-graph-create-dialog
      class="create-overlay"
      @click.self="draft.kind !== 'issue' && close()"
    >
      <form
        ref="dialog"
        :inert="discardOpen"
        class="create-dialog"
        :class="{ 'issue-composer': draft.kind === 'issue' }"
        :data-graph-completion-viewport="draft.kind === 'issue' ? '' : undefined"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-create-title"
        @submit.prevent="submit"
        @keydown.esc="onEscape"
        @keydown.tab="trapFocus"
        @keydown="onKeydown"
      >
        <header class="create-header">
          <div>
            <span v-if="draft.kind !== 'issue'">Add to the graph</span>
            <h2 id="graph-create-title">{{ draft.kind === 'issue' ? 'New issue' : `Create ${human(draft.kind)}` }}</h2>
          </div>
          <button
            type="button"
            data-graph-control="create-close"
            aria-label="Close create dialog"
            :disabled="saving"
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
          <div v-if="draft.kind !== 'issue'" class="create-routing">
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
            <span v-if="draft.kind !== 'issue'">Title</span>
            <textarea
              v-if="draft.kind === 'issue'"
              ref="titleInput"
              v-model="draft.title"
              data-create-title
              data-graph-control="create-title"
              aria-label="Issue title"
              placeholder="Issue title"
              rows="1"
              required
              :disabled="saving"
              @input="resizeTitle"
              @keydown.enter="onTitleEnter"
            />
            <input
              v-else
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

          <template v-if="draft.kind === 'issue'">
            <GraphMarkdownEditor
              ref="issueEditor"
              :show-tools="false"
              v-model="draft.body"
              data-create-body
              data-graph-control="create-working-note"
              class="issue-description"
              :min-height="72"
              :framed="false"
              :scope-ids="scopeIds"
              :graph-revision="graphRevision"
              :disabled="saving"
              control-id="create-working-note"
              aria-label="Issue description"
              placeholder="Add context, source links, or expected output…"
            />
            <div class="issue-properties">
              <GraphSelect v-model="draft.projectId" data-create-project variant="property"
                :aria-label="`Project: ${projectLabel}`" title="Change project"
                :options="timeProjects" :menu-min-width="260" searchable search-placeholder="Find a project" :disabled="saving">
                <template #trigger="{ option }"><span class="issue-value"><IconLayoutGrid :size="14" />{{ option?.label || 'No project' }}</span></template>
              </GraphSelect>
              <GraphSelect v-model="draft.status" data-create-status data-graph-control="create-status" variant="property"
                :aria-label="`Status: ${statusLabel}`" title="Change status" :options="statuses" :disabled="saving">
                <template #trigger="{ option }"><span class="issue-value"><IconCircleDashed :size="14" />{{ option?.label }}</span></template>
              </GraphSelect>
              <GraphSelect v-model="draft.personId" data-create-owner variant="property"
                :aria-label="`Owner: ${personLabel}`" title="Change owner"
                :options="timePeople" :menu-min-width="220" searchable search-placeholder="Find a person" :disabled="saving">
                <template #trigger="{ option }"><span class="issue-value"><IconUser :size="14" />{{ option?.value ? option.label : 'Assign' }}</span></template>
              </GraphSelect>
              <GraphSelect v-model="draft.priority" data-create-priority data-graph-control="create-priority" variant="property"
                :aria-label="`Priority: ${draft.priority}`" title="Change priority" :options="priorities" :disabled="saving">
                <template #trigger="{ option }"><span class="issue-value"><component :is="priorityIcons[draft.priority]" :size="14" :class="{ 'text-rem': draft.priority === 'urgent' }" />{{ option?.label }}</span></template>
              </GraphSelect>
              <GraphDatePicker v-model="draft.dueDate" data-create-due variant="quiet"
                :aria-label="`Due date: ${draft.dueDate || 'Not set'}`" title="Change due date" placeholder="Due date" :disabled="saving" />
              <button type="button" class="issue-more" data-graph-control="create-more" data-create-more :aria-expanded="issuePopover === 'options'" aria-haspopup="dialog"
                aria-label="More issue options" title="More issue options" :disabled="saving" @click="toggleIssuePopover('options', $event)"><IconDots :size="15" /></button>
            </div>
          </template>

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
            <label><span>Person</span><GraphSelect v-model="draft.personId" :options="timePeople" variant="property" aria-label="Time sheet person" searchable search-placeholder="Find a person" /></label>
            <label><span>Project</span><GraphSelect v-model="draft.projectId" :options="timeProjects" variant="property" aria-label="Time sheet project" searchable search-placeholder="Find a project" /></label>
          </div>

          <button
            type="button"
            v-if="draft.kind !== 'issue'"
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

          <div v-if="detailsOpen && draft.kind !== 'issue'" class="create-details">
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
                :disabled="saving"
                data-create-tags
                data-graph-control="create-tags"
                type="text"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder="heor, evidence, client"
              />
            </label>

            <div v-if="draft.kind !== 'issue'" class="create-note">
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
          <GraphSelect v-if="draft.kind === 'issue'" v-model="draft.scopeId" data-create-scope
            class="issue-storage" variant="quiet" :aria-label="`Save to: ${scopeOptions.find(option => option.value === draft.scopeId)?.label || 'Choose storage'}`"
            :options="scopeOptions" :disabled="saving">
            <template #trigger="{ option }"><span class="issue-value"><IconArchive :size="14" />Save to {{ option?.label || '…' }}</span></template>
          </GraphSelect>
          <button v-if="draft.kind === 'issue'" type="button" class="issue-more" data-graph-control="create-insert-link" data-graph-insert-link
            aria-label="Insert graph link" title="Insert graph link" aria-haspopup="dialog" :aria-expanded="issuePopover === 'link'" :disabled="saving" @mousedown.prevent @click="toggleIssuePopover('link', $event)"><IconLink :size="15" /></button>
          <GraphCheckbox
            v-if="draft.kind !== 'issue'"
            v-model="createAnother"
            data-create-another
            data-graph-control="create-another"
          >
            Create another
          </GraphCheckbox>
          <button
            type="button"
            v-if="draft.kind !== 'issue'"
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
            <span>{{ saving ? 'Creating…' : draft.kind === 'issue' ? 'Create' : `Create ${human(draft.kind)}` }}</span>
            <kbd v-if="!saving">{{ draft.kind === 'issue' ? '⌘ ↵' : '↵' }}</kbd>
          </button>
        </footer>
      </form>
    </div>
    <div v-if="open && discardOpen" class="discard-overlay" data-create-discard-confirmation>
      <section ref="discardDialog" class="discard-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="discard-issue-title" aria-describedby="discard-issue-copy" @keydown.tab="trapDiscardFocus">
        <h2 id="discard-issue-title">Discard this issue?</h2>
        <p id="discard-issue-copy">The text you entered has not been saved.</p>
        <div class="discard-actions">
          <button ref="keepEditingButton" type="button" data-graph-control="create-keep-editing" @click="keepEditing">Keep editing</button>
          <button type="button" data-graph-control="create-discard" @click="discardIssue">Discard issue</button>
        </div>
      </section>
    </div>
    <section v-if="open && issuePopover" ref="issuePopoverElement" data-modal-portal data-issue-popover
      class="issue-popover" :style="issuePopoverStyles" role="dialog"
      :aria-label="issuePopover === 'link' ? 'Insert graph link' : 'More issue options'"
      @keydown="onIssuePopoverKeydown">
      <template v-if="issuePopover === 'options'">
        <label class="issue-popover-label">Tags
          <input v-model="draft.tags" data-create-tags data-graph-control="create-tags"
            placeholder="Separate tags with commas" :disabled="saving" autocorrect="off" autocapitalize="off" spellcheck="false" />
        </label>
        <GraphCheckbox v-model="createAnother" data-create-another :disabled="saving">Create another</GraphCheckbox>
      </template>
      <template v-else>
        <label class="issue-popover-label">Link to an entry
          <input v-model="linkQuery" data-graph-control="create-link-search" type="search" placeholder="Find a note, project, or person…"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" @keydown.enter.prevent="chooseFirstLink" />
        </label>
        <p v-if="linkLoading || linkError || !linkResults.length" class="issue-link-status" role="status">{{ linkLoading ? 'Searching…' : linkError || 'No matching entries' }}</p>
        <button v-if="linkError" type="button" class="issue-link-result" data-graph-control="create-link-retry" @click="searchLinks">Try again</button>
        <div v-if="!linkLoading && !linkError" class="issue-link-results" aria-label="Matching entries">
          <button v-for="node in linkResults" :key="node.id" type="button" class="issue-link-result" data-graph-control="create-link-result"
            @click="chooseLink(node)"><span>{{ node.title }}</span><small>{{ human(node.kind) }}</small></button>
        </div>
      </template>
    </section>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { IconAlertTriangle, IconChevronDown, IconX, IconLayoutGrid, IconCircleDashed, IconUser, IconAntennaBars5, IconAntennaBars3, IconAntennaBars2, IconExclamationMark, IconArchive, IconDots, IconLink } from '@tabler/icons-vue'
import GraphCheckbox from './GraphCheckbox.vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphMarkdownEditor from './GraphMarkdownEditor.vue'
import GraphSelect from './GraphSelect.vue'
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/vue'
import { lookupGraph } from '../../../services/businessGraph.js'
import { defaultGraphWriteScope } from '../../../stores/businessGraphScopes.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
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
const issueEditor = ref(null)
const titleInput = ref(null)
const createAnother = ref(false)
const discardOpen = ref(false)
const discardDialog = ref(null)
const keepEditingButton = ref(null)
let discardReturnFocus = null
let forwardingMenuEscape = false
const detailsOpen = ref(false)
const issuePopover = ref('')
const issuePopoverTrigger = ref(null)
const issuePopoverElement = ref(null)
const linkQuery = ref('')
const linkResults = ref([])
const linkLoading = ref(false)
const linkError = ref('')
let linkRequest = 0
let linkSearchTimer
const { floatingStyles: issuePopoverStyles } = useFloating(issuePopoverTrigger, issuePopoverElement, {
  placement: 'top-start', strategy: 'fixed',
  middleware: [offset(6), flip(), shift({ padding: 8, crossAxis: true })],
  whileElementsMounted: autoUpdate,
})

async function toggleIssuePopover(kind, event) {
  if (issuePopover.value === kind) { closeIssuePopover(true); return }
  issuePopoverTrigger.value = event.currentTarget
  issuePopover.value = kind
  if (kind === 'link') { linkQuery.value = ''; void searchLinks() }
  await nextTick()
  issuePopoverElement.value?.querySelector('input')?.focus()
}

function closeIssuePopover(restoreFocus = false) {
  issuePopover.value = ''
  linkRequest += 1
  clearTimeout(linkSearchTimer)
  if (restoreFocus) issuePopoverTrigger.value?.focus()
}

async function searchLinks() {
  const request = ++linkRequest
  linkLoading.value = true
  linkError.value = ''
  try {
    const results = await lookupGraph(linkQuery.value, { scopeIds: props.scopeIds, limit: 12 })
    if (request === linkRequest && issuePopover.value === 'link') linkResults.value = results || []
  } catch {
    if (request === linkRequest) { linkResults.value = []; linkError.value = 'Link search failed.' }
  } finally {
    if (request === linkRequest) linkLoading.value = false
  }
}

watch(linkQuery, () => {
  clearTimeout(linkSearchTimer)
  linkRequest += 1
  linkLoading.value = true
  linkSearchTimer = setTimeout(() => { if (issuePopover.value === 'link') void searchLinks() }, 120)
})
watch(() => props.scopeIds.join('\0'), () => { if (issuePopover.value === 'link') void searchLinks() })

function chooseFirstLink(event) {
  if (event?.isComposing || event?.keyCode === 229) return
  if (!linkLoading.value && !linkError.value && linkResults.value.length) chooseLink(linkResults.value[0])
}
function chooseLink(node) {
  closeIssuePopover()
  issueEditor.value?.insertReference(node)
}
function onIssuePopoverKeydown(event) {
  if (!issuePopoverElement.value) return
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); closeIssuePopover(true); return
  }
  const items = [...issuePopoverElement.value.querySelectorAll('input, button:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && issuePopover.value === 'link') {
    event.preventDefault()
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length]?.focus()
  }
}
function dismissIssuePopover(event) {
  if (issuePopover.value && !issuePopoverElement.value?.contains(event.target) && !issuePopoverTrigger.value?.contains(event.target)) closeIssuePopover()
}
onMounted(() => document.addEventListener('pointerdown', dismissIssuePopover, true))
onUnmounted(() => {
  document.removeEventListener('pointerdown', dismissIssuePopover, true)
  closeIssuePopover()
})
watch(() => props.open, open => { if (!open) closeIssuePopover() })
watch(() => props.saving, saving => { if (saving) closeIssuePopover() })

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
const priorityIcons = Object.freeze({ urgent: IconExclamationMark, high: IconAntennaBars5, normal: IconAntennaBars3, low: IconAntennaBars2 })
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
const timeProjects = computed(() => {
  const projects = [...new Map([...props.nodes.filter(node => node.kind === 'project'), ...props.projects].map(node => [node.id, node])).values()]
  const options = [{ value: '', label: 'No project' }, ...projects.map(node => ({ value: node.id, label: node.title }))]
  if (draft.projectId && !projects.some(node => node.id === draft.projectId)) options.push({ value: draft.projectId, label: 'Unavailable project', disabled: true })
  return options
})
const projectLabel = computed(() => timeProjects.value.find(option => option.value === draft.projectId)?.label || 'No project')
const personLabel = computed(() => timePeople.value.find(option => option.value === draft.personId)?.label || 'Unassigned')
const statusLabel = computed(() => statuses.find(option => option.id === draft.status)?.label || draft.status)
const scopeOptions = computed(() => props.scopes.map(scope => ({
  value: scope.id,
  label: scopeName(scope.kind),
  hint: scopeHint(scope),
})))

let restoreFocusTo = null

watch(() => props.open, async open => {
  if (!open) {
    restoreDialogFocus()
    return
  }
  rememberDialogFocus()
  discardOpen.value = false
  Object.assign(draft, emptyDraft())
  detailsOpen.value = false
  await nextTick()
  resizeTitle()
  titleInput.value?.focus()
}, { immediate: true })

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
    personId: props.initialKind === 'timesheet' ? props.selfPersonId : '',
    dueDate: '',
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
  const properties = createProperties()
  emit('create', {
    kind: draft.kind,
    scopeId: draft.scopeId,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    body: draft.body,
    tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    properties,
    ...(['issue', 'timesheet'].includes(draft.kind) ? { relations: [
      ...(draft.projectId ? [{ relation: 'part_of', target: draft.projectId }] : []),
      ...(draft.personId ? [{ relation: 'assigned_to', target: draft.personId }] : []),
    ] } : {}),
  }, {
    another: createAnother.value,
    reset() {
      const { kind, scopeId, status, priority, projectId, personId } = draft
      Object.assign(draft, emptyDraft(), { kind, scopeId, status, priority, projectId, personId })
      detailsOpen.value = false
      closeIssuePopover()
      void nextTick(() => titleInput.value?.focus())
    },
  })
}

function createProperties() {
  if (draft.kind === 'timesheet') return { entries: [] }
  if (draft.kind === 'issue') {
    return { status: draft.status, priority: draft.priority, ...(draft.dueDate ? { dueDate: draft.dueDate } : {}) }
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
  if (props.saving) return
  if (draft.kind === 'issue' && [draft.title, draft.body, draft.tags].some(value => value.trim())) {
    discardReturnFocus = document.activeElement
    closeIssuePopover()
    discardOpen.value = true
    void nextTick(() => keepEditingButton.value?.focus())
    return
  }
  emit('close')
}

function keepEditing() {
  discardOpen.value = false
  void nextTick(() => {
    if (discardReturnFocus?.isConnected) discardReturnFocus.focus()
    else titleInput.value?.focus()
  })
}

function discardIssue() {
  discardOpen.value = false
  emit('close')
}

function trapDiscardFocus(event) {
  const buttons = [...discardDialog.value.querySelectorAll('button')]
  if (event.shiftKey && document.activeElement === buttons[0]) {
    event.preventDefault(); buttons.at(-1).focus()
  } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
    event.preventDefault(); buttons[0].focus()
  }
}

// Capture before CodeMirror's Mod-Enter/selection keymaps and the Workbench
// router. Teleported menus and WebKit's body focus are part of this modal.
function onIssueShortcut(event) {
  if (!props.open || draft.kind !== 'issue' || forwardingMenuEscape || event.isComposing || event.keyCode === 229) return
  const create = (event.key === 'Enter' || event.key === 'Return') && (event.metaKey || event.ctrlKey) && !event.altKey
  if (event.key !== 'Escape' && !create) return
  const modals = [...document.querySelectorAll('[aria-modal="true"]')]
  if (![dialog.value, discardDialog.value].includes(modals.at(-1))) return
  const consume = () => { event.preventDefault(); event.stopImmediatePropagation() }
  if (props.saving || event.repeat) { consume(); return }
  if (discardOpen.value) {
    consume()
    if (event.key === 'Escape') keepEditing()
    return
  }
  if (create) {
    consume()
    closeIssuePopover()
    submit()
    return
  }
  if (issuePopover.value) { consume(); closeIssuePopover(true); return }
  const menu = document.querySelector('[data-graph-select-menu], [data-graph-date-popover]')
  if (menu) {
    // Let the menu's own handler restore its trigger focus. Forward only when
    // WebKit left focus on the body or on a trigger outside the portal.
    if (menu.contains(event.target)) return
    consume()
    forwardingMenuEscape = true
    try { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }
    finally { forwardingMenuEscape = false }
    return
  }
  consume()
  if (issueEditor.value?.dismissCompletion()) return
  close()
}
onMounted(() => window.addEventListener('keydown', onIssueShortcut, true))
onUnmounted(() => window.removeEventListener('keydown', onIssueShortcut, true))

onMounted(() => window.addEventListener('resize', resizeTitle))
onUnmounted(() => window.removeEventListener('resize', resizeTitle))
watch(() => draft.title, () => nextTick(resizeTitle))

function resizeTitle() {
  if (titleInput.value?.tagName !== 'TEXTAREA') return
  titleInput.value.style.height = 'auto'
  titleInput.value.style.height = `${titleInput.value.scrollHeight}px`
}

function onTitleEnter(event) {
  if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey) return
  event.preventDefault()
  issueEditor.value?.focus()
}

function onKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (draft.kind === 'issue' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    event.stopPropagation()
    submit()
  }
}

function trapFocus(event) {
  const focusable = [...(dialog.value?.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])].filter(element => !element.closest('[hidden]'))
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
  return meaning
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

/* Issue creation uses one writing area and a compact property row. */
.create-overlay:has(.issue-composer) { background: transparent; }
.issue-composer { width: min(680px, 100%); border-radius: 3px; box-shadow: 0 4px 16px color-mix(in srgb, var(--color-ink) 10%, transparent); }
.issue-composer .create-header { min-height: 46px; padding: 6px 16px 6px 20px; border-bottom: 0; }
.issue-composer .create-header h2 { margin: 0; font-size: 12px; font-weight: 600; color: var(--color-ink-3); text-transform: none; }
.issue-composer .create-header > button { width: 28px; height: 28px; border-radius: 3px; }
.issue-composer .create-scroll { overflow-x: hidden; overscroll-behavior: contain; padding: 6px 20px 12px; }
.issue-composer .create-title-field { margin: 0 0 8px; }
.issue-composer .create-title-field textarea { display: block; width: 100%; resize: none; overflow: hidden; border: 0; background: transparent; padding: 2px 0 5px; color: var(--color-ink); font: 600 18px/1.45 var(--font-sans); }
.issue-composer .create-title-field textarea::placeholder { color: var(--color-ink-4); }
.issue-composer .create-title-field textarea:focus-visible { outline: none; box-shadow: inset 0 -1px color-mix(in srgb, var(--color-accent) 50%, var(--color-rule)); }
.issue-description { margin-bottom: 8px; }
/* The dialog body owns scrolling. CodeMirror's auto/visible overflow pair
   creates a second scroll container, including a native horizontal bar. */
.issue-description :deep(.cm-scroller) { min-width: 0; overflow: visible; }
.issue-description :deep(.cm-content) { min-width: 0; max-width: 100%; overflow-wrap: anywhere; padding-bottom: 8px; }
.issue-description :deep(.graph-note-tools) { margin-bottom: 4px; }
.issue-properties { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.issue-properties :deep(.graph-select-trigger), .issue-properties :deep(.date-picker-trigger) { min-height: 29px; max-width: 100%; padding: 0 8px; border: 1px solid var(--color-rule-light); background: var(--color-surface); font-size: 12px; font-weight: 500; }
.issue-properties :deep(.graph-select-trigger:hover), .issue-properties :deep(.date-picker-trigger:hover) { background: var(--color-chrome-mid); }
.issue-value { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-value svg { flex-shrink: 0; color: var(--color-ink-4); }
.issue-more { display: grid; place-items: center; min-width: 29px; min-height: 29px; color: var(--color-ink-3); }
.issue-more:hover { background: var(--color-chrome-mid); }
.issue-more:focus-visible { outline: 2px solid var(--color-accent); }
.issue-composer .create-footer { min-height: 49px; padding: 8px 18px; background: var(--color-surface); }
.issue-storage { min-width: 0; }
.issue-composer .create-submit { min-height: 32px; margin-left: auto; flex-shrink: 0; border-radius: 3px; font-size: 12px; }
.issue-composer .create-details { padding-top: 12px; }
.issue-composer .create-details .create-field { margin-top: 10px; }
@media (max-width: 560px) {
  .create-overlay:has(.issue-composer) { padding: 12px; }
  .issue-composer { height: auto; max-height: calc(100dvh - 24px); border: 1px solid var(--color-rule); }
  .issue-composer .create-scroll { padding-right: 16px; padding-left: 16px; }
  .issue-composer .create-title-field textarea { font-size: 17px; }
}

.issue-popover { position: fixed; z-index: 270; width: min(300px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto; padding: 12px; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); color: var(--color-ink); box-shadow: 0 4px 16px color-mix(in srgb, var(--color-ink) 10%, transparent); }
.issue-popover-label { display: block; font-size: 11px; font-weight: 550; color: var(--color-ink-3); }
.issue-popover-label input { display: block; width: 100%; margin: 6px 0 8px; border: 1px solid var(--color-rule); border-radius: 3px; padding: 6px 8px; color: var(--color-ink); background: var(--color-surface); font-size: 12px; font-weight: 400; }
.issue-popover-label input:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 1px; }
.issue-link-results { max-height: min(228px, calc(100dvh - 140px)); overflow: auto; }
.issue-link-result { display: flex; width: 100%; gap: 12px; align-items: center; justify-content: space-between; padding: 7px 5px; text-align: left; font-size: 12px; border-radius: 3px; }
.issue-link-result span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.issue-link-result small { flex-shrink: 0; color: var(--color-ink-4); font-size: 10px; }
.issue-link-result:hover, .issue-link-result:focus-visible { outline: none; background: var(--color-accent-soft); }
.issue-link-status { padding: 6px 0; color: var(--color-ink-3); font-size: 12px; }
.discard-overlay { position: fixed; inset: 0; z-index: 280; display: grid; place-items: center; padding: 16px; background: transparent; }
.discard-dialog { width: min(360px, 100%); padding: 20px; border: 1px solid var(--color-rule); border-radius: 3px; background: var(--color-surface); color: var(--color-ink); box-shadow: 0 4px 16px color-mix(in srgb, var(--color-ink) 10%, transparent); }
.discard-dialog h2 { font-size: 14px; font-weight: 600; }
.discard-dialog p { margin-top: 8px; color: var(--color-ink-3); font-size: 12px; }
.discard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.discard-actions button { padding: 6px 10px; border: 1px solid var(--color-rule); border-radius: 3px; font-size: 12px; }
.discard-actions button:hover { background: var(--color-chrome-mid); }
.discard-actions button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
.discard-actions button:last-child { color: var(--color-rem); }
</style>
