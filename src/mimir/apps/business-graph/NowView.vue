<template>
  <section ref="root" data-graph-now class="now-view" aria-label="Changes">
    <div class="now-toolbar">
      <span>Newest first</span>
      <button
        type="button"
        data-graph-control="changes-summarise"
        :disabled="!total || !canSummarise"
        :title="summariseTitle"
        @click="$emit('summarise')"
      >
        <IconNotes :size="13" />
        Summarise
      </button>
    </div>

    <section v-if="waiting.length" class="now-waiting">
      <h2>Waiting on you · {{ waiting.length }}</h2>
      <button
        v-for="issue in waiting"
        :key="issue.id"
        type="button"
        class="now-waiting-row"
        :data-now-waiting="issue.id"
        @click="$emit('open', issue.id)"
      >
        <strong>{{ issue.title || 'Untitled issue' }}</strong>
        <span class="now-waiting-reason">{{ waitingReason(issue) }}</span>
        <span class="now-row-context">{{ projectLabel(issue) }}</span>
      </button>
    </section>

    <div v-if="unseenCount" class="now-caught-up">
      <span>Changes since {{ compactTime(seenAt) }}</span>
      <button
        type="button"
        data-graph-control="now-mark-seen"
        @click="$emit('seen', events[0].timestamp)"
      >
        Mark caught up
      </button>
    </div>

    <div v-if="dayGroups.length" class="now-stream">
      <template v-for="group in dayGroups" :key="group.label">
        <div class="now-day">{{ group.label }}</div>
        <template v-for="item in group.items" :key="item.event.id">
          <div v-if="item.boundary" class="now-seen">
            <span>since {{ compactTime(seenAt) }}</span>
          </div>
          <article
            class="now-event"
            :class="{ 'now-event-expanded': expanded.includes(item.event.id) }"
          >
            <button
              type="button"
              class="now-event-main"
              :data-graph-event="item.event.id"
              :aria-expanded="hasDetail(item.event) ? expanded.includes(item.event.id) : undefined"
              @click="activate(item.event)"
            >
              <time>{{ compactTime(item.event.timestamp) }}</time>
              <span
                class="now-event-type"
                :data-event-tone="eventTone(item.event)"
              >
                {{ eventLabel(item.event) }}
              </span>
              <span class="now-event-object">
                <strong>{{ item.event.title || item.event.nodeId }}</strong>
                <small>{{ objectMeta(item.event) }}</small>
              </span>
              <span class="now-event-change">{{ changeLabel(item.event) }}</span>
              <span class="now-event-actor" :title="item.event.actor?.label || 'External edit'">
                {{ actorLabel(item.event) }}
              </span>
            </button>
            <button
              v-if="hasDetail(item.event)"
              type="button"
              class="now-event-expand"
              :data-now-expand="item.event.id"
              :aria-expanded="expanded.includes(item.event.id)"
              :aria-label="`Inspect event: ${item.event.summary}`"
              @click="toggle(item.event.id)"
            >
              <IconChevronDown :size="12" :class="{ rotated: expanded.includes(item.event.id) }" />
            </button>
            <div v-if="expanded.includes(item.event.id)" class="now-event-detail">
              <dl v-if="item.event.changes?.length">
                <div v-for="change in item.event.changes" :key="change.field">
                  <dt>{{ human(change.field) }}</dt>
                  <dd>
                    <span>{{ compactValue(change.before) }}</span>
                    <b>→</b>
                    <span>{{ compactValue(change.after) }}</span>
                  </dd>
                </div>
              </dl>
              <p v-if="item.event.data?.deliverable" class="now-event-deliverable">
                Deliverable ·
                {{ item.event.data.deliverable.label || item.event.data.deliverable.path }}
              </p>
              <p class="now-event-provenance">
                {{ actorLabel(item.event) }}
                · {{ humanAction(item.event.action) }}
                · graph revision {{ item.event.graphRevision }}
              </p>
              <button
                type="button"
                class="now-event-open"
                :data-now-event-open="item.event.nodeId"
                :aria-label="`Open ${item.event.title || item.event.nodeId}`"
                @click="$emit('open', item.event.nodeId)"
              >
                Open {{ human(item.event.nodeKind) }}
              </button>
            </div>
          </article>
        </template>
      </template>
    </div>

    <div v-else-if="!waiting.length" class="now-empty">
      <strong>No graph events yet</strong>
      <p>Filings, status changes, decisions, evidence, and overdue work appear here.</p>
    </div>

    <nav
      v-if="total > limit"
      class="now-pagination"
      aria-label="Change history pages"
    >
      <button
        type="button"
        data-now-page-previous
        :disabled="loading || offset <= 0"
        @click="goTo(Math.max(0, offset - limit))"
      >
        <IconChevronLeft :size="13" />
        <span>Previous</span>
      </button>
      <span aria-live="polite">
        {{ pageStart }}–{{ pageEnd }} of {{ total }}
      </span>
      <button
        type="button"
        data-now-page-next
        :disabled="loading || offset + limit >= total"
        @click="goTo(offset + limit)"
      >
        <span>Next</span>
        <IconChevronRight :size="13" />
      </button>
    </nav>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconNotes,
} from '@tabler/icons-vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  waiting: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  seenAt: { type: String, default: '' },
  total: { type: Number, default: 0 },
  offset: { type: Number, default: 0 },
  limit: { type: Number, default: 50 },
  loading: { type: Boolean, default: false },
  canSummarise: { type: Boolean, default: false },
})

