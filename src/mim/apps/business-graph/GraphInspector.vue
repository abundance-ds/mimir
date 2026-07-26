<template>
  <aside
    v-if="node"
    data-graph-inspector
    class="graph-inspector flex min-h-0 flex-col border-l border-rule bg-surface"
    @keydown="onKeydown"
  >
    <header class="flex min-h-10 shrink-0 items-center gap-2 border-b border-rule-light px-2.5">
      <span class="grid size-6 shrink-0 place-items-center border border-rule-light bg-chrome-mid text-ink-3">
        <component :is="kindIcon" :size="12" :stroke-width="1.7" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-[7px] uppercase tracking-[0.11em] text-ink-4">
          {{ node.kind }} · {{ scopeLabel }}
        </div>
        <div class="truncate text-[10px] font-semibold text-ink-2">{{ node.id }}</div>
      </div>
      <button
        type="button"
        data-inspector-source
        class="grid size-7 place-items-center text-ink-4 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Open Markdown source"
        aria-label="Open Markdown source"
        @click="$emit('openFile', node.provenance?.sourcePath)"
      >
        <IconFileCode :size="13" />
      </button>
      <button
        type="button"
        data-inspector-close
        class="grid size-7 place-items-center text-ink-4 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Close inspector"
        aria-label="Close inspector"
        @click="$emit('close')"
      >
        <IconX :size="13" />
      </button>
    </header>

    <div
      v-if="conflict"
      data-graph-conflict
      role="alert"
      class="flex shrink-0 items-start gap-2 border-b border-rem/30 bg-rem/5 px-3 py-2 text-[9px] leading-relaxed text-rem"
    >
      <IconAlertTriangle :size="13" class="mt-px shrink-0" />
      <span class="min-w-0 flex-1">
        The Markdown source changed elsewhere. Mim reloaded it; review and apply your edit again.
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <section class="border-b border-rule-light p-3">
        <label class="field-label" for="graph-title">Title</label>
        <textarea
          id="graph-title"
          ref="titleInput"
          v-model="draft.title"
          data-inspector-title
          rows="2"
          class="title-input"
          @input="changed"
        />

        <div v-if="node.kind === 'issue'" class="mt-3 grid grid-cols-2 gap-2">
          <div class="min-w-0">
            <span class="field-label">Status</span>
            <GraphSelect
              :model-value="draft.status"
              data-inspector-status
              variant="field"
              aria-label="Issue status"
              :options="statuses"
              @update:model-value="updateDraft('status', $event)"
            />
          </div>
          <div class="min-w-0">
            <span class="field-label">Priority</span>
            <GraphSelect
              :model-value="draft.priority"
              data-inspector-priority
              variant="field"
              aria-label="Issue priority"
              :options="priorities"
              @update:model-value="updateDraft('priority', $event)"
            />
          </div>
          <label class="min-w-0">
            <span class="field-label">Due date</span>
            <input
              v-model="draft.dueDate"
              data-inspector-due
              type="date"
              class="property-input"
              @input="changed"
            />
          </label>
          <label class="min-w-0">
            <span class="field-label">Reminder</span>
            <input
              v-model="draft.remindAt"
              data-inspector-reminder
              type="datetime-local"
              class="property-input"
              @input="changed"
            />
          </label>
          <div class="min-w-0">
            <span class="field-label">Project</span>
            <GraphSelect
              :model-value="draft.projectId"
              data-inspector-project
              variant="field"
              aria-label="Issue project"
              placeholder="No project"
              :options="projectOptions"
              :menu-min-width="250"
              searchable
              search-placeholder="Find a project"
              @update:model-value="updateDraft('projectId', $event)"
            />
          </div>
          <div class="min-w-0">
            <span class="field-label">Assignee</span>
            <GraphSelect
              :model-value="draft.assigneeId"
              data-inspector-assignee
              variant="field"
              aria-label="Issue assignee"
              placeholder="Unassigned"
              :options="personOptions"
              :menu-min-width="250"
              searchable
              search-placeholder="Find a person"
              @update:model-value="updateDraft('assigneeId', $event)"
            />
          </div>
          <label class="min-w-0">
            <span class="field-label">Waiting for</span>
            <input
              v-model="draft.waitingFor"
              data-inspector-waiting
              class="property-input w-full"
              placeholder="External dependency"
              @input="changed"
            />
          </label>
          <label class="min-w-0">
            <span class="field-label">Snooze until</span>
            <input
              v-model="draft.snoozeUntil"
              data-inspector-snooze
              type="date"
              class="property-input w-full"
              @input="changed"
            />
          </label>
        </div>

        <label v-else class="mt-3 block">
          <span class="field-label">Retrieval summary</span>
          <textarea
            v-model="draft.summary"
            data-inspector-summary
            rows="2"
            class="summary-input"
            placeholder="A concise hint for people and agents"
            @input="changed"
          />
        </label>

        <div class="mt-3">
          <span class="field-label">Tags</span>
          <input
            v-model="draft.tags"
            data-inspector-tags
            class="property-input w-full"
            placeholder="heor, evidence, client"
            @input="changed"
          />
        </div>
        <template v-if="node.kind === 'issue'">
          <label class="mt-3 block">
            <span class="field-label">Labels</span>
            <input
              v-model="draft.labels"
              data-inspector-labels
              class="property-input w-full"
              placeholder="strategy, extraction, review"
              @input="changed"
            />
          </label>
          <label class="mt-3 block">
            <span class="field-label">Deliverables <span class="normal-case tracking-normal">one path per line</span></span>
            <textarea
              v-model="draft.deliverables"
              data-inspector-deliverables
              rows="3"
              class="summary-input font-mono"
              placeholder="outputs/evidence-map.xlsx | Evidence map"
              @input="changed"
            />
          </label>
        </template>
      </section>

      <section class="border-b border-rule-light p-3">
        <div class="mb-2 flex items-center">
          <span class="field-label mb-0">Working note</span>
          <span class="ml-auto font-mono text-[7px] text-ink-4">{{ draft.body.length }} chars</span>
          <button
            type="button"
            data-inspector-body-edit
            class="ml-2 h-5 border border-rule-light px-1.5 font-mono text-[7px] text-ink-3 hover:border-rule hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="toggleBodyEdit"
          >
            {{ editingBody ? 'Done' : 'Edit' }}
          </button>
        </div>
        <textarea
          v-if="editingBody"
          ref="bodyInput"
          v-model="draft.body"
          data-inspector-body
          class="body-input"
          rows="10"
          placeholder="Markdown body"
          @input="changed"
        />
        <div
          v-else
          data-inspector-body-preview
          class="body-preview"
        >
          {{ draft.body || 'No working note yet.' }}
        </div>
      </section>

      <section class="border-b border-rule-light p-3">
        <div class="mb-2 flex items-center">
          <span class="field-label mb-0">Related</span>
          <span class="ml-auto font-mono text-[7px] text-ink-4">{{ neighbors.length }}</span>
        </div>
        <div v-if="neighbors.length" class="space-y-1">
          <button
            v-for="neighbor in neighbors"
            :key="`${neighbor.direction}:${neighbor.relation}:${neighbor.node.id}`"
            type="button"
            :data-related-node="neighbor.node.id"
            class="group flex min-h-8 w-full items-center gap-2 border border-rule-light px-2 text-left hover:border-rule hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('openNode', neighbor.node.id)"
          >
            <span class="font-mono text-[7px] text-ink-4">
              {{ neighbor.direction === 'incoming' ? '←' : '→' }} {{ human(neighbor.relation) }}
            </span>
            <span class="min-w-0 flex-1 truncate text-[9px] font-medium text-ink-2">
              {{ neighbor.node.title || neighbor.node.id }}
            </span>
            <IconChevronRight :size="11" class="text-ink-4 group-hover:text-ink-2" />
          </button>
        </div>
        <p v-else class="border border-dashed border-rule-light px-3 py-4 text-center text-[9px] text-ink-4">
          No visible relationships yet.
        </p>
      </section>

      <section v-if="activities.length" class="border-b border-rule-light p-3">
        <div class="mb-2 flex items-center">
          <span class="field-label mb-0">Activities</span>
          <span class="ml-auto font-mono text-[7px] text-ink-4">{{ activities.length }}</span>
        </div>
        <button
          v-for="activity in activities"
          :key="activity.id"
          type="button"
          :data-related-activity="activity.id"
          class="mb-1 flex min-h-8 w-full items-center gap-2 border border-rule-light px-2 text-left hover:border-rule hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('openActivity', activity.id)"
        >
          <span class="size-1.5 rounded-full" :class="activityStatusClass(activity.status)" />
          <span class="min-w-0 flex-1 truncate text-[9px] font-medium text-ink-2">
            {{ activity.title }}
          </span>
          <span class="font-mono text-[7px] text-ink-4">{{ human(activity.status) }}</span>
        </button>
      </section>

      <section v-if="deliverableItems.length" class="border-b border-rule-light p-3">
        <div class="mb-2 flex items-center">
          <span class="field-label mb-0">Deliverables</span>
          <span class="ml-auto font-mono text-[7px] text-ink-4">{{ deliverableItems.length }}</span>
        </div>
        <button
          v-for="deliverable in deliverableItems"
          :key="deliverable.path"
          type="button"
          :data-deliverable-path="deliverable.path"
          class="mb-1 flex min-h-8 w-full items-center gap-2 border border-rule-light px-2 text-left hover:border-accent hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('openFile', deliverable.path)"
        >
          <IconFileCode :size="11" class="shrink-0 text-accent" />
          <span class="min-w-0 flex-1 truncate text-[9px] font-medium text-ink-2">
            {{ deliverable.label || deliverable.path }}
          </span>
          <span class="max-w-28 truncate font-mono text-[7px] text-ink-4">{{ deliverable.path }}</span>
        </button>
      </section>

      <section class="p-3">
        <span class="field-label">Source</span>
        <dl class="mt-2 grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[7px] leading-relaxed">
          <dt class="text-ink-4">scope</dt>
          <dd class="truncate text-ink-3">{{ node.provenance?.scopeId }}</dd>
          <dt class="text-ink-4">updated</dt>
          <dd class="truncate text-ink-3">{{ node.updatedAt || 'unknown' }}</dd>
          <dt class="text-ink-4">revision</dt>
          <dd class="truncate text-ink-3">{{ shortRevision }}</dd>
          <dt class="text-ink-4">path</dt>
          <dd class="break-all text-ink-3">{{ node.provenance?.sourcePath }}</dd>
        </dl>
      </section>
    </div>

    <footer class="flex h-11 shrink-0 items-center gap-2 border-t border-rule bg-chrome-high px-3">
      <button
        type="button"
        data-inspector-delete
        class="grid size-7 place-items-center text-ink-4 hover:bg-rem/10 hover:text-rem focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        title="Move to Trash"
        aria-label="Move to Trash"
        @click="$emit('delete', {
          id: node.id,
          expectedRevision: node.provenance?.sourceRevision,
          title: node.title,
        })"
      >
        <IconTrash :size="12" />
      </button>
      <button
        type="button"
        data-inspector-start-work
        class="flex h-7 items-center gap-1.5 border border-rule bg-surface px-2 text-[8px] font-semibold text-ink-2 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Start an agent Activity with bounded graph context"
        @click="$emit('startWork', node)"
      >
        <IconPlayerPlay :size="11" />
        Start work
      </button>
      <button
        v-if="node.kind === 'issue'"
        type="button"
        data-inspector-next-action
        class="flex h-7 items-center gap-1 border border-rule bg-surface px-2 text-[8px] font-semibold text-ink-2 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('quickCreate', { kind: 'issue', parent: node })"
      >
        <IconArrowForwardUp :size="11" />
        Next
      </button>
      <button
        v-else-if="node.kind === 'project'"
        type="button"
        data-inspector-record-decision
        class="flex h-7 items-center gap-1 border border-rule bg-surface px-2 text-[8px] font-semibold text-ink-2 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="$emit('quickCreate', { kind: 'decision', parent: node })"
      >
        <IconScale :size="11" />
        Decision
      </button>
      <span v-if="saving" class="text-[9px] text-ink-3">Saving…</span>
      <span v-else-if="saved" class="text-[9px] text-add">Saved</span>
      <span v-else-if="dirty" class="text-[9px] text-ink-3">Unsaved changes</span>
      <span v-else class="font-mono text-[7px] text-ink-4">⌘S to save</span>
      <button
        type="button"
        data-inspector-save
        class="ml-auto h-7 border border-accent bg-accent px-3 text-[9px] font-semibold text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        :disabled="!dirty || saving || !draft.title.trim()"
        @click="save"
      >
        Save
      </button>
    </footer>
  </aside>
