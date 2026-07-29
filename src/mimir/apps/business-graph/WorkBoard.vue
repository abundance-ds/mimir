<template>
  <div data-graph-work-board class="work-board">
    <div v-if="!issues.length" class="board-empty">
      <h2>No work matches this view</h2>
      <p>Create work, broaden the priority filter, or include another scope.</p>
      <button
        type="button"
        data-graph-control="board-empty-create"
        @click="$emit('create', {
          columnId: groupBy === 'status' ? (visibleStatuses[0] || 'backlog') : '__unassigned__',
          groupBy,
        })"
      >
        <IconPlus :size="14" />
        New issue
      </button>
    </div>

    <div v-else-if="boardColumns.length" class="work-board-track">
      <section
        v-for="column in boardColumns"
        :key="column.id"
        :data-board-column="column.id"
        class="board-column"
        :class="{ 'board-column-target': dragColumn === column.id }"
        @dragover.prevent="dragColumn = column.id"
        @dragleave.self="dragColumn = ''"
        @drop.prevent="dropOnColumn(column.id)"
      >
        <header class="board-column-header">
          <span class="board-column-name">{{ column.label }}</span>
          <span class="board-column-count">{{ grouped[column.id]?.length || 0 }}</span>
          <button
            type="button"
            :data-board-add="column.id"
            :data-graph-control="`board-add-${column.id}`"
            :aria-label="`Create in ${column.label}`"
            @click="$emit('create', { columnId: column.id, groupBy })"
          >
            <IconPlus :size="13" />
          </button>
        </header>

        <div
          class="board-column-body"
          role="listbox"
          :aria-label="`${column.label} issues`"
          aria-multiselectable="true"
        >
          <article
            v-for="(issue, index) in grouped[column.id]"
            :key="issue.id"
            draggable="true"
            role="option"
            tabindex="0"
            :data-board-card="issue.id"
            :data-board-row="issue.id"
            :data-drop-before="dropBefore === issue.id ? 'true' : undefined"
            :aria-label="rowLabel(issue, column)"
            :aria-selected="selectedIds.includes(issue.id)"
            class="board-row"
            :class="{
              'board-row-selected': selectedIds.includes(issue.id),
              'board-row-dragging': dragged === issue.id,
              'board-row-drop-before': dropBefore === issue.id,
            }"
            @dragstart="drag($event, issue.id)"
            @dragover.prevent.stop="dragOverRow($event, issue.id, column.id)"
            @drop.prevent.stop="dropOnRow(issue.id, column.id)"
            @dragend="clearDrag"
            @click="selectOrOpen($event, issue, column.id, index)"
            @keydown="onRowKeydown($event, issue, column.id, index)"
          >
            <GraphSelect
              :model-value="issue.priority || 'normal'"
              :options="priorities"
              variant="row"
              class="board-priority"
              :class="`priority-${issue.priority || 'normal'}`"
              :data-card-priority="issue.id"
              :data-graph-control="`card-priority-${issue.id}`"
              :aria-label="`${human(issue.priority || 'normal')} priority for ${issue.title || 'issue'}`"
              :menu-min-width="132"
              @click.stop
              @update:model-value="setPriority(issue, $event)"
            >
              <template #trigger>
                <component
                  :is="priorityIcons[issue.priority || 'normal']"
                  :size="16"
                  :stroke-width="2.2"
                />
              </template>
            </GraphSelect>
            <span class="board-row-title">{{ issue.title || 'Untitled issue' }}</span>

            <span class="board-row-meta">
              <GraphSelect
                v-if="groupBy === 'project'"
                :model-value="issue.status || 'backlog'"
                :options="statusOptions"
                variant="row"
                class="meta-status"
                :data-card-status="issue.id"
                :data-graph-control="`card-status-${issue.id}`"
                :aria-label="`Status for ${issue.title || 'issue'}`"
                :menu-min-width="128"
                @click.stop
                @update:model-value="setStatus(issue, $event)"
              />
              <span v-else-if="projectLabel(issue)" class="meta-project">
                {{ projectLabel(issue) }}
              </span>
              <GraphDatePicker
                :model-value="issue.dueDate || ''"
                :data-card-due="issue.id"
                :data-graph-control="`card-due-${issue.id}`"
                variant="row"
                class="meta-due"
                placeholder="set date"
                :class="{
                  overdue: overdue(issue.dueDate),
                  soon: dueSoon(issue.dueDate),
                }"
                :aria-label="`Due date for ${issue.title || 'issue'}`"
                @click.stop
                @update:model-value="patchDue(issue, $event)"
              />
              <span v-if="overdue(issue.dueDate)" class="meta-overdue">overdue</span>
              <span v-if="issue.waitingFor" class="meta-waiting">waiting</span>
              <span
                v-if="actorDisplay(actorFor(issue.id))"
                class="meta-author"
                :title="actorFor(issue.id)?.label"
              >
                {{ actorDisplay(actorFor(issue.id)) }}
              </span>
            </span>
          </article>

          <button
            v-if="!grouped[column.id]?.length"
            type="button"
            class="board-empty-column"
            :data-graph-control="`board-empty-${column.id}`"
            @click="$emit('create', { columnId: column.id, groupBy })"
          >
            <IconPlus :size="13" />
            Add work
          </button>
        </div>
      </section>
    </div>

    <div v-else class="board-empty">
      <h2>No visible board columns</h2>
      <p>Enable a status column or change the grouping to see work.</p>
    </div>

    <div v-if="selectedIds.length > 1" class="board-selection-status" role="status">
      {{ selectedIds.length }} selected · P priority · ←/→ move · Esc clear
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconAntennaBars2,
  IconAntennaBars3,
  IconAntennaBars4,
  IconExclamationMark,
  IconPlus,
} from '@tabler/icons-vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  issues: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  actors: { type: Object, default: () => ({}) },
  groupBy: { type: String, default: 'status' },
  visibleStatuses: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'open',
  'move',
  'bulk-move',
  'create',
  'patch',
  'bulk-patch',
  'reorder',
])
const dragged = ref('')
const dragColumn = ref('')
const dropBefore = ref('')
const selectedIds = ref([])
const selectionAnchor = ref(null)