const emit = defineEmits(['open', 'page', 'seen', 'summarise'])
const root = ref(null)
const expanded = ref([])
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))
const pageStart = computed(() => props.total ? props.offset + 1 : 0)
const pageEnd = computed(() => Math.min(props.total, props.offset + props.events.length))
const summariseTitle = computed(() => {
  if (!props.total) return 'There are no changes to summarise'
  if (!props.canSummarise) return 'Configure an available CLI agent in Settings'
  return 'Summarise recent changes with a CLI agent'
})

const unseenCount = computed(() => {
  if (!props.seenAt) return 0
  return props.events.filter(event => event.timestamp > props.seenAt).length
})

const decorated = computed(() => {
  const boundaryIndex = props.seenAt
    ? props.events.findIndex(event => event.timestamp <= props.seenAt)
    : -1
  return props.events.map((event, index) => ({
    event,
    boundary: index === boundaryIndex && boundaryIndex > 0,
  }))
})

const dayGroups = computed(() => {
  const groups = []
  const byLabel = new Map()
  for (const item of decorated.value) {
    const label = dayLabel(item.event.timestamp)
    if (!byLabel.has(label)) {
      const group = { label, items: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    byLabel.get(label).items.push(item)
  }
  return groups
})

function toggle(id) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter(candidate => candidate !== id)
    : [...expanded.value, id]
}

function hasDetail(event) {
  return Boolean(event)
}

function activate(event) {
  if (hasDetail(event)) toggle(event.id)
  else emit('open', event.nodeId)
}

function goTo(offset) {
  root.value?.scrollTo?.({ top: 0, behavior: 'auto' })
  emit('page', offset)
}

function dayLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Earlier'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(date)
}

function compactTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '').slice(11, 16)
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function waitingReason(issue) {
  if (issue.waitingFor) return `waiting for ${issue.waitingFor}`
  if (issue.needsDetail) return 'needs detail'
  return 'decision needed'
}

function projectLabel(issue) {
  if (!issue.projectId) return ''
  const project = byId.value.get(issue.projectId)
  return project?.slug || project?.properties?.slug || project?.title || ''
}

function sourceLabel(event) {
  if (event.nodeKind === 'issue') {
    const issue = byId.value.get(event.nodeId)
    if (issue) return projectLabel(issue) || human(event.nodeKind)
  }
  return human(event.nodeKind)
}

function eventLabel(event) {
  if (event.action === 'external.file-change') return 'External edit'
  return {
    created: 'Created',
    restored: 'Restored',
    deleted: 'Deleted',
    'decision-recorded': 'Decision',
    'evidence-captured': 'Evidence',
    'next-action-created': 'Next action',
    'status-changed': 'Status',
    'waiting-cleared': 'Waiting cleared',
    'deliverable-added': 'Deliverable',
    'became-overdue': 'Overdue',
    updated: 'Updated',
  }[event.eventType] || titleCase(human(event.eventType || 'updated'))
}

