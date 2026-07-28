<template>
  <section class="project-standing" data-project-standing aria-label="Project standing">
    <div class="standing-strip">
      <div><strong>{{ counts.open }}</strong><span>open</span></div>
      <div :class="{ flagged: counts.waiting > 1 }">
        <strong>{{ counts.waiting }}</strong><span>waiting</span>
      </div>
      <div><strong>{{ counts.done }}</strong><span>done</span></div>
      <div><strong>{{ completion }}%</strong><span>complete</span></div>
    </div>

    <div class="standing-columns">
      <div class="standing-block">
        <h3>Blocked on</h3>
        <template v-if="blockedOn.length">
          <button
            v-for="entry in blockedOn"
            :key="entry.target"
            type="button"
            class="standing-row"
            :data-standing-blocked="entry.target"
            @click="$emit('open-node', entry.issues[0].id)"
          >
            <span class="standing-target">{{ entry.target }}</span>
            <span class="standing-count">×{{ entry.count }}</span>
          </button>
        </template>
        <p v-else class="standing-none">Nothing blocked.</p>

        <template v-if="deliverables.length">
          <h3>Deliverables</h3>
          <button
            v-for="item in deliverables"
            :key="`${item.from}:${item.path}`"
            type="button"
            class="standing-row"
            :data-standing-deliverable="item.path"
            @click="$emit('open-file', item.path)"
          >
            <span class="standing-target">{{ fileName(item.path) }}</span>
            <span class="standing-from">{{ item.from }}</span>
          </button>
        </template>
      </div>

      <div class="standing-block">
        <h3>Recent decisions</h3>
        <template v-if="decisions.length">
          <button
            v-for="decision in decisions"
            :key="decision.id"
            type="button"
            class="standing-row"
            :data-standing-decision="decision.id"
            @click="$emit('open-node', decision.id)"
          >
            <time>{{ shortDate(decision.updatedAt) }}</time>
            <span class="standing-target">{{ decision.title || decision.id }}</span>
          </button>
        </template>
        <p v-else class="standing-none">No decisions recorded yet.</p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  project: { type: Object, required: true },
  nodes: { type: Array, default: () => [] },
})

defineEmits(['open-node', 'open-file'])

const issues = computed(() => props.nodes.filter(node => (
  node.kind === 'issue'
  && (
    node.projectId === props.project.id
    || node.relations?.some(edge => edge.relation === 'part_of' && edge.target === props.project.id)
  )
)))

const counts = computed(() => ({
  open: issues.value.filter(issue => !['done', 'cancelled'].includes(issue.status)).length,
  waiting: issues.value.filter(issue => (
    !['done', 'cancelled'].includes(issue.status)
    && (issue.status === 'waiting' || issue.waitingFor)
  )).length,
  done: issues.value.filter(issue => issue.status === 'done').length,
}))

const completion = computed(() => (
  issues.value.length
    ? Math.round((counts.value.done / issues.value.length) * 100)
    : 0
))

const blockedOn = computed(() => {
  const groups = new Map()
  for (const issue of issues.value) {
    if (['done', 'cancelled'].includes(issue.status)) continue
    if (issue.status !== 'waiting' && !issue.waitingFor) continue
    const target = issue.waitingFor || 'unspecified'
    const group = groups.get(target) || { target, count: 0, issues: [] }
    group.count += 1
    group.issues.push(issue)
    groups.set(target, group)
  }
  return [...groups.values()].sort((left, right) => right.count - left.count)
})

const decisions = computed(() => props.nodes
  .filter(node => (
    node.kind === 'decision'
    && node.relations?.some(edge => edge.relation === 'part_of' && edge.target === props.project.id)
  ))
  .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  .slice(0, 5))

const deliverables = computed(() => {
  const items = []
  for (const path of props.project.properties?.deliverables || []) {
    const value = typeof path === 'string' ? path : path?.path
    if (value) items.push({ path: value, from: 'project' })
  }
  for (const issue of issues.value) {
    for (const path of issue.deliverables || []) {
      items.push({ path, from: issue.title || issue.id })
    }
  }
  return items.slice(0, 6)
})

function fileName(path) {
  return String(path || '').split('/').pop() || path
}

function shortDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}.${month}`
}
</script>

<style scoped>
.project-standing {
  border-bottom: 1px solid var(--color-rule);
  padding: 14px 18px 16px;
}

.standing-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(90px, 1fr));
  border: 1px solid var(--color-rule-light);
}

.standing-strip > div {
  display: flex;
  align-items: baseline;
  gap: 7px;
  border-right: 1px solid var(--color-rule-light);
  padding: 8px 12px;
}

.standing-strip > div:last-child {
  border-right: 0;
}

.standing-strip strong {
  color: var(--color-ink);
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 560;
  font-variant-numeric: tabular-nums;
}

.standing-strip span {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.standing-strip .flagged strong,
.standing-strip .flagged span {
  color: var(--color-rem);
}

.standing-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 24px;
  margin-top: 14px;
}

.standing-block h3 {
  border-bottom: 1px solid var(--color-rule-light);
  padding: 6px 0 5px;
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.standing-block h3:not(:first-child) {
  margin-top: 10px;
}

.standing-row {
  display: flex;
  width: 100%;
  min-height: 28px;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 3px 0;
  text-align: left;
}

.standing-row:hover,
.standing-row:focus-visible {
  background: var(--color-chrome-mid);
}

.standing-row time {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.standing-target {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 540;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.standing-count,
.standing-from {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 140px;
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.standing-none {
  padding: 7px 0;
  color: var(--color-ink-4);
  font-size: 10px;
}

@container business-graph (max-width: 700px) {
  .standing-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
