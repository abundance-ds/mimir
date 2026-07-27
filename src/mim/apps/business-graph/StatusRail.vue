<template>
  <aside class="status-rail" aria-label="Graph status">
    <button
      v-for="(item, index) in readouts"
      :key="item.id"
      type="button"
      :data-status-readout="item.id"
      :data-graph-control="`status-${item.id}`"
      class="status-readout"
      :class="[
        { active: active === item.id, nonzero: item.count > 0 },
        item.tone ? `status-${item.tone}` : '',
      ]"
      :aria-pressed="active === item.id"
      :title="`${item.label} · Alt+${index + 1}`"
      @click="$emit('toggle', item.id)"
    >
      <strong>{{ item.count }}</strong>
      <span>{{ item.short }}</span>
    </button>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import {
  activeAgentActivities,
  RAIL_ISSUE_READOUTS,
} from './railReadouts.js'

const props = defineProps({
  issues: { type: Array, default: () => [] },
  activities: { type: Array, default: () => [] },
  diagnostics: { type: Array, default: () => [] },
  active: { type: String, default: '' },
})

defineEmits(['toggle'])

const readouts = computed(() => [
  ...RAIL_ISSUE_READOUTS.map(readout => ({
    id: readout.id,
    label: readout.label,
    short: readout.short,
    count: props.issues.filter(issue => readout.matches(issue)).length,
    tone: readout.id === 'overdue' ? 'rem' : '',
  })),
  {
    id: 'agents',
    label: 'agents active',
    short: 'agents',
    count: activeAgentActivities(props.activities).length,
    tone: 'accent',
  },
  {
    id: 'diag',
    label: 'diagnostics',
    short: 'diag',
    count: props.diagnostics.length,
    tone: '',
  },
])
</script>

<style scoped>
.status-rail {
  display: flex;
  width: 66px;
  min-width: 66px;
  flex: 0 0 auto;
  flex-direction: column;
  overflow-y: auto;
  background: var(--color-chrome-high);
}

.status-readout {
  display: grid;
  min-height: 50px;
  flex: 0 0 auto;
  place-content: center;
  justify-items: center;
  gap: 2px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 6px 3px;
  color: var(--color-ink-3);
}

.status-readout:hover,
.status-readout:focus-visible {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.status-readout:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.status-readout.active {
  background: var(--color-accent-soft);
  color: var(--color-ink);
}

.status-readout strong {
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 560;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
}

.status-readout span {
  color: inherit;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.01em;
  line-height: 11px;
  text-align: center;
  white-space: nowrap;
}

.status-readout.status-rem.nonzero strong {
  color: var(--color-rem);
}

.status-readout.status-accent.nonzero strong {
  color: var(--color-accent);
}

@container business-graph (max-width: 620px) {
  .status-rail {
    width: 56px;
    min-width: 56px;
  }
}
</style>