const statuses = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'plan', label: 'Plan' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
])
const statusOptions = Object.freeze(
  statuses.map(status => ({ value: status.id, label: status.label })),
)
const priorities = Object.freeze([
  { value: 'urgent', label: 'Urgent', icon: IconExclamationMark },
  { value: 'high', label: 'High', icon: IconAntennaBars4 },
  { value: 'normal', label: 'Normal', icon: IconAntennaBars3 },
  { value: 'low', label: 'Low', icon: IconAntennaBars2 },
])
const priorityIcons = Object.freeze({
  urgent: IconExclamationMark,
  high: IconAntennaBars4,
  normal: IconAntennaBars3,
  low: IconAntennaBars2,
})
const priorityOrder = ['low', 'normal', 'high', 'urgent']
const boardColumns = computed(() => {
  if (props.groupBy === 'project') {
    return [
      ...props.projects.map(project => ({
        id: project.id,
        label: project.properties?.slug || project.slug || project.title || 'Untitled project',
      })),
      { id: '__unassigned__', label: 'No project' },
    ]
  }
  const visible = new Set(props.visibleStatuses.length
    ? props.visibleStatuses
    : statuses.map(status => status.id))
  return statuses.filter(status => visible.has(status.id))
})
const grouped = computed(() => Object.fromEntries(
  boardColumns.value.map(column => [
    column.id,
    props.issues.filter(issue => (
      props.groupBy === 'project'
        ? (issue.projectId || '__unassigned__') === column.id
        : (issue.status || 'backlog') === column.id
    )),
  ]),
))
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

