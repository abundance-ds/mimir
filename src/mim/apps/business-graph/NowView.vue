<template>
  <section data-graph-now class="now-view" aria-label="Now">
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
      <span>{{ unseenCount }} since {{ compactTime(seenAt) }}</span>
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
              @click="$emit('open', item.event.nodeId)"
            >
              <time>{{ compactTime(item.event.timestamp) }}</time>
              <span class="now-author" :title="item.event.actor?.label || 'External edit'">
                {{ item.event.actor?.initials || 'EX' }}
              </span>
              <strong>{{ item.event.summary }}</strong>
              <span class="now-row-context">{{ sourceLabel(item.event) }}</span>
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
                {{ item.event.actor?.label || 'External edit' }}
                · {{ item.event.action }}
                · revision {{ item.event.graphRevision }}
              </p>
            </div>
          </article>
        </template>
      </template>
    </div>

    <div v-else-if="!waiting.length" class="now-empty">
      <strong>No graph events yet</strong>
      <p>Filings, status changes, decisions, evidence, and overdue work appear here.</p>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { IconChevronDown } from '@tabler/icons-vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  waiting: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },
  seenAt: { type: String, default: '' },
})

const emit = defineEmits(['open', 'seen'])
const expanded = ref([])
const byId = computed(() => new Map(props.nodes.map(node => [node.id, node])))

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
  return Boolean(event.changes?.length || event.data?.deliverable)
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
  min-height: 30px;
  grid-template-columns: 44px 26px minmax(240px, 1fr) minmax(80px, 0.25fr) 24px;
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

.now-author {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
}

.now-event-main strong {
  overflow: hidden;
  color: var(--color-ink-2);
  font-size: 11px;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-event-main:hover strong {
  color: var(--color-ink);
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

@container business-graph (max-width: 700px) {
  .now-row-context,
  .now-waiting-reason {
    display: none;
  }

  .now-event-main {
    grid-template-columns: 42px 24px minmax(150px, 1fr) 24px;
  }

  .now-waiting-row {
    grid-template-columns: minmax(150px, 1fr) minmax(100px, 0.5fr);
  }
}
</style>
