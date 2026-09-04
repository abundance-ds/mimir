<template>
  <div ref="board" data-graph-work-board class="work-board">
    <div v-if="!issues.length" class="board-empty">
      <h2>No work matches this view</h2>
      <p>Create work, broaden the project, owner, or priority filter, or include another scope.</p>
      <button
        type="button"
        data-graph-control="board-empty-create"
        @click="$emit('create', {
          columnId: groupBy === 'status' ? 'backlog' : UNASSIGNED,
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
        :data-board-column-collapsed="isCollapsed(column.id) ? 'true' : undefined"
        class="board-column"
        :class="{
          'board-column-collapsed': isCollapsed(column.id),
          'board-column-target': dropTarget?.columnId === column.id,
        }"
      >
        <button
          v-if="isCollapsed(column.id)"
          type="button"
          class="board-column-collapsed-control"
          :data-board-expand="column.id"
          :data-graph-control="`board-expand-${column.id}`"
          :aria-label="`Expand ${column.label}. ${issueCount(column.id)} ${issueCount(column.id) === 1 ? 'issue' : 'issues'}`"
          :title="`Expand ${column.label}`"
          @click="$emit('expand-column', column.id)"
        >
          <span class="board-column-count">{{ issueCount(column.id) }}</span>
          <span class="board-column-vertical-name">{{ column.label }}</span>
        </button>

        <header v-if="!isCollapsed(column.id)" class="board-column-header">
          <span class="board-column-name">{{ column.label }}</span>
          <span class="board-column-count">{{ issueCount(column.id) }}</span>
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
          v-if="!isCollapsed(column.id)"
          data-board-column-body
          class="board-column-body"
          role="listbox"
          :aria-label="`${column.label} issues`"
          aria-multiselectable="true"
        >
          <article
            v-for="(issue, index) in grouped[column.id]"
            :key="issue.id"
            role="option"
            tabindex="0"
            :data-board-card="issue.id"
            :data-board-row="issue.id"
            :data-drop-before="dropTarget?.beforeId === issue.id ? 'true' : undefined"
            :aria-label="rowLabel(issue, column)"
            :aria-selected="selectedIds.includes(issue.id)"
            class="board-row"
            :class="{
              'board-row-selected': selectedIds.includes(issue.id),
              'board-row-dragging': draggedId === issue.id,
              'board-row-drop-before': dropTarget?.beforeId === issue.id,
            }"
            @pointerdown="onPointerDown($event, issue.id)"
            @click="selectOrOpen($event, issue, column.id, index)"
            @keydown="onRowKeydown($event, issue, column.id, index)"
          >
            <span class="board-row-title" :title="issue.title || 'Untitled issue'">
              {{ issue.title || 'Untitled issue' }}
            </span>
            <span
              v-if="assignee(issue)"
              class="board-row-owner"
              :class="{ 'board-row-owner-self': assignee(issue).self }"
              :title="assignee(issue).self ? 'Assigned to you' : `Assigned to ${assignee(issue).name}`"
            >
              {{ assignee(issue).label }}
            </span>

            <span class="board-row-context">
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
              <span
                v-else-if="!hideProject && projectLabel(issue)"
                class="meta-project"
                :title="projectLabel(issue)"
              >
                {{ projectLabel(issue) }}
              </span>
            </span>

            <span class="board-row-meta">
              <GraphDatePicker
                :model-value="issue.dueDate || ''"
                :data-card-due="issue.id"
                :data-graph-control="`card-due-${issue.id}`"
                variant="row"
                class="meta-due"
                :class="`due-${due(issue).state}`"
                :aria-label="dueAccessibleLabel(issue)"
                @click.stop
                @update:model-value="patchDue(issue, $event)"
              >
                <template #trigger>
                  <IconCalendar v-if="!issue.dueDate" :size="12" aria-hidden="true" />
                  <template v-else>{{ due(issue).label }}</template>
                </template>
              </GraphDatePicker>
              <span
                v-if="waitingReason(issue)"
                class="meta-waiting"
                :title="`Waiting for ${waitingReason(issue)}`"
              >
                <span class="meta-key">waiting for</span> {{ waitingReason(issue) }}
              </span>
            </span>

            <GraphSelect
              :model-value="issue.priority || 'normal'"
              :options="priorities"
              variant="row"
              class="board-priority"
              :class="`priority-${issue.priority || 'normal'}`"
              :chevron="false"
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
                  :size="17"
                  :stroke-width="issue.priority === 'urgent' ? 2.5 : 2.1"
                />
              </template>
            </GraphSelect>
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
      <h2>No board columns</h2>
      <p>Add a project or change the grouping to see work.</p>
    </div>

    <div v-if="selectedIds.length > 1" class="board-selection-status" role="status">
      {{ selectedIds.length }} selected · P priority · ←/→ move · Esc clear
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconAntennaBars3,
  IconAntennaBars5,
  IconArrowNarrowDown,
  IconCalendar,
  IconExclamationMark,
  IconPlus,
} from '@tabler/icons-vue'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphSelect from './GraphSelect.vue'
import { useBoardDrag } from './useBoardDrag.js'
import {
  UNASSIGNED,
  WORK_STATUSES,
  assigneeDisplay,
  dueInfo,
  waitingReason,
} from './workRow.js'

