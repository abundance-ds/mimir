<template>
  <aside class="status-rail" aria-label="Business graph status">
    <button
      v-for="(item, index) in readouts"
      :key="item.id"
      type="button"
      :data-status-filter="item.id"
      :data-graph-control="`status-${item.id}`"
      :class="[
        `status-${item.tone}`,
        { active: activeFilter === item.id },
      ]"
      :aria-pressed="activeFilter === item.id"
      :title="`${item.label}: ${item.count}. Alt+${index + 1}`"
      @click="$emit('filter', item.id)"
    >
      <strong>{{ item.count }}</strong>
      <span>{{ item.short }}</span>
    </button>
  </aside>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  issues: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  diagnostics: { type: Array, default: () => [] },
  activeFilter: { type: String, default: '' },
})

defineEmits(['filter'])

const readouts = computed(() => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayValue = dateValue(today)
  const week = new Date(today)
  week.setDate(week.getDate() + 7)
  const weekValue = dateValue(week)
  const open = props.issues.filter(issue => !['done', 'cancelled'].includes(issue.status))
  const agents = props.activities.filter(activity => (
    activity.kind === 'agent'
    && ['starting', 'working', 'needs-input'].includes(activity.status)
  ))
  return [
    {
      id: 'waiting-on-you',
      label: 'Waiting on you',
      short: 'YOU',
      count: open.filter(waitingOnYou).length,
      tone: 'ink',
    },
    {
      id: 'overdue',
      label: 'Overdue',
      short: 'OVER',
      count: open.filter(issue => issue.dueDate && issue.dueDate < todayValue).length,
      tone: 'rem',
    },
    {
      id: 'waiting',
      label: 'Waiting',
      short: 'WAIT',
      count: open.filter(issue => issue.status === 'waiting' || issue.waitingFor).length,
      tone: 'ink',
    },
    {
      id: 'due-soon',
      label: 'Due within seven days',
      short: '7 DAY',
      count: open.filter(issue => (
        issue.dueDate
        && issue.dueDate >= todayValue
        && issue.dueDate <= weekValue
      )).length,
      tone: 'ink',
    },
    {
      id: 'agents',
      label: 'Agents active',
      short: 'AGNT',
      count: agents.length,
      tone: 'accent',
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      short: 'DIAG',
      count: props.diagnostics.length,
      tone: 'rem',
    },
  ]
})

function waitingOnYou(issue) {
  const waiting = String(issue.waitingFor || '').trim().toLowerCase()
  return Boolean(
    issue.needsDetail
    || issue.waitingOnYou
    || ['you', 'me', 'human', 'owner'].includes(waiting),
  )
}

function dateValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
</script>

<style scoped>
.status-rail {
  display: flex;
  width: 48px;
  min-width: 48px;
  flex: 0 0 auto;
  flex-direction: column;
  border-right: 1px solid var(--color-rule);
  background: var(--color-chrome-high);
}

.status-rail button {
  display: grid;
  min-height: 52px;
  place-content: center;
  justify-items: center;
  border-bottom: 1px solid var(--color-rule-light);
  color: var(--color-ink-3);
}

.status-rail button:hover,
.status-rail button:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.status-rail button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.status-rail button.active {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}

.status-rail strong {
  color: currentColor;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 17px;
}

.status-rail span {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 7px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.status-rail .status-rem:not(.active) strong {
  color: var(--color-rem);
}

.status-rail .status-accent:not(.active) strong {
  color: var(--color-accent);
}

.status-rail button strong:empty,
.status-rail button strong:first-child:last-child {
  color: var(--color-ink-4);
}

@container business-graph (max-width: 620px) {
  .status-rail {
    width: 42px;
    min-width: 42px;
  }
}
</style>