function drag(event, id) {
  dragged.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function dragOverRow(event, id, columnId) {
  dragColumn.value = columnId
  if (id !== dragged.value) dropBefore.value = id
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function dropOnColumn(columnId) {
  moveDragged(columnId, '')
}

function dropOnRow(beforeId, columnId) {
  moveDragged(columnId, beforeId)
}

function moveDragged(columnId, beforeId) {
  if (!dragged.value) return
  const issue = props.issues.find(item => item.id === dragged.value)
  if (issue) {
    emit('reorder', {
      issue,
      columnId,
      beforeId,
      groupBy: props.groupBy,
    })
  }
  clearDrag()
}

function clearDrag() {
  dragged.value = ''
  dragColumn.value = ''
  dropBefore.value = ''
}

function selectOrOpen(event, issue, columnId, index) {
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    updateSelection(event, issue, columnId, index)
    return
  }
  selectedIds.value = [issue.id]
  selectionAnchor.value = { columnId, index }
  emit('open', issue.id)
}

function updateSelection(event, issue, columnId, index) {
  if (event.shiftKey && selectionAnchor.value?.columnId === columnId) {
    const start = Math.min(selectionAnchor.value.index, index)
    const end = Math.max(selectionAnchor.value.index, index)
    const range = grouped.value[columnId].slice(start, end + 1).map(item => item.id)
    selectedIds.value = [...new Set([...selectedIds.value, ...range])]
    return
  }
  selectedIds.value = selectedIds.value.includes(issue.id)
    ? selectedIds.value.filter(id => id !== issue.id)
    : [...selectedIds.value, issue.id]
  selectionAnchor.value = { columnId, index }
}

function onRowKeydown(event, issue, columnId, index) {
  if (event.key === 'Escape') {
    event.preventDefault()
    selectedIds.value = []
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('open', issue.id)
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    updateSelection(event, issue, columnId, index)
    return
  }
  if (event.key.toLowerCase() === 'p') {
    event.preventDefault()
    cyclePriority(issue)
    return
  }
  if (event.key.toLowerCase() === 'd') {
    event.preventDefault()
    event.currentTarget.querySelector(`[data-card-due="${CSS.escape(issue.id)}"]`)?.click()
    return
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    const offset = event.key === 'ArrowUp' ? -1 : 1
    const rows = [...event.currentTarget.parentElement.querySelectorAll('[data-board-row]')]
    rows[Math.max(0, Math.min(rows.length - 1, index + offset))]?.focus()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    moveByKeyboard(event, issue, columnId, event.key === 'ArrowLeft' ? -1 : 1)
  }
}

function moveByKeyboard(event, issue, columnId, offset) {
  const columnIndex = boardColumns.value.findIndex(column => column.id === columnId)
  const target = boardColumns.value[columnIndex + offset]
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  const selected = selectedIssues(issue)
  if (selected.length > 1) {
    emit('bulk-move', {
      issues: selected,
      columnId: target.id,
      groupBy: props.groupBy,
    })
  } else {
    moveToColumn(issue, target.id)
  }
}

function moveToColumn(issue, columnId) {
  if (props.groupBy === 'project') {
    const projectId = columnId === '__unassigned__' ? '' : columnId
    if ((issue.projectId || '') !== projectId) emit('move', { issue, projectId })
  } else if (issue.status !== columnId) {
    emit('move', { issue, status: columnId })
  }
}

function setPriority(issue, priority) {
  applyPatch(issue, { priority })
}

function setStatus(issue, status) {
  applyPatch(issue, { status })
}

function cyclePriority(issue) {
  const current = priorityOrder.indexOf(issue.priority || 'normal')
  applyPatch(issue, { priority: priorityOrder[(current + 1) % priorityOrder.length] })
}

function applyPatch(issue, setProperties) {
  const selected = selectedIssues(issue)
  if (selected.length > 1) {
    emit('bulk-patch', { issues: selected, setProperties })
  } else {
    emit('patch', { issue, setProperties })
  }
}

function selectedIssues(fallback) {
  if (!selectedIds.value.includes(fallback.id)) return [fallback]
  const selected = props.issues.filter(issue => selectedIds.value.includes(issue.id))
  return selected.length ? selected : [fallback]
}

function patchDue(issue, value) {
  emit('patch', {
    issue,
    setProperties: value ? { dueDate: value } : {},
    removeProperties: value ? [] : ['dueDate'],
  })
}

function projectLabel(issue) {
  if (!issue.projectId) return ''
  const project = byId.value.get(issue.projectId)
  return project?.slug || project?.properties?.slug || project?.title || ''
}

function actorFor(id) {
  return props.actors?.[id] || null
}

function actorDisplay(actor) {
  if (!actor) return ''
  if (actor.id === 'local-human' || actor.label === 'You' || actor.initials === 'ME') return 'you'
  if (actor.kind === 'external' || actor.id === 'external' || actor.initials === 'EX') {
    return 'external'
  }
  return actor.initials || actor.label || ''
}

function overdue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value < new Date().toISOString().slice(0, 10)
}

function dueSoon(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || overdue(value)) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(`${value}T00:00:00`)
  const days = (due.getTime() - today.getTime()) / 86_400_000
  return days >= 0 && days <= 7
}

