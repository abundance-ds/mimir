<template>
  <section class="ph-section">
    <button class="ph-label ph-label--toggle" @click="toggleCollapsed">
      <span>Activity</span>
      <IconChevronRight :size="11" class="ph-collapse-icon" :class="!collapsed && 'ph-collapse-icon--open'" />
    </button>

    <template v-if="!collapsed">
    <div v-if="auditStats.totalEvents > 0" class="ph-compliance">
      <span class="ph-pill" :class="reviewCoverageClass">
        {{ reviewCoverage }}% reviewed
      </span>
      <span class="ph-pill" :class="modelConsistencyClass">
        {{ modelCount }} model{{ modelCount === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- Activity timeline -->
    <div v-if="activityEpisodes.length" class="ph-activity">
      <template v-for="(group, gi) in groupedEpisodes" :key="gi">
        <div class="ph-time-group">{{ group.label }}</div>
        <button
          v-for="ep in group.episodes"
          :key="ep.id"
          class="ph-episode"
          :class="{ expanded: expandedEpisode === ep.id }"
          @click="expandedEpisode = expandedEpisode === ep.id ? null : ep.id"
        >
          <div class="ph-episode-main">
            <component :is="episodeIcon(ep)" :size="12" class="ph-episode-icon" />
            <span class="ph-episode-summary">{{ ep.summary }}</span>
            <span class="ph-episode-time">{{ formatRelativeTime(ep.timestamp) }}</span>
          </div>
          <div v-if="expandedEpisode === ep.id" class="ph-episode-detail">
            <div v-for="ev in ep.events" :key="ev.id" class="ph-event-row">
              <span class="ph-event-type">{{ ev.event_type }}</span>
              <span class="ph-event-actor">{{ ev.actor || 'user' }}</span>
              <span class="ph-event-time">{{ formatTime(ev.timestamp) }}</span>
            </div>
          </div>
        </button>
      </template>
      <button
        v-if="hasMoreActivity"
        class="ph-show-more"
        @click="loadMoreActivity"
      >Show more activity</button>
    </div>
    <p v-else class="ph-hint">No activity recorded yet</p>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { IconMessageCircle, IconTool, IconFileExport, IconCirclePlus, IconChevronRight } from '@tabler/icons-vue'
import { queryAudit, groupIntoEpisodes, relativeTime, getTimeGroup } from '../../../services/audit.js'

const props = defineProps({
  projectId: { type: String, required: true },
})

// Activity / Audit
const activityEvents = ref([])
const activityEpisodes = ref([])
const auditStats = ref({ totalEvents: 0, byType: {} })
const expandedEpisode = ref(null)
const activityLimit = ref(20)
const hasMoreActivity = ref(false)
const collapsed = ref(true)

// ---- Activity / Audit ----

const reviewCoverage = computed(() => {
  const toolEvents = activityEvents.value.filter(e => e.event_type === 'tool.execute')
  if (!toolEvents.length) return 100
  const approved = toolEvents.filter(e => {
    try { return JSON.parse(e.payload || '{}').approvalDecision === 'user_approved' }
    catch { return false }
  })
  return Math.round((approved.length / toolEvents.length) * 100)
})

const reviewCoverageClass = computed(() =>
  reviewCoverage.value >= 80 ? 'ph-pill--good' : 'ph-pill--warn'
)

const modelCount = computed(() => {
  const models = new Set(
    activityEvents.value
      .filter(e => e.actor?.startsWith('ai:'))
      .map(e => e.actor)
  )
  return models.size || 0
})

const modelConsistencyClass = computed(() =>
  modelCount.value <= 1 ? 'ph-pill--good' : 'ph-pill--warn'
)

const groupedEpisodes = computed(() => {
  const groups = new Map()
  for (const ep of activityEpisodes.value) {
    const label = getTimeGroup(ep.timestamp)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(ep)
  }
  return [...groups.entries()].map(([label, episodes]) => ({ label, episodes }))
})

function episodeIcon(ep) {
  const types = ep.events.map(e => e.event_type)
  if (types.some(t => t.startsWith('ai.'))) return IconMessageCircle
  if (types.some(t => t.startsWith('tool.'))) return IconTool
  if (types.some(t => t.startsWith('export.'))) return IconFileExport
  return IconCirclePlus
}

function formatRelativeTime(ts) {
  return relativeTime(ts)
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function loadActivity() {
  const events = await queryAudit({ projectId: props.projectId, limit: activityLimit.value + 1 })
  hasMoreActivity.value = events.length > activityLimit.value
  activityEvents.value = events.slice(0, activityLimit.value)
  activityEpisodes.value = groupIntoEpisodes(activityEvents.value)
}

function loadMoreActivity() {
  activityLimit.value += 20
  loadActivity()
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  if (!collapsed.value && activityEvents.value.length === 0) {
    loadActivity()
  }
}
</script>

<style scoped>
.ph-section {
  padding: 14px 2px; border-top: 1px solid var(--color-rule-light);
}
.ph-label {
  display: block;
  font-family: var(--font-sans); font-size: 11px; font-weight: 500;
  color: var(--color-ink-3); text-transform: uppercase; letter-spacing: 0.03em;
  margin-bottom: 6px;
}
.ph-label--toggle {
  display: flex; align-items: center; gap: 4px;
  width: 100%; text-align: left;
}
.ph-label--toggle:hover { color: var(--color-ink-2); }
.ph-collapse-icon {
  color: var(--color-ink-3); transition: transform 150ms ease;
}
.ph-collapse-icon--open { transform: rotate(90deg); }
.ph-hint {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
  margin: 0 0 6px;
}

/* Compliance pills */
.ph-compliance {
  display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;
}
.ph-pill {
  font-family: var(--font-mono); font-size: 10px; font-weight: 500;
  padding: 2px 8px; border-radius: 100px;
  border: 1px solid var(--color-rule-light);
  color: var(--color-ink-3); background: var(--color-chrome-mid);
}
.ph-pill--good {
  color: var(--color-accent); border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.ph-pill--warn {
  color: var(--color-ink-2); border-color: var(--color-rule);
}

/* Activity timeline */
.ph-activity {
  display: flex; flex-direction: column; gap: 0;
}
.ph-time-group {
  font-family: var(--font-sans); font-size: 9px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 1px;
  color: var(--color-ink-3); padding: 8px 0 4px;
}
.ph-time-group:first-child { padding-top: 0; }

.ph-episode {
  display: flex; flex-direction: column;
  padding: 6px 8px; border-radius: 4px;
  text-align: left; width: 100%;
}
.ph-episode:hover { background: var(--color-chrome-mid); }
.ph-episode.expanded { background: var(--color-chrome-mid); }

.ph-episode-main {
  display: flex; align-items: center; gap: 8px; min-width: 0;
}
.ph-episode-icon {
  flex-shrink: 0; color: var(--color-ink-3);
}
.ph-episode-summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-sans); font-size: 11px; color: var(--color-ink-2);
}
.ph-episode-time {
  flex-shrink: 0;
  font-family: var(--font-mono); font-size: 9.5px; color: var(--color-ink-3);
}

/* Expanded episode detail */
.ph-episode-detail {
  margin-top: 4px; padding: 4px 0 2px 20px;
  border-left: 1px solid var(--color-rule-light);
  margin-left: 5px;
}
.ph-event-row {
  display: flex; align-items: center; gap: 8px;
  padding: 2px 0;
  font-family: var(--font-mono); font-size: 9.5px; color: var(--color-ink-3);
}
.ph-event-type { min-width: 80px; }
.ph-event-actor { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ph-event-time { flex-shrink: 0; }

.ph-show-more {
  font-family: var(--font-sans); font-size: 10px; color: var(--color-accent);
  padding: 6px 0; text-align: center;
}
.ph-show-more:hover {
  background: var(--color-chrome-mid);
  border-radius: 3px;
}
</style>