function eventTone(event) {
  if (['deleted', 'became-overdue'].includes(event.eventType)) return 'attention'
  if (['created', 'restored', 'decision-recorded', 'evidence-captured'].includes(event.eventType)) {
    return 'added'
  }
  if (event.action === 'external.file-change') return 'external'
  return 'changed'
}

function actorLabel(event) {
  const actor = event.actor || {}
  if (actor.id === 'local-human' || actor.label === 'You' || actor.initials === 'ME') return 'You'
  if (actor.kind === 'external' || actor.id === 'external' || actor.initials === 'EX') {
    return 'External'
  }
  return actor.label || titleCase(human(actor.kind || 'Unknown'))
}

function objectMeta(event) {
  const kind = titleCase(human(event.nodeKind))
  const source = sourceLabel(event)
  if (!source || source.toLowerCase() === kind.toLowerCase()) return kind
  return `${kind} · ${source}`
}

function changeLabel(event) {
  if (event.data?.deliverable) {
    return event.data.deliverable.label || event.data.deliverable.path || 'New deliverable'
  }
  const changes = Array.isArray(event.changes) ? event.changes : []
  const primary = changes.find(change => (
    ['status', 'priority', 'dueDate', 'waitingFor'].includes(change.field)
  ))
  if (primary) {
    const format = value => (
      ['status', 'priority'].includes(primary.field)
        ? titleCase(human(compactValue(value)))
        : compactValue(value)
    )
    const before = format(primary.before)
    const after = format(primary.after)
    return before === '—'
      ? `${titleCase(human(primary.field))}: ${after}`
      : `${before} → ${after}`
  }
  if (changes.length === 1) return `${titleCase(human(changes[0].field))} changed`
  if (changes.length > 1) {
    const fields = changes.slice(0, 2).map(change => human(change.field)).join(', ')
    return `${titleCase(fields)}${changes.length > 2 ? ` +${changes.length - 2}` : ''}`
  }
  if (event.action === 'external.file-change') return 'Source file changed'
  return {
    created: 'New graph item',
    restored: 'Returned to graph',
    deleted: 'Moved to Trash',
    'decision-recorded': 'Decision recorded',
    'evidence-captured': 'Evidence captured',
    'next-action-created': 'Follow-up filed',
    'waiting-cleared': 'Waiting field removed',
    'became-overdue': event.data?.dueDate ? `Due ${event.data.dueDate}` : 'Due date passed',
  }[event.eventType] || 'Metadata updated'
}

function humanAction(value) {
  return String(value || 'unknown action').replaceAll(/[.-]/g, ' ')
}

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.length ? `${value.length} items` : '—'
  if (typeof value === 'object' && Number.isFinite(value.characters)) {
    return `${value.characters} characters`
  }
  return JSON.stringify(value).slice(0, 80)
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, character => character.toUpperCase())
}
</script>

<style scoped>
.now-view {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  background: var(--color-surface);
}

.now-toolbar {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 4px 10px 4px 13px;
}

