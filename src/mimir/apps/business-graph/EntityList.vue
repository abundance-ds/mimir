<template>
  <div class="entity-list-shell">
    <div
      ref="listbox"
      data-graph-entity-list
      class="entity-list"
      :class="{ 'entity-list-work': work }"
      tabindex="0"
      role="listbox"
      aria-label="Graph items"
      :aria-activedescendant="selectedNode ? `graph-list-option-${selectedNode.id}` : undefined"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="openSelected"
    >
      <template v-for="group in groups" :key="group.id">
        <div
          v-if="group.label"
          class="entity-group"
          role="presentation"
          :data-graph-group="group.id"
        >
          <span class="entity-group-name">{{ group.label }}</span>
          <span class="entity-group-count">{{ group.items.length }}</span>
        </div>

        <button
          v-for="node in group.items"
          :id="`graph-list-option-${node.id}`"
          :key="node.id"
          type="button"
          :data-graph-node="node.id"
          :data-graph-control="`list-open-${node.id}`"
          role="option"
          tabindex="-1"
          :aria-selected="indexOf(node.id) === selection"
          :aria-label="work ? workRowLabel(node) : undefined"
          class="entity-row"
          :class="{
            'entity-row-selected': indexOf(node.id) === selection,
            'entity-row-work': work,
            'entity-row-no-project': work && hideProject,
          }"
          @mouseenter="selectIndex(indexOf(node.id))"
          @mousedown.prevent="focusRow(indexOf(node.id))"
          @click="openAt(indexOf(node.id))"
        >
          <template v-if="work">
            <span
              class="work-priority"
              :class="`priority-${node.priority || 'normal'}`"
              aria-hidden="true"
            >
              <component
                :is="priorityIcon(node.priority)"
                :size="14"
                :stroke-width="node.priority === 'urgent' ? 2.6 : 2.2"
              />
            </span>
            <span class="work-title">
              <span class="work-title-text">{{ node.title || 'Untitled issue' }}</span>
              <span v-if="waitingReason(node)" class="work-waiting">
                <span class="work-key">waiting for</span> {{ waitingReason(node) }}
              </span>
            </span>
            <span v-if="!hideProject" class="work-project" :title="projectLabel(node)">
              {{ projectLabel(node) }}
            </span>
            <span
              class="work-assignee"
              :class="{ 'work-assignee-self': assignee(node)?.self }"
              :title="assignee(node) ? (assignee(node).self ? 'Assigned to you' : `Assigned to ${assignee(node).name}`) : undefined"
            >
              {{ assignee(node)?.label || '' }}
            </span>
            <span class="work-due" :class="`due-${due(node).state}`">{{ due(node).label }}</span>
          </template>

          <span v-else class="entity-content">
            <span class="entity-line-1">
              <span class="entity-kind">{{ human(node.kind) }}</span>
              <component
                :is="priorityIcon(node.priority)"
                v-if="node.kind === 'issue'"
                :size="14"
                :stroke-width="2.1"
                class="entity-priority"
                :class="`priority-${node.priority || 'normal'}`"
                aria-hidden="true"
              />
              <strong>{{ node.title || node.id }}</strong>
            </span>
            <span class="entity-line-2">
              <template v-if="node.kind === 'issue'">
                <span class="entity-status" :class="stateClass(node.status)">
                  {{ human(node.status || 'backlog') }}
                </span>
                <span v-if="projectLabel(node)" class="entity-project">{{ projectLabel(node) }}</span>
                <span v-if="due(node).label" class="entity-due" :class="`due-${due(node).state}`">
                  {{ due(node).label }}
                </span>
                <span v-if="waitingReason(node)" class="entity-waiting">
                  waiting for {{ waitingReason(node) }}
                </span>
                <span
                  v-if="assignee(node)"
                  class="entity-author"
                  :class="{ 'entity-author-self': assignee(node).self }"
                  :title="assignee(node).name"
                >
                  {{ assignee(node).label }}
                </span>
              </template>
              <template v-else>
                <span v-if="node.summary" class="entity-summary">{{ node.summary }}</span>
                <span class="entity-updated">{{ shortDate(node.updatedAt) }}</span>
              </template>
            </span>
          </span>
        </button>
      </template>

      <div v-if="!rows.length" class="entity-empty">
        <h2>{{ emptyTitle }}</h2>
        <p>{{ emptyCopy }}</p>
        <button
          type="button"
          data-graph-control="list-empty-create"
          @click="$emit('create')"
        >
          Create an item
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  IconAntennaBars3,
  IconAntennaBars5,
  IconArrowNarrowDown,
  IconExclamationMark,
} from '@tabler/icons-vue'
import {
  assigneeDisplay,
  dueInfo,
  groupWorkRows,
  waitingReason,
} from './workRow.js'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  /** Nodes used to resolve projects and people; defaults to `nodes`. */
  lookup: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  scopes: { type: Array, default: () => [] },
  /** `work` renders one aligned issue row per line; `generic` keeps kind + summary rows. */
  mode: {
    type: String,
    default: 'generic',
    validator: value => ['generic', 'work'].includes(value),
  },
  /** Work grouping: `status`, `project`, or empty for a flat list. */
  groupBy: { type: String, default: '' },
  selfId: { type: String, default: '' },
  hideProject: { type: Boolean, default: false },
  emptyTitle: { type: String, default: 'Nothing here yet' },
  emptyCopy: { type: String, default: 'Create an item or choose another scope.' },
})

