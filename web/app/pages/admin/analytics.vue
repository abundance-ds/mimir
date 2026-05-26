<template>
  <div>
    <!-- Date range -->
    <div class="flex gap-1 mb-6">
      <button
        v-for="r in ranges"
        :key="r.value"
        @click="setRange(r.value)"
        class="text-xs px-2.5 py-1 rounded-full transition-colors"
        :class="range === r.value ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'"
      >{{ r.label }}</button>
    </div>

    <div v-if="pending" class="text-sm text-stone-400">Loading...</div>
    <div v-else-if="error" class="text-sm text-red-600">Failed to load analytics.</div>
    <template v-else>
      <!-- Summary cards -->
      <div class="grid grid-cols-4 gap-4 mb-8">
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ summary.totalViews ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Total Views</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ summary.uniquePaths ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Unique Pages</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ summary.downloads ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Downloads</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ summary.avgDuration ?? 0 }}s</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Avg Duration</div>
        </div>
      </div>

      <!-- Daily Views chart -->
      <div class="mb-8" v-if="dailyChartData.length">
        <div class="text-sm font-medium text-stone-700 mb-3">Daily Views</div>
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

      <!-- Three-column grid -->
      <div class="grid grid-cols-3 gap-6">
        <!-- Top Pages -->
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Top Pages</div>
          <div class="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <table class="w-full">
              <thead>
                <tr class="border-b border-stone-100">
                  <th class="text-left text-xs font-medium text-stone-500 uppercase px-3 py-2">Path</th>
                  <th class="text-right text-xs font-medium text-stone-500 uppercase px-3 py-2">Views</th>
                  <th class="text-right text-xs font-medium text-stone-500 uppercase px-3 py-2">Avg(s)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pg in topPages" :key="pg.path" class="border-b border-stone-50 hover:bg-stone-50">
                  <td class="px-3 py-2 text-sm text-stone-700 font-mono">{{ pg.path }}</td>
                  <td class="px-3 py-2 text-sm text-stone-700 font-mono text-right">{{ pg.count }}</td>
                  <td class="px-3 py-2 text-sm text-stone-700 font-mono text-right">{{ pg.avgDuration }}</td>
                </tr>
                <tr v-if="!topPages.length">
                  <td colspan="3" class="px-3 py-4 text-center text-sm text-stone-400">No data</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Downloads by Platform -->
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Downloads by Platform</div>
          <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
            <div v-for="dl in sortedDownloads" :key="dl.platform" class="flex items-center gap-3">
              <span class="text-xs text-stone-600 w-16 flex-shrink-0">{{ dl.platform }}</span>
              <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
                <div
                  class="rounded-sm h-4"
                  :class="platformColor(dl.platform)"
                  :style="{ width: barPct(dl.count, maxDownloadCount) }"
                ></div>
              </div>
              <span class="text-xs font-mono text-stone-700 w-8 text-right flex-shrink-0">{{ dl.count }}</span>
            </div>
            <div v-if="!sortedDownloads.length" class="text-xs text-stone-400">No data</div>
          </div>
        </div>

        <!-- Top Referrers -->
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Top Referrers</div>
          <div class="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <table class="w-full">
              <thead>
                <tr class="border-b border-stone-100">
                  <th class="text-left text-xs font-medium text-stone-500 uppercase px-3 py-2">Domain</th>
                  <th class="text-right text-xs font-medium text-stone-500 uppercase px-3 py-2">Count</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ref in topReferrers" :key="ref.domain" class="border-b border-stone-50 hover:bg-stone-50">
                  <td class="px-3 py-2 text-sm text-stone-700">{{ ref.domain }}</td>
                  <td class="px-3 py-2 text-sm text-stone-700 font-mono text-right">{{ ref.count }}</td>
                </tr>
                <tr v-if="!topReferrers.length">
                  <td colspan="2" class="px-3 py-4 text-center text-sm text-stone-400">No data</td>
                </tr>
              </tbody>
            </table>
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

function setRange(v) {
  range.value = v
}

const queryParams = computed(() => {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - range.value)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
})

const { data, pending, error } = await useFetch('/api/admin/analytics', {
  query: queryParams,
  watch: [queryParams],
})

const d = computed(() => data.value || {})
const summary = computed(() => d.value.summary || {})
const topPages = computed(() => d.value.topPages || [])
const topReferrers = computed(() => d.value.topReferrers || [])

const sortedDownloads = computed(() =>
  [...(d.value.downloadsByPlatform || [])].sort((a, b) => b.count - a.count)
)
const maxDownloadCount = computed(() =>
  sortedDownloads.value.length ? sortedDownloads.value[0].count : 1
)

const dailyChartData = computed(() => {
  const raw = d.value.dailyViews || []
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
</script>