.now-toolbar > span {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-toolbar button {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 5px;
  border-radius: 3px;
  padding: 0 7px;
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 600;
}

.now-toolbar button:hover:not(:disabled),
.now-toolbar button:focus-visible {
  background: var(--color-surface);
  color: var(--color-ink);
}

.now-toolbar button:disabled {
  opacity: 0.38;
}

.now-waiting {
  border-bottom: 1px solid var(--color-rule);
  padding-bottom: 4px;
}

.now-waiting h2 {
  padding: 10px 13px 6px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.now-waiting-row {
  display: grid;
  width: 100%;
  min-height: 32px;
  grid-template-columns: minmax(220px, 1fr) minmax(160px, 0.7fr) minmax(90px, 0.3fr);
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 13px;
  text-align: left;
}

.now-waiting-row:last-child {
  border-bottom: 0;
}

.now-waiting-row:hover,
.now-waiting-row:focus-visible,
.now-event-main:hover,
.now-event-main:focus-visible {
  background: var(--color-chrome-mid);
}

.now-waiting-row strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-waiting-reason {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-row-context {
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-caught-up {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 13px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-caught-up button {
  min-height: 22px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-caught-up button:hover,
.now-caught-up button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.now-day {
  position: sticky;
  top: 0;
  z-index: 1;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 5px 13px 4px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.now-event {
  position: relative;
  border-bottom: 1px solid var(--color-rule-light);
}

.now-event-main {
  display: grid;
  width: 100%;
  min-height: 38px;
  grid-template-columns: 44px 78px minmax(220px, 1fr) minmax(140px, 0.55fr) 80px 24px;
  align-items: center;
  gap: 9px;
  padding: 3px 8px 3px 13px;
  text-align: left;
}

.now-event-main time {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.now-event-type {
  overflow: hidden;
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-type[data-event-tone='added'] {
  color: var(--color-add);
}

.now-event-type[data-event-tone='attention'] {
  color: var(--color-rem);
}

.now-event-type[data-event-tone='external'] {
  color: var(--color-ink-3);
}

.now-event-object {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.now-event-object strong {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-object small {
  overflow: hidden;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 8.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-main:hover .now-event-object strong {
  color: var(--color-ink);
}

.now-event-change,
.now-event-actor {
  overflow: hidden;
  color: var(--color-ink-3);
  font-size: 9.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-actor {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-event-expand {
  position: absolute;
  top: 4px;
  right: 8px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 2px;
  color: var(--color-ink-4);
}

.now-event-expand:hover,
.now-event-expand:focus-visible {
  background: var(--color-chrome-high);
  color: var(--color-ink);
}

.now-event-expand svg.rotated {
  transform: rotate(180deg);
}

.now-event-detail {
  border-top: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 8px 13px 9px 92px;
}

.now-event-detail dl {
  display: grid;
  gap: 4px;
}

.now-event-detail dl > div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 9px;
}

.now-event-detail dt,
.now-event-detail dd,
.now-event-detail p {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.5;
}

.now-event-detail dt {
  color: var(--color-ink-4);
}

.now-event-detail dd {
  display: flex;
  min-width: 0;
  gap: 6px;
}

.now-event-detail dd span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-detail dd b {
  color: var(--color-ink-4);
  font-weight: 400;
}

.now-event-deliverable {
  margin-top: 5px;
  color: var(--color-ink-2) !important;
}

.now-event-provenance {
  margin-top: 6px;
  color: var(--color-ink-4) !important;
}

.now-event-open {
  min-height: 22px;
  margin-top: 7px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: var(--color-surface);
  padding: 0 8px;
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 600;
}

.now-event-open:hover,
.now-event-open:focus-visible {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.now-seen {
  display: flex;
  min-height: 24px;
  align-items: center;
  gap: 8px;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-seen::before,
.now-seen::after {
  height: 1px;
  flex: 1 1 auto;
  background: var(--color-accent);
  content: '';
  opacity: 0.35;
}

.now-empty {
  display: grid;
  min-height: 260px;
  place-content: center;
  justify-items: center;
  padding: 24px;
  text-align: center;
}

.now-empty strong {
  color: var(--color-ink);
  font-size: 12px;
}

.now-empty p {
  max-width: 390px;
  margin-top: 5px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.5;
}

.now-pagination {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: grid;
  min-height: 34px;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  border-top: 1px solid var(--color-rule);
  background: color-mix(in srgb, var(--color-surface) 96%, transparent);
  padding: 4px 10px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}

.now-pagination button {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  gap: 3px;
  border-radius: 3px;
  padding: 0 6px;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10px;
}

.now-pagination button:first-child {
  justify-self: start;
}

.now-pagination button:last-child {
  justify-self: end;
}

.now-pagination button:hover:not(:disabled),
.now-pagination button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.now-pagination button:disabled {
  opacity: 0.38;
}

@container business-graph (max-width: 700px) {
  .now-row-context,
  .now-waiting-reason,
  .now-event-change,
  .now-event-actor {
    display: none;
  }

  .now-event-main {
    grid-template-columns: 42px 72px minmax(150px, 1fr) 24px;
  }

  .now-waiting-row {
    grid-template-columns: minmax(150px, 1fr) minmax(100px, 0.5fr);
  }
}
</style>