const props = defineProps({
  issues: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  groupBy: { type: String, default: 'status' },
  collapsedStatuses: { type: Array, default: () => [] },
  /** Person id the reader is; that assignee renders as "you". */
  selfId: { type: String, default: '' },
  /** Hide the project token when one project already scopes the board. */
  hideProject: { type: Boolean, default: false },
})

const emit = defineEmits([
  'open',
  'move',
  'bulk-move',
  'create',
  'patch',
  'bulk-patch',
  'reorder',
  'expand-column',
])
const board = ref(null)
const selectedIds = ref([])
const selectionAnchor = ref(null)

const statuses = WORK_STATUSES
const statusOptions = Object.freeze(
  statuses.map(status => ({ value: status.id, label: status.label })),
)
const priorities = Object.freeze([
  { value: 'urgent', label: 'Urgent', icon: IconExclamationMark },
  { value: 'high', label: 'High', icon: IconAntennaBars5 },
  { value: 'normal', label: 'Normal', icon: IconAntennaBars3 },
  { value: 'low', label: 'Low', icon: IconArrowNarrowDown },
])
const priorityIcons = Object.freeze({
  urgent: IconExclamationMark,
  high: IconAntennaBars5,
  normal: IconAntennaBars3,
  low: IconArrowNarrowDown,
})
const priorityOrder = ['low', 'normal', 'high', 'urgent']
const boardColumns = computed(() => {
  if (props.groupBy === 'project') {
    return [
      ...props.projects.map(project => ({
        id: project.id,
        label: project.title || project.properties?.slug || project.slug || 'Untitled project',
      })),
      { id: UNASSIGNED, label: 'No project' },
    ]
  }
  return statuses
})
const grouped = computed(() => Object.fromEntries(
  boardColumns.value.map(column => [
    column.id,
    props.issues.filter(issue => (
      props.groupBy === 'project'
        ? (issue.projectId || UNASSIGNED) === column.id
        : (issue.status || 'backlog') === column.id
    )),
  ]),
))
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

function isCollapsed(columnId) {
  return props.groupBy === 'status' && props.collapsedStatuses.includes(columnId)
}

function issueCount(columnId) {
  return grouped.value[columnId]?.length || 0
}

const { draggedId, dropTarget, suppressClick, onPointerDown } = useBoardDrag({
  boardRef: board,
  onDrop: dropCard,
})

function dropCard(id, { columnId, beforeId }) {
  const issue = props.issues.find(item => item.id === id)
  if (!issue || restsInPlace(id, columnId, beforeId)) return
  emit('reorder', {
    issue,
    columnId,
    beforeId,
    groupBy: props.groupBy,
  })
}

/** Whether the card already sits where it was dropped, so nothing moves. */
function restsInPlace(id, columnId, beforeId) {
  const column = grouped.value[columnId] || []
  const from = column.findIndex(item => item.id === id)
  if (from < 0) return false
  const rest = column.filter(item => item.id !== id)
  const to = beforeId ? rest.findIndex(item => item.id === beforeId) : rest.length
  return to === from
}

function selectOrOpen(event, issue, columnId, index) {
  if (suppressClick.value) return
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
    const projectId = columnId === UNASSIGNED ? '' : columnId
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
  return project?.title || project?.slug || project?.properties?.slug || issue.projectId
}

function assignee(issue) {
  return assigneeDisplay(issue, { byId: byId.value, selfId: props.selfId })
}

function due(issue) {
  return dueInfo(issue.dueDate)
}

function dueAccessibleLabel(issue) {
  const info = due(issue)
  const title = issue.title || 'issue'
  return info.state === 'none'
    ? `Due date for ${title}. No date set`
    : `Due date for ${title}. ${info.label}`
}

function rowLabel(issue, column) {
  const owner = assignee(issue)
  const reason = waitingReason(issue)
  return [
    issue.title || 'Untitled issue',
    `${human(issue.priority || 'normal')} priority`,
    `in ${column.label}`,
    due(issue).label || 'no due date',
    reason ? `waiting for ${reason}` : '',
    owner ? (owner.self ? 'assigned to you' : `assigned to ${owner.name}`) : '',
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
  background: var(--color-chrome);
}

/* Columns share the width when there is room and scroll when there is not. */
.work-board-track {
  display: flex;
  width: max-content;
  min-width: 100%;
  height: 100%;
}

.board-column {
  display: flex;
  min-width: 280px;
  max-width: 460px;
  height: 100%;
  flex: 1 1 280px;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--color-rule);
  background: var(--color-chrome);
}

.board-column-collapsed {
  min-width: 42px;
  flex: 0 0 42px;
}

.board-column-collapsed-control {
  display: flex;
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  background: var(--color-chrome-high);
  color: var(--color-ink-3);
}

