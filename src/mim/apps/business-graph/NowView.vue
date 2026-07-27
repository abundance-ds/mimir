<template>
  <section data-graph-now class="now-view" aria-label="Now">
    <header class="now-header">
      <div>
        <span class="now-kicker">NOW / GRAPH WIRE</span>
        <strong>What changed</strong>
      </div>
      <button
        v-if="events.length"
        type="button"
        data-graph-control="now-mark-seen"
        @click="$emit('seen', events[0])"
      >
        Caught up to {{ compactTime(events[0].timestamp) }}
      </button>
    </header>

    <section v-if="waiting.length" class="waiting-block">
      <header>
        <span>WAITING ON YOU</span>
        <strong>{{ waiting.length }}</strong>
      </header>
      <button
        v-for="issue in waiting"
        :key="issue.id"
        type="button"
        class="waiting-row"
        :data-now-waiting="issue.id"
        @click="$emit('open', issue.id)"
      >
        <span class="waiting-marker">?</span>
        <strong>{{ issue.title || 'Untitled issue' }}</strong>
        <span>{{ issue.waitingFor || (issue.needsDetail ? 'Needs detail' : 'Decision needed') }}</span>
        <span>{{ projectLabel(issue) }}</span>
      </button>
    </section>

    <section v-if="activeAgents.length" class="agent-wire">
      <header>
        <span>AGENTS</span>
        <strong>{{ activeAgents.length }} active</strong>
      </header>
      <button
        v-for="activity in activeAgents"
        :key="activity.id"
        type="button"
        @click="$emit('open-activity', activity.id)"
      >
        <time>{{ compactTime(activity.updatedAt) }}</time>
        <span class="agent-status">{{ statusCode(activity.status) }}</span>
        <strong>{{ activity.title }}</strong>
        <span>{{ activity.status.replace('-', ' ') }}</span>
      </button>
    </section>

    <div v-if="events.length" class="event-wire">
      <template v-for="(event, index) in events" :key="event.id">
        <div v-if="isSeenBoundary(index)" class="seen-divider">
          <span>Since {{ compactTime(seenAt) }}</span>
        </div>
        <article
          class="event-row"
          :class="{ expanded: expanded.includes(event.id) }"
          :data-graph-event="event.id"
        >
          <button
            type="button"
            class="event-main"
            :aria-label="`${event.summary}. ${event.actor?.label || 'Unknown author'}`"
            @click="$emit('open', event.nodeId)"
          >
            <time>{{ compactTime(event.timestamp) }}</time>
            <span class="event-code">{{ eventCode(event.eventType) }}</span>
            <strong>{{ event.summary }}</strong>
            <span class="event-source">{{ sourceLabel(event) }}</span>
            <span class="event-author" :title="event.actor?.label">
              {{ event.actor?.initials || 'EX' }}
            </span>
          </button>
          <button
            v-if="event.changes?.length || event.data?.deliverable"
            type="button"
            class="event-expand"
            :aria-expanded="expanded.includes(event.id)"
            :aria-label="`Inspect ${event.summary}`"
            @click="toggle(event.id)"
          >
            {{ expanded.includes(event.id) ? '−' : '+' }}
          </button>
          <div v-if="expanded.includes(event.id)" class="event-detail">
            <dl v-if="event.changes?.length">
              <div v-for="change in event.changes" :key="change.field">
                <dt>{{ human(change.field) }}</dt>
                <dd>
                  <span>{{ compactValue(change.before) }}</span>
                  <b>→</b>
                  <span>{{ compactValue(change.after) }}</span>
                </dd>
              </div>
            </dl>
            <p v-if="event.data?.deliverable">
              Deliverable · {{ event.data.deliverable.label || event.data.deliverable.path }}
            </p>
            <p class="event-provenance">
              {{ event.actor?.label || 'External edit' }} · {{ event.action }} · revision
              {{ event.graphRevision }}
            </p>
          </div>
        </article>
      </template>
    </div>

    <div v-else class="now-empty">
      <strong>No graph events yet</strong>
      <p>New filings, status changes, evidence, decisions, and overdue work appear here.</p>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  waiting: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  seenAt: { type: String, default: '' },
})

defineEmits(['open', 'open-activity', 'seen'])
const expanded = ref([])
const activeAgents = computed(() => props.activities.filter(activity => (
  activity.kind === 'agent'
  && ['starting', 'working', 'needs-input'].includes(activity.status)
)))
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

function toggle(id) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter(candidate => candidate !== id)
    : [...expanded.value, id]
}

function isSeenBoundary(index) {
  if (!props.seenAt) return false
  const current = props.events[index]
  const previous = props.events[index - 1]
  return current?.timestamp <= props.seenAt
    && (!previous || previous.timestamp > props.seenAt)
}

function compactTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '').slice(11, 16) || '—'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function eventCode(value) {
  return {
    created: 'NEW',
    updated: 'UPD',
    deleted: 'DEL',
    restored: 'RST',
    'status-changed': 'STA',
    'waiting-cleared': 'CLR',
    'deliverable-added': 'OUT',
    'decision-recorded': 'DEC',
    'evidence-captured': 'EVD',
    'next-action-created': 'NXT',
    'became-overdue': 'OVR',
  }[value] || 'CHG'
}

