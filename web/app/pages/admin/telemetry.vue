<template>
  <div>
    <!-- Filter bar -->
    <div class="sticky top-12 z-30 bg-white border-b border-stone-200 -mx-6 px-6 py-3 flex items-center gap-2 flex-wrap mb-6">
      <div class="flex gap-1">
        <button
          v-for="r in ranges"
          :key="r.value"
          @click="setRange(r.value)"
          class="text-xs px-2.5 py-1 rounded-full transition-colors"
          :class="range === r.value ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'"
        >{{ r.label }}</button>
      </div>
      <select
        v-model="filterType"
        class="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-700 focus:outline-none focus:border-stone-400"
      >
        <option value="">All event types</option>
        <option v-for="t in eventTypes" :key="t.type" :value="t.type">{{ t.type }} ({{ t.count }})</option>
      </select>
      <select
        v-model="filterPlatform"
        class="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-700 focus:outline-none focus:border-stone-400"
      >
        <option value="">All platforms</option>
        <option v-for="p in platforms" :key="p.platform" :value="p.platform">{{ p.platform }} ({{ p.count }})</option>
      </select>
      <input
        v-model="filterDevice"
        type="text"
        placeholder="Device ID..."
        class="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-700 w-32 focus:outline-none focus:border-stone-400"
      />
    </div>

    <div v-if="pending" class="text-sm text-stone-400">Loading...</div>
    <div v-else-if="error" class="text-sm text-red-600">Failed to load telemetry.</div>
    <template v-else>
      <!-- Stats row -->
      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ uniqueDevices }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Unique Devices</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ d.total ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Total Events</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ todayCount }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Today</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold" :class="errorRate > 0 ? 'text-red-600' : 'text-stone-900'">{{ errorRate }}%</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Error Rate</div>
        </div>
      </div>

      <!-- Daily Active chart -->
      <div class="mb-6" v-if="dailyChartData.length">
        <div class="text-sm font-medium text-stone-700 mb-3">Daily Active Devices</div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <svg :viewBox="`0 0 ${dailyChartData.length * 40} 140`" class="w-full h-[120px]" preserveAspectRatio="none">
            <g v-for="(bar, i) in dailyChartData" :key="bar.date">
              <rect
                :x="i * 40 + 8"
                :y="120 - bar.barH"
                :width="24"
                :height="Math.max(bar.barH, 1)"
                rx="2"
                style="fill: rgb(59 130 246 / 0.8)"
              >
                <title>{{ bar.date }}: {{ bar.count }}</title>
              </rect>
              <text
                :x="i * 40 + 20"
                y="136"
                text-anchor="middle"
                class="fill-stone-400"
                style="font-size: 9px"
              >{{ bar.dayLabel }}</text>
            </g>
          </svg>
        </div>
      </div>

      <!-- Breakdowns -->
      <div class="grid grid-cols-2 gap-6 mb-6">
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Event Type Breakdown</div>
          <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
            <div v-for="t in sortedEventTypes" :key="t.type" class="flex items-center gap-3">
              <span class="text-xs text-stone-600 w-28 flex-shrink-0 truncate" :title="t.type">{{ t.type }}</span>
              <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
                <div class="bg-blue-500 rounded-sm h-4" :style="{ width: barPct(t.count, maxTypeCount) }"></div>
              </div>
              <span class="text-xs font-mono text-stone-700 w-10 text-right flex-shrink-0">{{ t.count }}</span>
            </div>
            <div v-if="!sortedEventTypes.length" class="text-xs text-stone-400">No data</div>
          </div>
        </div>
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Platform Breakdown</div>
          <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
            <div v-for="p in sortedPlatforms" :key="p.platform" class="flex items-center gap-3">
              <span class="text-xs text-stone-600 w-16 flex-shrink-0">{{ p.platform }}</span>
              <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
                <div class="rounded-sm h-4" :class="platformColor(p.platform)" :style="{ width: barPct(p.count, maxPlatformCount) }"></div>
              </div>
              <span class="text-xs font-mono text-stone-700 w-8 text-right flex-shrink-0">{{ p.count }}</span>
            </div>
            <div v-if="!sortedPlatforms.length" class="text-xs text-stone-400">No data</div>
          </div>
        </div>
      </div>

      <!-- Event Log Table -->
      <div class="text-sm font-medium text-stone-700 mb-3">Event Log</div>
      <div class="bg-white rounded-lg border border-stone-200 overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="border-b border-stone-100">
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Time</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Device</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Type</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Version</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Platform</th>
              <th class="text-left text-xs font-medium text-stone-500 uppercase px-4 py-2">Data</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ev in events"
              :key="ev.id"
              class="border-b border-stone-50 hover:bg-stone-50 transition-colors"
            >
              <td class="px-4 py-2 text-sm text-stone-700 font-mono whitespace-nowrap">{{ formatTime(ev.created_at) }}</td>
              <td class="px-4 py-2 text-sm text-stone-700 font-mono">{{ shortDevice(ev.device_id) }}</td>
              <td class="px-4 py-2 text-sm text-stone-700">{{ ev.event_type }}</td>
              <td class="px-4 py-2 text-sm text-stone-700 font-mono">{{ ev.app_version }}</td>
              <td class="px-4 py-2 text-sm text-stone-700">{{ ev.platform }}</td>
              <td class="px-4 py-2 text-sm text-stone-700">
                <template v-if="ev.event_data && Object.keys(ev.event_data).length">
                  <button
                    @click="toggleExpand(ev.id)"
                    class="text-xs text-blue-600 hover:text-blue-800"
                  >{{ expanded[ev.id] ? 'hide' : 'show' }}</button>
                  <pre v-if="expanded[ev.id]" class="mt-1 text-xs bg-stone-50 rounded p-2 overflow-x-auto max-w-xs"><code>{{ JSON.stringify(ev.event_data, null, 2) }}</code></pre>
                </template>
                <span v-else class="text-stone-300">&mdash;</span>
              </td>
            </tr>
            <tr v-if="!events.length">
              <td colspan="6" class="px-4 py-6 text-center text-sm text-stone-400">No events found.</td>
            </tr>
          </tbody>
        </table>
        <div v-if="d.total > 0" class="flex items-center justify-between px-4 py-3 border-t border-stone-100">
          <span class="text-xs text-stone-500">
            Showing {{ (page - 1) * pageSize + 1 }}&ndash;{{ Math.min(page * pageSize, d.total) }} of {{ d.total }}
          </span>
          <div class="flex gap-1">
            <button
              @click="page > 1 && (page--)"
              :disabled="page <= 1"
              class="text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-30"
              :class="page > 1 ? 'bg-stone-100 text-stone-700 hover:bg-stone-200' : 'bg-stone-50 text-stone-300'"
            >Prev</button>
            <button
              @click="page * pageSize < d.total && (page++)"
              :disabled="page * pageSize >= d.total"
              class="text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-30"
              :class="page * pageSize < d.total ? 'bg-stone-100 text-stone-700 hover:bg-stone-200' : 'bg-stone-50 text-stone-300'"
            >Next</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