</template>

<script setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconArrowForwardUp,
  IconBriefcase2,
  IconBuilding,
  IconChevronRight,
  IconCircleCheck,
  IconFileCode,
  IconFileText,
  IconPlayerPlay,
  IconScale,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  node: { type: Object, default: null },
  neighbors: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  conflict: { type: Object, default: null },
  saving: { type: Boolean, default: false },
  activities: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'close',
  'save',
  'openNode',
  'openFile',
  'openActivity',
  'quickCreate',
  'delete',
  'startWork',
])
const titleInput = ref(null)
const bodyInput = ref(null)
const dirty = ref(false)
const saved = ref(false)
const editingBody = ref(false)
let autosaveTimer = null
const draft = reactive({
  title: '',
  summary: '',
  body: '',
  tags: '',
  status: 'backlog',
  priority: 'normal',
  dueDate: '',
  remindAt: '',
  projectId: '',
  assigneeId: '',
  waitingFor: '',
  snoozeUntil: '',
  labels: '',
  deliverables: '',
})

const statuses = ['backlog', 'plan', 'in-progress', 'waiting', 'review', 'done', 'cancelled']
const priorities = ['low', 'normal', 'high', 'urgent']
const icons = {
  issue: IconCircleCheck,
  project: IconBriefcase2,
  person: IconUser,
  company: IconBuilding,
  decision: IconScale,
  default: IconFileText,
}
const kindIcon = computed(() => icons[props.node?.kind] || icons.default)
const scopeLabel = computed(() => (
  props.scopes.find(scope => scope.id === props.node?.provenance?.scopeId)?.kind || 'source'
))
const shortRevision = computed(() => (
  String(props.node?.provenance?.sourceRevision || '').slice(0, 12) || 'unknown'
))
const projects = computed(() => props.nodes.filter(node => node.kind === 'project'))
const people = computed(() => props.nodes.filter(node => node.kind === 'person'))
const projectOptions = computed(() => [
  { value: '', label: 'No project', hint: 'Remove project relation' },
  ...projects.value.map(project => ({
    value: project.id,
    label: project.title || project.id,
    hint: `${project.provenance?.scopeKind || 'project'} · ${project.id}`,
  })),
])
const personOptions = computed(() => [
  { value: '', label: 'Unassigned', hint: 'Remove assignee relation' },
  ...people.value.map(person => ({
    value: person.id,
    label: person.title || person.id,
    hint: `${person.provenance?.scopeKind || 'person'} · ${person.id}`,
  })),
])
const deliverableItems = computed(() => (
  (props.node?.properties?.deliverables || [])
    .map(item => (
      typeof item === 'string'
        ? { path: item, label: '' }
        : { path: item?.path || '', label: item?.label || '' }
    ))
    .filter(item => item.path)
))

