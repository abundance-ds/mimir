<template>
  <div>
    <!-- Browser mode notice -->
    <div v-if="!isTauri" class="browser-notice">
      <IconInfoCircle :size="14" />
      <span>Audit logging requires the desktop app.</span>
    </div>

    <template v-else>
      <!-- Hero: event count -->
      <div class="audit-hero">
        <div class="period-select">
          <div class="segmented-control">
            <button
              v-for="p in periods"
              :key="p.id"
              class="segmented-btn"
              :class="{ 'segmented-active': activePeriod === p.id }"
              @click="selectPeriod(p.id)"
            >{{ p.label }}</button>
          </div>
        </div>
        <div class="hero-value">{{ summary.total_events }}</div>
        <div class="hero-subtitle">events recorded</div>
        <div v-if="summary.by_type.length" class="hero-breakdown">
          <span v-for="t in topTypes" :key="t.event_type" class="hero-type">
            {{ t.count }} {{ formatTypeName(t.event_type) }}
          </span>
        </div>
      </div>

      <!-- Filter bar -->
      <div class="section-title" style="margin-top: 20px">Event Log</div>
      <div class="audit-filters">
        <select v-model="filterProject" class="audit-select">
          <option value="">All projects</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="filterType" class="audit-select">
          <option value="">All types</option>
          <option value="ai.request">AI requests</option>
          <option value="tool.execute">Tool calls</option>
          <option value="export.run">Exports</option>
          <option value="session.create">Sessions</option>
        </select>
      </div>

      <!-- Event list -->
      <div class="audit-list">
        <div v-for="ep in displayEpisodes" :key="ep.id" class="audit-row">
          <div class="audit-row-main">
            <span class="audit-row-summary">{{ ep.summary }}</span>
            <span class="audit-row-time">{{ formatRelativeTime(ep.timestamp) }}</span>
          </div>
          <div v-if="ep.events.length > 1" class="audit-row-count">
            {{ ep.events.length }} events
          </div>
        </div>
        <div v-if="!displayEpisodes.length" class="audit-empty">
          No events match the current filters
        </div>
      </div>

      <!-- Export -->
      <div class="section-title" style="margin-top: 20px">Export</div>
      <div class="setting-row last">
        <div class="setting-label">
          Download audit log
          <span class="setting-desc">CSV export of all events for the selected period</span>
        </div>
        <button class="audit-export-btn" @click="exportCsv">Export CSV</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { IconInfoCircle } from '@tabler/icons-vue'
import { useProjectStore } from '../../../stores/panel/projects.js'
import {
  queryAudit,
  queryAuditSummary,
  exportAuditCsv,
  groupIntoEpisodes,
  relativeTime,
} from '../../../services/audit.js'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
const projStore = useProjectStore()

const summary = ref({ total_events: 0, by_type: [] })
const events = ref([])
const activePeriod = ref('month')
const filterProject = ref('')
const filterType = ref('')

const periods = [
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'all', label: 'All Time' },
]

const projects = computed(() => projStore.projects || [])

const topTypes = computed(() => summary.value.by_type.slice(0, 4))

const displayEpisodes = computed(() => {
  let filtered = events.value
  if (filterType.value) {
    filtered = filtered.filter(e => e.event_type === filterType.value)
  }
  return groupIntoEpisodes(filtered).slice(0, 100)
})

function periodRange(periodId) {
  const now = new Date()
  if (periodId === 'week') {
    const from = new Date(now - 7 * 86400000).toISOString()
    return { from }
  }
  if (periodId === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    return { from }
  }
  return {}
}

async function loadData() {
  if (!isTauri) return
  const range = periodRange(activePeriod.value)
  const projectId = filterProject.value || undefined

  const [sumData, evtData] = await Promise.all([
    queryAuditSummary({ projectId, ...range }),
    queryAudit({ projectId, limit: 500, ...range }),
  ])

  summary.value = sumData
  events.value = evtData
}

function selectPeriod(id) {
  activePeriod.value = id
  loadData()
}

watch(filterProject, loadData)

function formatTypeName(type) {
  const map = {
    'ai.request': 'AI calls',
    'ai.complete': 'completions',
    'tool.execute': 'tool calls',
    'export.run': 'exports',
    'session.create': 'sessions',
  }
  return map[type] || type.replace(/\./g, ' ')
}

function formatRelativeTime(ts) {
  return relativeTime(ts)
}

async function exportCsv() {
  if (!isTauri) return
  const range = periodRange(activePeriod.value)
  const csv = await exportAuditCsv({ projectId: filterProject.value || undefined, ...range })
  if (!csv) return

  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { invoke } = await import('@tauri-apps/api/core')
    const filePath = await save({
      defaultPath: `audit-export-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (filePath) {
      await invoke('write_text_file', { path: filePath, content: csv })
    }
  } catch (e) {
    console.warn('[audit] export save failed:', e)
  }
}

onMounted(loadData)
</script>

<style scoped>
/* Hero */
.audit-hero {
  display: flex; flex-direction: column; align-items: center;
  padding: 16px 0;
}
.period-select { margin-bottom: 12px; }
.hero-value {
  font-family: var(--font-mono); font-size: 32px; font-weight: 600;
  color: var(--color-ink); letter-spacing: -0.5px; line-height: 1.1;
}
.hero-subtitle {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
  margin-top: 4px;
}
.hero-breakdown {
  display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; justify-content: center;
}
.hero-type {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
}

/* Filters */
.audit-filters {
  display: flex; gap: 8px; margin-bottom: 10px;
}
.audit-select {
  font-family: var(--font-sans); font-size: 10.5px; color: var(--color-ink-2);
  background: var(--color-chrome-mid); border: 1px solid var(--color-rule-light);
  border-radius: 4px; padding: 4px 8px; outline: none;
}
.audit-select:focus { border-color: var(--color-accent); }

/* Event list */
.audit-list {
  border: 1px solid var(--color-rule-light); border-radius: 6px;
  max-height: 240px; overflow-y: auto;
}
.audit-list::-webkit-scrollbar { width: 3px; }
.audit-list::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }

.audit-row {
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-rule-light);
}
.audit-row:last-child { border-bottom: none; }
.audit-row-main {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.audit-row-summary {
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.audit-row-time {
  font-family: var(--font-mono); font-size: 9.5px; color: var(--color-ink-3);
  flex-shrink: 0;
}
.audit-row-count {
  font-family: var(--font-mono); font-size: 9px; color: var(--color-ink-3);
  margin-top: 2px;
}
.audit-empty {
  padding: 16px; text-align: center;
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
}

/* Export button */
.audit-export-btn {
  font-family: var(--font-sans); font-size: 10.5px; font-weight: 500;
  color: var(--color-accent); padding: 4px 12px; border-radius: 4px;
  border: 1px solid var(--color-accent); background: transparent;
}
.audit-export-btn:hover { background: var(--color-accent-soft); }

/* Browser notice (same as UsageSection) */
.browser-notice {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-3);
  background: var(--color-chrome-mid); border: 1px solid var(--color-rule-light);
  border-radius: 6px; padding: 14px;
}
</style>
