<template>
  <div class="rail-panel" :data-rail-panel="kind">
    <template v-if="kind === 'agents'">
      <button
        v-for="activity in activities"
        :key="activity.id"
        type="button"
        :data-rail-agent="activity.id"
        class="rail-panel-row"
        @click="$emit('open-activity', activity.id)"
      >
        <span class="rail-panel-state" :class="`state-${activity.status}`">
          {{ human(activity.status) }}
        </span>
        <strong>{{ activity.title || activity.id }}</strong>
        <time>{{ compactTime(activity.updatedAt) }}</time>
      </button>
      <div v-if="!activities.length" class="rail-panel-empty">
        <h2>No agents active</h2>
        <p>Launched Codex, Claude, and Pi sessions report here while they work.</p>
      </div>
    </template>

    <template v-else>
      <button
        v-for="(diagnostic, index) in diagnostics"
        :key="`${diagnostic.code}:${index}`"
        type="button"
        :data-rail-diagnostic="diagnostic.nodeId || index"
        class="rail-panel-row"
        :disabled="!diagnostic.nodeId"
        @click="diagnostic.nodeId && $emit('open-node', diagnostic.nodeId)"
      >
        <span class="rail-panel-state" :class="`level-${diagnostic.level}`">
          {{ human(diagnostic.level || 'info') }}
        </span>
        <strong>{{ diagnostic.message }}</strong>
        <span class="rail-panel-meta">{{ diagnostic.code }}</span>
      </button>
      <div v-if="!diagnostics.length" class="rail-panel-empty">
        <h2>No diagnostics</h2>
        <p>Sources parsed cleanly across all mounted scopes.</p>
      </div>
    </template>
  </div>
</template>

<script setup>
defineProps({
  kind: { type: String, default: 'agents' },
  activities: { type: Array, default: () => [] },
  diagnostics: { type: Array, default: () => [] },
})

defineEmits(['open-activity', 'open-node'])

function compactTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function human(value) {
  return String(value || '').replaceAll('-', ' ')
}
</script>

<style scoped>
.rail-panel {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  background: var(--color-surface);
}

.rail-panel-row {
  display: grid;
  width: 100%;
  min-height: 38px;
  grid-template-columns: 86px minmax(200px, 1fr) auto;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-rule-light);
  padding: 4px 14px;
  text-align: left;
}

.rail-panel-row:hover:not(:disabled),
.rail-panel-row:focus-visible {
  background: var(--color-chrome-mid);
}

.rail-panel-row:disabled {
  cursor: default;
}

.rail-panel-state {
  color: var(--color-ink-3);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.rail-panel-state.state-working,
.rail-panel-state.state-starting {
  color: var(--color-accent);
}

.rail-panel-state.level-error,
.rail-panel-state.level-warning {
  color: var(--color-rem);
}

.rail-panel-row strong {
  overflow: hidden;
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-panel-row time,
.rail-panel-meta {
  color: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.rail-panel-empty {
  display: grid;
  min-height: 300px;
  place-content: center;
  justify-items: center;
  padding: 30px;
  text-align: center;
}

.rail-panel-empty h2 {
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 650;
}

.rail-panel-empty p {
  max-width: 390px;
  margin-top: 5px;
  color: var(--color-ink-3);
  font-size: 10px;
  line-height: 1.5;
}
</style>