watch(() => props.node, resetDraft, { immediate: true })

function resetDraft(node) {
  clearTimeout(autosaveTimer)
  if (!node) return
  draft.title = node.title || ''
  draft.summary = node.summary || ''
  draft.body = node.body || ''
  draft.tags = (node.tags || []).join(', ')
  draft.status = node.properties?.status || 'backlog'
  draft.priority = node.properties?.priority || 'normal'
  draft.dueDate = node.properties?.dueDate || ''
  draft.remindAt = localDateTime(node.properties?.remindAt)
  draft.projectId = relationTarget(node, 'part_of') || node.properties?.legacyProject || ''
  draft.assigneeId = relationTarget(node, 'assigned_to') || node.properties?.legacyAssignee || ''
  draft.waitingFor = node.properties?.waitingFor || ''
  draft.snoozeUntil = node.properties?.snoozeUntil || ''
  draft.labels = (node.properties?.labels || [])
    .map(label => typeof label === 'string' ? label : label.name)
    .filter(Boolean)
    .join(', ')
  draft.deliverables = (node.properties?.deliverables || [])
    .map(item => `${item.path}${item.label ? ` | ${item.label}` : ''}`)
    .join('\n')
  dirty.value = false
  saved.value = false
  editingBody.value = false
}

async function save() {
  clearTimeout(autosaveTimer)
  if (!dirty.value || props.saving || !draft.title.trim()) return
  const setProperties = {}
  const removeProperties = []
  if (props.node.kind === 'issue') {
    setProperties.status = draft.status
    setProperties.priority = draft.priority
    for (const [key, value] of [
      ['dueDate', draft.dueDate],
      ['remindAt', utcDateTime(draft.remindAt)],
      ['waitingFor', draft.waitingFor.trim()],
      ['snoozeUntil', draft.snoozeUntil],
      ['legacyProject', draft.projectId.trim()],
      ['legacyAssignee', draft.assigneeId.trim()],
    ]) {
      if (value) setProperties[key] = value
      else removeProperties.push(key)
    }
    const labels = draft.labels.split(',').map(label => label.trim()).filter(Boolean)
    setProperties.labels = labels.map(name => ({ name, color: labelColor(name) }))
    setProperties.deliverables = draft.deliverables
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [path, ...label] = line.split('|').map(value => value.trim())
        return { path, ...(label.join(' | ') ? { label: label.join(' | ') } : {}) }
      })
  }
  const relations = props.node.kind === 'issue'
    ? [
        ...(props.node.relations || []).filter(edge => !['part_of', 'assigned_to'].includes(edge.relation)),
        ...(draft.projectId.trim()
          ? [{ relation: 'part_of', target: draft.projectId.trim(), legacy: false }]
          : []),
        ...(draft.assigneeId.trim()
          ? [{ relation: 'assigned_to', target: draft.assigneeId.trim(), legacy: false }]
          : []),
      ]
    : undefined
  emit('save', {
    id: props.node.id,
    expectedRevision: props.node.provenance?.sourceRevision,
    title: draft.title.trim(),
    summary: props.node.kind === 'issue' ? undefined : draft.summary,
    body: draft.body,
    tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean),
    relations,
    setProperties,
    removeProperties,
  }, {
    done() {
      dirty.value = false
      saved.value = true
      setTimeout(() => { saved.value = false }, 1400)
    },
  })
}