const ranges = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
]

const range = ref(7)
const filterType = ref('')
const filterPlatform = ref('')
const filterDevice = ref('')
const page = ref(1)
const pageSize = 50
const expanded = reactive({})

function setRange(v) {
  range.value = v
  page.value = 1
}

const queryParams = computed(() => {
  const params = { days: range.value, limit: pageSize, offset: (page.value - 1) * pageSize }
  if (filterType.value) params.type = filterType.value
  if (filterPlatform.value) params.platform = filterPlatform.value
  if (filterDevice.value) params.device = filterDevice.value
  return params
})

const { data, pending, error } = await useFetch('/api/admin/telemetry', {
  query: queryParams,
  watch: [queryParams],
})

const d = computed(() => data.value || {})
const events = computed(() => d.value.events || [])
const eventTypes = computed(() => d.value.eventTypes || [])
const platforms = computed(() => d.value.platforms || [])

const uniqueDevices = computed(() => {
  const ids = new Set(events.value.map(e => e.device_id))
  return ids.size
})

const todayCount = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  const daily = d.value.dailyActive || []
  const entry = daily.find(e => e.date === today)
  return entry?.count ?? 0
})

const errorRate = computed(() => {
  const total = d.value.total || 0
  if (!total) return 0
  const errors = (d.value.eventTypes || []).find(t => t.type === 'error')
  if (!errors) return 0
  return ((errors.count / total) * 100).toFixed(1)
})

const sortedEventTypes = computed(() =>
  [...(d.value.eventTypes || [])].sort((a, b) => b.count - a.count)
)
const maxTypeCount = computed(() =>
  sortedEventTypes.value.length ? sortedEventTypes.value[0].count : 1
)

const sortedPlatforms = computed(() =>
  [...(d.value.platforms || [])].sort((a, b) => b.count - a.count)
)
const maxPlatformCount = computed(() =>
  sortedPlatforms.value.length ? sortedPlatforms.value[0].count : 1
)

const dailyChartData = computed(() => {
  const raw = d.value.dailyActive || []
  const maxCount = Math.max(...raw.map(r => r.count), 1)
  return raw.map(r => ({
    ...r,
    barH: Math.round((r.count / maxCount) * 110),
    dayLabel: new Date(r.date + 'T00:00:00').getDate(),
  }))
})

function barPct(count, max) {
  if (!max) return '0%'
  return Math.round((count / max) * 100) + '%'
}

function platformColor(platform) {
  const p = (platform || '').toLowerCase()
  if (p.includes('mac') || p === 'darwin') return 'bg-blue-500'
  if (p.includes('win')) return 'bg-violet-500'
  if (p.includes('linux')) return 'bg-emerald-500'
  return 'bg-stone-400'
}

function shortDevice(id) {
  if (!id) return '—'
  return id.slice(0, 8) + '...'
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return diffMin + 'm ago'
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return diffH + 'h ago'
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return `${month}-${day} ${hours}:${mins}`
}

function toggleExpand(id) {
  expanded[id] = !expanded[id]
}
</script>