function statusCode(value) {
  return {
    starting: 'STR',
    working: 'RUN',
    'needs-input': 'YOU',
  }[value] || 'IDL'
}

function sourceLabel(event) {
  if (event.nodeKind === 'issue') {
    const project = props.nodes.find(node => (
      node.id === event.nodeId
        ? false
        : node.kind === 'project'
          && props.nodes.find(candidate => candidate.id === event.nodeId)
            ?.relations?.some(edge => edge.relation === 'part_of' && edge.target === node.id)
    ))
    if (project) return project.slug || project.title
  }
  return human(event.nodeKind)
}

function projectLabel(issue) {
  if (!issue.projectId) return ''
  const project = byId.value.get(issue.projectId)
  return project?.slug || project?.title || ''
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
</script>

<style scoped>
.now-view {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  background: var(--color-surface);
}

.now-header {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-rule);
  padding: 8px 13px;
}

.now-header > div {
  display: flex;
  flex-direction: column;
}

.now-kicker,
.waiting-block > header span,
.agent-wire > header span {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.now-header strong {
  margin-top: 3px;
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.now-header button {
  min-height: 26px;
  border: 1px solid var(--color-rule);
  border-radius: 2px;
  padding: 0 8px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 8px;
}

.now-header button:hover,
.now-header button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.waiting-block,
.agent-wire {
  border-bottom: 1px solid var(--color-rule);
}

.waiting-block > header,
.agent-wire > header {
  display: flex;
  min-height: 27px;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule-light);
  background: var(--color-chrome-high);
  padding: 0 12px;
}

.waiting-block > header strong,
.agent-wire > header strong {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 500;
}

.waiting-row {
  display: grid;
  width: 100%;
  min-height: 34px;
  grid-template-columns: 22px minmax(180px, 1fr) minmax(120px, 0.8fr) minmax(80px, 0.4fr);
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 0 12px;
  text-align: left;
}

.waiting-row:hover,
.waiting-row:focus-visible,
.agent-wire button:hover,
.agent-wire button:focus-visible {
  background: var(--color-chrome-mid);
}

.waiting-marker {
  color: var(--color-rem);
  font-family: var(--font-mono);
  font-weight: 700;
}

.waiting-row strong,
.agent-wire button strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 10px;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.waiting-row > span:not(.waiting-marker) {
  overflow: hidden;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-wire button,
.event-main {
  display: grid;
  width: 100%;
  min-height: 32px;
  grid-template-columns: 48px 30px minmax(180px, 1fr) minmax(90px, 0.35fr);
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 0 12px;
  text-align: left;
}

.agent-wire time,
.event-main time,
.agent-status,
.event-code,
.event-source,
.event-author {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}

.agent-status {
  color: var(--color-accent);
  font-weight: 700;
}

.agent-wire button > span:last-child {
  color: var(--color-ink-3);
  font-size: 9px;
}

.event-row {
  position: relative;
  border-bottom: 1px solid var(--color-rule-light);
}

.event-row:hover {
  background: var(--color-chrome-mid);
}

.event-main {
  min-height: 31px;
  grid-template-columns: 48px 30px minmax(190px, 1fr) minmax(70px, 0.3fr) 30px;
  border: 0;
  padding-right: 35px;
}

.event-main strong {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 10px;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-code {
  color: var(--color-ink-3);
  font-weight: 700;
}

.event-row:has(.event-code:nth-child(2)) .event-code {
  font-variant-numeric: tabular-nums;
}

.event-author {
  color: var(--color-ink-3);
  font-weight: 700;
  text-align: right;
}

.event-expand {
  position: absolute;
  top: 3px;
  right: 7px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 1px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
}

.event-expand:hover,
.event-expand:focus-visible {
  background: var(--color-chrome-high);
  color: var(--color-ink);
}

.event-detail {
  border-top: 1px solid var(--color-rule-light);
  background: color-mix(in srgb, var(--color-chrome-high) 72%, var(--color-surface));
  padding: 8px 12px 9px 90px;
}

.event-detail dl {
  display: grid;
  gap: 4px;
}

.event-detail dl > div {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px;
}

.event-detail dt,
.event-detail dd,
.event-detail p {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 8px;
  line-height: 1.5;
}

.event-detail dt {
  color: var(--color-ink-4);
  text-transform: uppercase;
}

.event-detail dd {
  display: flex;
  min-width: 0;
  gap: 6px;
}

.event-detail dd span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-detail dd b {
  color: var(--color-ink-4);
  font-weight: 400;
}

.event-provenance {
  margin-top: 6px;
  color: var(--color-ink-4) !important;
}

.seen-divider {
  display: flex;
  min-height: 25px;
  align-items: center;
  gap: 8px;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 8px;
}

.seen-divider::before,
.seen-divider::after {
  height: 1px;
  flex: 1 1 auto;
  background: var(--color-accent);
  content: '';
  opacity: 0.38;
}

.seen-divider span {
  flex: 0 0 auto;
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

@container business-graph (max-width: 700px) {
  .event-source,
  .waiting-row > span:last-child {
    display: none;
  }

  .event-main {
    grid-template-columns: 42px 28px minmax(150px, 1fr) 28px;
  }

  .waiting-row {
    grid-template-columns: 20px minmax(140px, 1fr) minmax(90px, 0.6fr);
  }
}
</style>