function changed() {
  dirty.value = true
  saved.value = false
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(save, 900)
}

function updateDraft(field, value) {
  draft[field] = value
  changed()
}

function toggleBodyEdit() {
  editingBody.value = !editingBody.value
  if (!editingBody.value) {
    if (dirty.value) void save()
    return
  }
  requestAnimationFrame(() => bodyInput.value?.focus())
}

function relationTarget(node, relation) {
  return node.relations?.find(edge => edge.relation === relation)?.target || ''
}

function labelColor(name) {
  const colors = ['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange']
  let hash = 0
  for (const character of name.toLowerCase()) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return colors[Math.abs(hash) % colors.length]
}

function onKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    save()
  }
  if (event.key === 'Escape' && !dirty.value) emit('close')
}

function localDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function utcDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

function activityStatusClass(status) {
  if (['working', 'starting', 'ready'].includes(status)) return 'bg-accent'
  if (status === 'needs-input') return 'bg-rem'
  if (['done', 'idle'].includes(status)) return 'bg-add'
  return 'bg-ink-4'
}

onUnmounted(() => clearTimeout(autosaveTimer))
</script>

<style scoped>
.graph-inspector {
  width: min(360px, 92cqw);
}

.field-label {
  display: block;
  margin-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 7px;
  font-weight: 600;
  letter-spacing: 0.11em;
  color: var(--color-ink-4);
  text-transform: uppercase;
}

.title-input,
.summary-input,
.body-input,
.property-input {
  border: 1px solid var(--color-rule-light);
  border-radius: 0;
  background: var(--color-chrome-high);
  color: var(--color-ink-2);
}

.title-input {
  width: 100%;
  resize: none;
  padding: 7px 8px;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.35;
}

.summary-input {
  width: 100%;
  resize: vertical;
  padding: 6px 7px;
  font-size: 9px;
  line-height: 1.45;
}

.property-input {
  height: 27px;
  min-width: 0;
  padding: 0 6px;
  font-size: 9px;
}

.body-input {
  width: 100%;
  min-height: 176px;
  resize: vertical;
  padding: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.55;
}

.body-preview {
  min-height: 176px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.55;
  color: var(--color-ink-2);
}

.title-input:focus-visible,
.summary-input:focus-visible,
.body-input:focus-visible,
.property-input:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 0;
  border-color: var(--color-accent);
}

@container business-graph (max-width: 839px) {
  .graph-inspector {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 20;
    width: min(420px, 100%);
    box-shadow: -12px 0 28px color-mix(in srgb, var(--color-ink) 10%, transparent);
  }
}
</style>