const emit = defineEmits(['open', 'create'])
const listbox = ref(null)
const selection = ref(0)
const selectedId = ref('')
const work = computed(() => props.mode === 'work')
const groups = computed(() => {
  if (work.value && props.groupBy) {
    return groupWorkRows(props.nodes, { groupBy: props.groupBy, projects: props.projects })
  }
  return [{ id: 'all', label: '', items: props.nodes }]
})
const rows = computed(() => groups.value.flatMap(group => group.items))
const rowIndex = computed(() => new Map(rows.value.map((node, index) => [node.id, index])))
const selectedNode = computed(() => rows.value[selection.value] || null)
const byId = computed(() => new Map(
  (props.lookup.length ? props.lookup : props.nodes).map(node => [node.id, node]),
))

watch(
  () => rows.value.map(node => node.id),
  ids => {
    const preservedIndex = ids.indexOf(selectedId.value)
    const index = preservedIndex >= 0
      ? preservedIndex
      : Math.min(selection.value, Math.max(0, ids.length - 1))
    selection.value = index
    selectedId.value = ids[index] || ''
  },
  { immediate: true },
)

function indexOf(id) {
  return rowIndex.value.get(id) ?? -1
}

function move(delta) {
  if (!rows.value.length) return
  const next = Math.max(0, Math.min(rows.value.length - 1, selection.value + delta))
  if (next === selection.value) return
  selectIndex(next, { reveal: true })
}

function openSelected() {
  const node = selectedNode.value
  if (node) emit('open', node.id)
}

function focusEdge(edge = 'first') {
  if (!rows.value.length) return
  selectIndex(edge === 'last' ? rows.value.length - 1 : 0, { reveal: true })
  listbox.value?.focus()
}

function focusNode(id) {
  const index = indexOf(id)
  if (index < 0) return false
  selectIndex(index, { reveal: true })
  listbox.value?.focus()
  return true
}

function selectIndex(index, { reveal = false } = {}) {
  if (!rows.value.length) {
    selection.value = 0
    selectedId.value = ''
    return
  }
  const next = Math.max(0, Math.min(rows.value.length - 1, index))
  selection.value = next
  selectedId.value = rows.value[next]?.id || ''
  if (reveal) revealSelection()
}

function focusRow(index) {
  selectIndex(index)
  listbox.value?.focus()
}

function openAt(index) {
  selectIndex(index)
  const node = rows.value[index]
  if (node) emit('open', node.id)
}