function rowLabel(issue, column) {
  return [
    issue.title || 'Untitled issue',
    `${human(issue.priority || 'normal')} priority`,
    `in ${column.label}`,
    issue.dueDate ? `due ${issue.dueDate}` : 'no due date',
    overdue(issue.dueDate) ? 'overdue' : '',
    issue.waitingFor ? 'waiting' : '',
    'P cycles priority, D sets due date, arrows move',
  ].filter(Boolean).join('. ')
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.work-board {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--color-surface);
}

.work-board-track {
  display: flex;
  height: 100%;
  min-width: max-content;
  gap: 1px;
  background: var(--color-rule);
}

.board-column {
  display: flex;
  width: 340px;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
}

.board-column-target {
  background: color-mix(in srgb, var(--color-accent-soft) 32%, var(--color-surface));
}

.board-column-header {
  display: grid;
  min-height: 34px;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto 26px;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--color-rule);
  padding: 0 5px 0 9px;
  background: var(--color-chrome-high);
}

.board-column-name {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-column-count {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.board-column-header button {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 2px;
  color: var(--color-ink-4);
}

.board-column-header button:hover,
.board-column-header button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.board-column-header button:focus-visible,
.board-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.board-column-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
}

.board-row {
  position: relative;
  display: grid;
  width: 100%;
  height: 41px;
  min-height: 41px;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: 22px 19px;
  align-items: center;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-surface);
  color: var(--color-ink);
  text-align: left;
}

.board-row:hover {
  background: var(--color-chrome-mid);
}

.board-row:hover .board-row-title,
.board-row:hover .meta-author {
  color: var(--color-ink);
}

.board-row-selected {
  background: var(--color-accent-soft);
}

.board-row-selected:hover {
  background: color-mix(in srgb, var(--color-accent-soft) 78%, var(--color-chrome-mid));
}

.board-row-dragging {
  opacity: 0.48;
}

.board-row-drop-before::before {
  position: absolute;
  z-index: 2;
  inset: -1px 0 auto;
  height: 2px;
  background: var(--color-accent);
  content: '';
}

.board-priority {
  align-self: center;
  margin-left: 5px;
  color: var(--color-ink-2);
}

.board-priority.priority-urgent {
  color: var(--color-rem);
}

.board-priority.priority-normal {
  color: var(--color-ink-3);
}

.board-priority.priority-low {
  color: var(--color-ink-4);
}

.board-row-title {
  overflow: hidden;
  align-self: center;
  padding-right: 8px;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 620;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-row-meta {
  display: flex;
  min-width: 0;
  grid-column: 1 / -1;
  align-items: center;
  gap: 7px;
  overflow: hidden;
  padding: 0 8px 0 9px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  white-space: nowrap;
}

.meta-status {
  flex: 0 0 auto;
  color: var(--color-ink-3);
}

.meta-project {
  overflow: hidden;
  max-width: 96px;
  flex: 0 1 auto;
  color: var(--color-ink-3);
  text-overflow: ellipsis;
}

.meta-overdue {
  flex: 0 0 auto;
  color: var(--color-rem);
}

.meta-due:not(.overdue):not(.soon) {
  color: var(--color-ink-4);
}

.meta-waiting {
  flex: 0 0 auto;
  color: var(--color-ink-2);
}

:deep(.graph-date-row) {
  flex: 0 0 auto;
}

:deep(.graph-date-row.overdue) {
  color: var(--color-rem);
  font-weight: 650;
}

:deep(.graph-date-row.soon) {
  color: var(--color-ink-2);
}

.meta-author {
  margin-left: auto;
  color: var(--color-ink-3);
  font-weight: 650;
}

.board-empty-column {
  display: flex;
  width: 100%;
  min-height: 41px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-bottom: 1px solid var(--color-rule-light);
  color: var(--color-ink-4);
  font-size: 10px;
}

.board-empty-column:hover,
.board-empty-column:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
}

.board-empty {
  display: grid;
  min-height: 330px;
  place-content: center;
  justify-items: center;
  padding: 30px;
  text-align: center;
}

.board-empty h2 {
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.board-empty p {
  max-width: 390px;
  margin-top: 5px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.5;
}

.board-empty > button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 5px;
  margin-top: 14px;
  border-radius: 2px;
  background: var(--color-accent);
  padding: 0 10px;
  color: var(--color-accent-ink, white);
  font-size: 10px;
  font-weight: 650;
}

.board-selection-status {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 5;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 5px 8px;
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 9px;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--color-ink) 12%, transparent);
}
</style>
