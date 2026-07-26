<template>
  <div
    data-graph-work-board
    class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-chrome-high p-2"
  >
    <div class="flex h-full min-w-max gap-2">
      <section
        v-for="column in boardColumns"
        :key="column.id"
        :data-board-column="column.id"
        class="flex h-full w-[218px] flex-col border border-rule bg-surface"
        @dragover.prevent
        @drop="drop(column.id)"
      >
        <header class="flex h-8 shrink-0 items-center gap-2 border-b border-rule-light px-2">
            <span class="size-1.5 rounded-full" :class="column.dot || 'bg-ink-3'" />
          <span class="font-mono text-[8px] font-semibold uppercase tracking-[0.11em] text-ink-3">
            {{ column.label }}
          </span>
          <span class="ml-auto font-mono text-[8px] text-ink-4">
            {{ grouped[column.id]?.length || 0 }}
          </span>
          <button
            type="button"
            :data-board-add="column.id"
            class="grid size-5 place-items-center text-ink-4 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            :title="`Create in ${column.label}`"
            @click="$emit('create', { columnId: column.id, groupBy })"
          >
            <IconPlus :size="11" />
          </button>
        </header>

        <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
          <article
            v-for="issue in grouped[column.id]"
            :key="issue.id"
            draggable="true"
            role="button"
            tabindex="0"
            :data-board-card="issue.id"
            :aria-label="`${issue.title || issue.id}. Use left and right arrows to move.`"
            class="group w-full border border-rule-light bg-chrome-high p-2 text-left shadow-[0_1px_0_rgba(0,0,0,0.03)] hover:border-rule hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @dragstart="drag(issue.id)"
            @dragend="dragged = ''"
            @click="$emit('open', issue.id)"
            @keydown.enter.prevent="$emit('open', issue.id)"
            @keydown.left="moveByKeyboard($event, issue, column.id, -1)"
            @keydown.right="moveByKeyboard($event, issue, column.id, 1)"
          >
            <span class="flex min-w-0 items-start gap-1.5">
              <span class="mt-1 size-1.5 shrink-0 rounded-full" :class="priorityClass(issue.priority)" />
              <span class="line-clamp-3 min-w-0 text-[10px] font-semibold leading-[1.35] text-ink-2">
                {{ issue.title || issue.id }}
              </span>
            </span>
            <span v-if="issue.projectId" class="mt-1.5 flex items-center gap-1 truncate font-mono text-[7px] text-ink-4">
              <IconBriefcase2 :size="9" class="shrink-0" />
              {{ titleFor(issue.projectId) }}
            </span>
            <span v-if="issue.tags?.length" class="mt-1.5 flex flex-wrap gap-1">
              <span
                v-for="tag in issue.tags.slice(0, 3)"
                :key="tag"
                class="bg-chrome px-1 py-px font-mono text-[7px] text-ink-3"
              >{{ tag }}</span>
            </span>
            <span class="mt-2 flex h-4 items-center gap-1.5 font-mono text-[7px] text-ink-4">
              <span
                v-if="issue.dueDate"
                :class="{
                  'text-rem': overdue(issue.dueDate),
                  'text-[#b37a24]': dueSoon(issue.dueDate),
                }"
                :title="dueState(issue.dueDate)"
              >
                {{ compactDate(issue.dueDate) }}
              </span>
              <span v-if="issue.waitingFor" class="text-rem">waiting</span>
              <span v-if="issue.assigneeId" class="ml-auto truncate">
                @{{ titleFor(issue.assigneeId) }}
              </span>
              <IconGripVertical
                :size="10"
                class="ml-auto opacity-0 transition-opacity group-hover:opacity-60"
              />
            </span>
            <span class="mt-1.5 flex items-center gap-1 border-t border-rule-light pt-1.5">
              <button
                type="button"
                :data-card-priority="issue.id"
                class="h-5 border border-rule-light px-1.5 font-mono text-[6px] uppercase text-ink-4 hover:border-rule hover:text-ink"
                :title="`Priority: ${issue.priority || 'normal'}; click to cycle`"
                @click.stop="$emit('patch', { issue, setProperties: { priority: nextPriority(issue.priority) } })"
              >
                {{ issue.priority || 'normal' }}
              </button>
              <GraphSelect
                v-if="groupBy === 'project'"
                :model-value="issue.status || 'backlog'"
                :data-card-status="issue.id"
                class="min-w-0 flex-1"
                variant="card"
                :aria-label="`Status for ${issue.title || issue.id}`"
                :options="statuses"
                @click.stop
                @update:model-value="$emit('patch', { issue, setProperties: { status: $event } })"
              />
              <input
                :value="issue.dueDate || ''"
                :data-card-due="issue.id"
                type="date"
                class="h-5 w-[22px] border border-rule-light bg-surface text-transparent focus:w-[102px] focus:text-ink-3"
                title="Set due date"
                aria-label="Set due date"
                @click.stop
                @change.stop="$emit('patch', {
                  issue,
                  setProperties: $event.target.value ? { dueDate: $event.target.value } : {},
                  removeProperties: $event.target.value ? [] : ['dueDate'],
                })"
              />
            </span>
          </article>

          <button
            v-if="!grouped[column.id]?.length"
            type="button"
            class="grid h-16 w-full place-items-center border border-dashed border-rule-light text-[8px] text-ink-4 hover:border-rule hover:text-ink-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="$emit('create', { columnId: column.id, groupBy })"
          >
            Add work
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconBriefcase2,
  IconGripVertical,
  IconPlus,
} from '@tabler/icons-vue'
import GraphSelect from './GraphSelect.vue'