function revealSelection() {
  void nextTick(() => {
    const row = listbox.value?.querySelector('[role="option"][aria-selected="true"]')
    row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
}

function priorityIcon(priority = 'normal') {
  return {
    urgent: IconExclamationMark,
    high: IconAntennaBars5,
    normal: IconAntennaBars3,
    low: IconArrowNarrowDown,
  }[priority] || IconAntennaBars3
}

function projectLabel(node) {
  if (!node.projectId) return ''
  const project = byId.value.get(node.projectId)
  return project?.kind === 'project'
    ? project.title || project.slug || project.properties?.slug || 'Untitled project'
    : ''
}

function assignee(node) {
  return assigneeDisplay(node, { byId: byId.value, selfId: props.selfId })
}

function due(node) {
  return dueInfo(node.dueDate)
}

function workRowLabel(node) {
  const owner = assignee(node)
  const reason = waitingReason(node)
  return [
    node.title || 'Untitled issue',
    `${human(node.priority || 'normal')} priority`,
    human(node.status || 'backlog'),
    projectLabel(node),
    due(node).label,
    reason ? `waiting for ${reason}` : '',
    owner ? (owner.self ? 'assigned to you' : `assigned to ${owner.name}`) : '',
  ].filter(Boolean).join('. ')
}

function shortDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}.${month}`
}

function stateClass(status) {
  return status === 'waiting' ? 'state-waiting' : ''
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

defineExpose({ focusEdge, focusNode })
</script>

<style scoped>
.entity-list-shell {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.entity-list {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  outline: none;
}

.entity-list:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 22%, transparent);
}

/* Group headers stay visible while their rows scroll beneath them. */
.entity-group {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-chrome-mid);
  padding: 0 14px;
}

.entity-group-name {
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.005em;
}

.entity-group-count {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.entity-row {
  display: flex;
  width: 100%;
  min-height: 46px;
  align-items: center;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 4px 14px;
  text-align: left;
}

.entity-row:hover {
  background: var(--color-chrome-mid);
}

.entity-row:focus-visible {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--color-accent) 26%, transparent);
  outline-offset: -2px;
}

.entity-row-selected {
  background: var(--color-accent-soft);
}

.entity-row-selected:hover {
  background: color-mix(in srgb, var(--color-accent-soft) 78%, var(--color-chrome-mid));
}

/* Work rows: one line, aligned columns — priority · title · project · owner · due. */
.entity-row-work {
  display: grid;
  min-height: 34px;
  grid-template-columns: 22px minmax(0, 1fr) minmax(0, 150px) 36px 96px;
  align-items: center;
  column-gap: 10px;
  padding: 0 14px 0 10px;
  color: var(--color-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.entity-row-no-project {
  grid-template-columns: 22px minmax(0, 1fr) 36px 96px;
}

.work-priority {
  display: grid;
  place-items: center;
  color: var(--color-ink-4);
}

.work-priority.priority-high {
  color: var(--color-ink);
}

.work-priority.priority-urgent {
  color: var(--color-rem);
}

.work-title {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
}

.work-title-text {
  overflow: hidden;
  flex: 0 1 auto;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
}

.work-waiting {
  overflow: hidden;
  flex: 0 1 auto;
  color: var(--color-ink-2);
  font-weight: 560;
  text-overflow: ellipsis;
}

.work-key {
  color: var(--color-ink-3);
  font-weight: 500;
}

.work-project {
  overflow: hidden;
  color: var(--color-ink-2);
  font-weight: 560;
  text-overflow: ellipsis;
}

.work-assignee {
  color: var(--color-ink-2);
  font-weight: 650;
  letter-spacing: 0.02em;
}

.work-assignee-self {
  color: var(--color-ink);
  font-weight: 700;
}

.work-due {
  overflow: hidden;
  color: var(--color-ink-3);
  text-align: right;
  text-overflow: ellipsis;
}

.work-due.due-soon {
  color: var(--color-ink-2);
}

.work-due.due-today {
  color: var(--color-ink);
  font-weight: 650;
}

.work-due.due-overdue {
  color: var(--color-rem);
  font-weight: 650;
}

.entity-kind {
  flex: 0 0 auto;
  overflow: hidden;
  color: var(--color-accent-2);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 680;
  letter-spacing: 0.04em;
  line-height: 17px;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.entity-content {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
}

.entity-line-1 {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.entity-line-1 strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 620;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-priority {
  flex: 0 0 auto;
  color: var(--color-ink-4);
}

.entity-priority.priority-high {
  color: var(--color-ink);
}

.entity-priority.priority-urgent {
  color: var(--color-rem);
}

.entity-line-2 {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  color: var(--color-ink-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 15px;
  white-space: nowrap;
}

.entity-status {
  flex: 0 0 auto;
  color: var(--color-ink-3);
}

.entity-status.state-waiting {
  color: var(--color-ink);
  font-weight: 650;
}

.entity-project {
  flex: 0 1 auto;
  overflow: hidden;
  max-width: 130px;
  color: var(--color-ink-2);
  text-overflow: ellipsis;
}

.entity-due {
  flex: 0 0 auto;
  color: var(--color-ink-3);
}

.entity-due.due-soon {
  color: var(--color-ink-2);
}

.entity-due.due-today,
.entity-due.due-overdue {
  font-weight: 650;
}

.entity-due.due-today {
  color: var(--color-ink);
}

.entity-due.due-overdue {
  color: var(--color-rem);
}

.entity-waiting {
  flex: 0 1 auto;
  overflow: hidden;
  color: var(--color-ink-2);
  text-overflow: ellipsis;
}

.entity-author {
  margin-left: auto;
  color: var(--color-ink-2);
  font-weight: 650;
  letter-spacing: 0.02em;
}

.entity-author-self {
  color: var(--color-ink);
  font-weight: 700;
}

.entity-summary {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-3);
  text-overflow: ellipsis;
}

.entity-updated {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 10px;
}

.entity-empty {
  display: grid;
  min-height: 340px;
  place-content: center;
  justify-items: center;
  padding: 36px;
  text-align: center;
}

.entity-empty h2 {
  margin-top: 15px;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 650;
}

.entity-empty p {
  max-width: 360px;
  margin-top: 6px;
  color: var(--color-ink-3);
  font-size: 11px;
  line-height: 1.5;
}

.entity-empty button {
  min-height: 32px;
  margin-top: 16px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 0 11px;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 630;
}

.entity-empty button:hover {
  background: var(--color-chrome-mid);
}

@container business-graph (max-width: 560px) {
  .entity-row {
    padding-inline: 10px;
  }

  .entity-row-work {
    grid-template-columns: 22px minmax(0, 1fr) 36px 96px;
  }

  .entity-row-work .work-project {
    display: none;
  }
}
</style>