.board-column-collapsed-control:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.board-column-collapsed-control:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.board-column-vertical-name {
  overflow: hidden;
  max-height: calc(100% - 28px);
  color: var(--color-ink-2);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
}

.board-column-target {
  background: color-mix(in srgb, var(--color-accent) 6%, var(--color-chrome));
}

.board-column-target .board-column-collapsed-control {
  background: color-mix(in srgb, var(--color-accent-soft) 68%, var(--color-chrome-high));
  color: var(--color-ink);
}

.board-column-header {
  display: grid;
  min-height: 38px;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto 26px;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule);
  padding: 0 6px 0 12px;
  background: var(--color-chrome-high);
}

.board-column-name {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: -0.005em;
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
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  padding: 6px 6px 14px;
}

/* One fixed-height card. Left column: title, project, due date (+ waiting
   reason). Right column: owner at the top, priority at the bottom. Every
   fact keeps its place whatever the other values are.
   Material: the column is `chrome`, the card `chrome-high`, hover
   `chrome-mid`. This is the only stack that is raised in every theme;
   `surface` is lighter than chrome in light themes but darker in dracula,
   zenith, and synthwave. */
.board-row {
  position: relative;
  display: grid;
  width: 100%;
  height: 66px;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: 18px 16px 16px;
  align-items: center;
  column-gap: 8px;
  row-gap: 1px;
  border: 1px solid var(--color-rule-light);
  border-radius: 2px;
  background: var(--color-chrome-high);
  padding: 6px 9px 6px 10px;
  color: var(--color-ink);
  text-align: left;
}

.board-row:hover {
  border-color: var(--color-rule);
  background: var(--color-chrome-mid);
}

.board-row:hover .board-row-title,
.board-row:hover .board-row-owner {
  color: var(--color-ink);
}

.board-row-selected {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-rule));
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-chrome-high));
}

.board-row-selected:hover {
  background: color-mix(in srgb, var(--color-accent) 14%, var(--color-chrome-high));
}

.board-row-dragging {
  opacity: 0.48;
}

.board-row-drop-before::before {
  position: absolute;
  z-index: 2;
  inset: -4px 0 auto;
  height: 2px;
  background: var(--color-accent);
  content: '';
}

.board-row-title {
  overflow: hidden;
  grid-row: 1;
  grid-column: 1;
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.005em;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-row-owner {
  grid-row: 1;
  grid-column: 2;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.02em;
  line-height: 16px;
}

.board-row-owner-self {
  color: var(--color-ink);
  font-weight: 700;
}

.board-row-context,
.board-row-meta {
  display: flex;
  min-width: 0;
  grid-column: 1;
  align-items: center;
  gap: 7px;
  overflow: hidden;
  color: var(--color-ink-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  white-space: nowrap;
}

.board-row-context {
  grid-row: 2;
}

.board-row-meta {
  grid-row: 3;
}

.board-row-context .meta-status {
  height: 16px;
  flex: 0 0 auto;
  padding: 0 3px;
  margin-left: -3px;
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 560;
}

.meta-project {
  overflow: hidden;
  flex: 0 1 auto;
  color: var(--color-ink-2);
  font-weight: 560;
  text-overflow: ellipsis;
}

/* The waiting reason is the only slot that truncates. */
.meta-waiting {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  color: var(--color-ink-2);
  font-weight: 560;
  text-overflow: ellipsis;
}

.meta-key {
  color: var(--color-ink-3);
  font-weight: 500;
}

.board-row-meta :deep(.graph-date-row) {
  display: inline-flex;
  height: 16px;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 3px;
  margin-left: -3px;
  color: var(--color-ink-4);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 560;
  font-variant-numeric: tabular-nums;
}

.board-row-meta :deep(.graph-date-row.due-later) {
  color: var(--color-ink-3);
}

.board-row-meta :deep(.graph-date-row.due-soon) {
  color: var(--color-ink-2);
}

.board-row-meta :deep(.graph-date-row.due-today) {
  color: var(--color-ink);
  font-weight: 650;
}

.board-row-meta :deep(.graph-date-row.due-overdue) {
  color: var(--color-rem);
  font-weight: 650;
}

.board-row .board-priority {
  width: 22px;
  height: 18px;
  grid-row: 3;
  grid-column: 2;
  justify-self: end;
  justify-content: center;
  margin-right: -3px;
  padding: 0;
  color: var(--color-ink-2);
}

.board-row .board-priority.priority-urgent {
  color: var(--color-rem);
}

.board-row .board-priority.priority-high {
  color: var(--color-ink);
}

.board-row .board-priority.priority-normal,
.board-row .board-priority.priority-low {
  color: var(--color-ink-4);
}

.board-empty-column {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px dashed var(--color-rule);
  border-radius: 2px;
  color: var(--color-ink-4);
  font-size: 11px;
}

.board-empty-column:hover,
.board-empty-column:focus-visible {
  border-style: solid;
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
  font-size: 11px;
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
  font-size: 11px;
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