const props = defineProps({
  issues: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  projects: { type: Array, default: () => [] },
  groupBy: { type: String, default: 'status' },
  visibleStatuses: { type: Array, default: () => [] },
})

const emit = defineEmits(['open', 'move', 'create', 'patch'])
const dragged = ref('')
const statuses = Object.freeze([
  { id: 'backlog', label: 'Backlog', dot: 'bg-ink-4' },
  { id: 'plan', label: 'Plan', dot: 'bg-ink-3' },
  { id: 'in-progress', label: 'In progress', dot: 'bg-accent' },
  { id: 'waiting', label: 'Waiting', dot: 'bg-rem' },
  { id: 'review', label: 'Review', dot: 'bg-[#b37a24]' },
  { id: 'done', label: 'Done', dot: 'bg-add' },
])
const boardColumns = computed(() => {
  if (props.groupBy === 'project') {
    return [
      ...props.projects.map(project => ({
        id: project.id,
        label: project.title || project.id,
        dot: 'bg-add',
      })),
      { id: '__unassigned__', label: 'No project', dot: 'bg-ink-4' },
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

function drag(id) {
  dragged.value = id
}

function drop(status) {
  if (!dragged.value) return
  const issue = props.issues.find(item => item.id === dragged.value)
  if (issue) moveToColumn(issue, status)
  dragged.value = ''
}

function moveByKeyboard(event, issue, columnId, offset) {
  if (event.target !== event.currentTarget) return
  const index = boardColumns.value.findIndex(column => column.id === columnId)
  const target = boardColumns.value[index + offset]
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  moveToColumn(issue, target.id)
}

function moveToColumn(issue, columnId) {
  if (props.groupBy === 'project') {
    const projectId = columnId === '__unassigned__' ? '' : columnId
    if ((issue.projectId || '') !== projectId) emit('move', { issue, projectId })
  } else if (issue.status !== columnId) {
    emit('move', { issue, status: columnId })
  }
}

function nextPriority(priority) {
  const priorities = ['low', 'normal', 'high', 'urgent']
  const index = priorities.indexOf(priority || 'normal')
  return priorities[(index + 1) % priorities.length]
}

function titleFor(id) {
  return byId.value.get(id)?.title || id
}

function priorityClass(priority) {
  return {
    urgent: 'bg-rem',
    high: 'bg-[#b37a24]',
    normal: 'bg-ink-4',
    low: 'border border-rule bg-transparent',
  }[priority] || 'bg-ink-4'
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

function dueState(value) {
  if (overdue(value)) return 'Overdue'
  if (dueSoon(value)) return 'Due within seven days'
  return 'Due date'
}

function compactDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}.${match[2]}` : value
}
</script>
