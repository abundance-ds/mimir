<template>
  <div>
    <div v-if="pending" class="text-sm text-stone-400">Loading...</div>
    <div v-else-if="error" class="text-sm text-red-600">Failed to load stats.</div>
    <template v-else>
      <!-- KPI Cards -->
      <div class="grid grid-cols-4 gap-4 mb-8">
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="flex items-end justify-between">
            <div>
              <div class="text-2xl font-mono font-semibold text-stone-900">{{ s.activeDevices?.today ?? 0 }}</div>
              <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Active Today</div>
            </div>
            <svg v-if="sparkData.length > 1" :viewBox="`0 0 ${sparkData.length * 3} 16`" class="w-10 h-4 flex-shrink-0">
              <rect
                v-for="(d, i) in sparkData"
                :key="i"
                :x="i * 3"
                :y="16 - d.h"
                :width="2"
                :height="d.h"
                rx="0.5"
                class="fill-blue-400"
              />
            </svg>
          </div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ s.activeDevices?.week ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Active 7d</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold text-stone-900">{{ s.totalEvents?.week ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Events 7d</div>
        </div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <div class="text-2xl font-mono font-semibold" :class="(s.errors?.week ?? 0) > 0 ? 'text-red-600' : 'text-stone-900'">{{ s.errors?.week ?? 0 }}</div>
          <div class="text-xs text-stone-500 uppercase tracking-wide mt-1">Errors 7d</div>
        </div>
      </div>

      <!-- Feature Usage -->
      <div class="mb-8" v-if="sortedFeatures.length">
        <div class="text-sm font-medium text-stone-700 mb-3">Feature Usage</div>
        <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
          <div v-for="f in sortedFeatures" :key="f.feature" class="flex items-center gap-3">
            <span class="text-xs text-stone-600 w-28 flex-shrink-0 truncate" :title="f.feature">{{ f.feature }}</span>
            <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
              <div
                class="bg-blue-500 rounded-sm h-4"
                :style="{ width: barWidth(f.count, maxFeatureCount) }"
              ></div>
            </div>
            <span class="text-xs font-mono text-stone-700 w-10 text-right flex-shrink-0">{{ f.count }}</span>
          </div>
        </div>
      </div>

      <!-- Version + Platform -->
      <div class="grid grid-cols-2 gap-6 mb-8">
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Version Distribution</div>
          <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
            <div v-for="v in sortedVersions" :key="v.version" class="flex items-center gap-3">
              <span class="text-xs text-stone-600 w-16 flex-shrink-0 font-mono">{{ v.version }}</span>
              <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
                <div
                  class="bg-blue-500 rounded-sm h-4"
                  :style="{ width: barWidth(v.count, maxVersionCount) }"
                ></div>
              </div>
              <span class="text-xs font-mono text-stone-700 w-8 text-right flex-shrink-0">{{ v.count }}</span>
            </div>
            <div v-if="!sortedVersions.length" class="text-xs text-stone-400">No data</div>
          </div>
        </div>
        <div>
          <div class="text-sm font-medium text-stone-700 mb-3">Platform Split</div>
          <div class="bg-white rounded-lg border border-stone-200 p-4 space-y-2">
            <div v-for="p in sortedPlatforms" :key="p.platform" class="flex items-center gap-3">
              <span class="text-xs text-stone-600 w-16 flex-shrink-0">{{ p.platform }}</span>
              <div class="flex-1 bg-stone-100 rounded-sm h-4 overflow-hidden">
                <div
                  class="rounded-sm h-4"
                  :class="platformColor(p.platform)"
                  :style="{ width: barWidth(p.count, maxPlatformCount) }"
                ></div>
              </div>
              <span class="text-xs font-mono text-stone-700 w-8 text-right flex-shrink-0">{{ p.count }}</span>
            </div>
            <div v-if="!sortedPlatforms.length" class="text-xs text-stone-400">No data</div>
          </div>
        </div>
      </div>

      <!-- Daily Active Devices Chart -->
      <div class="mb-8" v-if="dailyData.length">
        <div class="text-sm font-medium text-stone-700 mb-3">Daily Active Devices (14d)</div>
        <div class="bg-white rounded-lg border border-stone-200 p-4">
          <svg :viewBox="`0 0 ${dailyData.length * 40} 140`" class="w-full h-[120px]" preserveAspectRatio="none">
            <g v-for="(d, i) in dailyData" :key="d.date">
              <rect
                :x="i * 40 + 8"
                :y="120 - d.barH"
                :width="24"
                :height="Math.max(d.barH, 1)"
                rx="2"
                style="fill: rgb(59 130 246 / 0.8)"
              >
                <title>{{ d.date }}: {{ d.count }}</title>
              </rect>
              <text
                :x="i * 40 + 20"
                y="136"
                text-anchor="middle"
                class="fill-stone-400"
                style="font-size: 9px"
              >{{ d.dayLabel }}</text>
            </g>
          </svg>
        </div>
      </div>

      <!-- Recent Errors -->
      <div v-if="(s.errors?.week ?? 0) > 0" class="bg-white rounded-lg border border-stone-200 p-4">
        <div class="flex items-center gap-2 mb-2">
          <span class="w-2 h-2 rounded-full bg-red-500"></span>
          <span class="text-sm font-medium text-stone-700">Recent Errors</span>
        </div>
        <NuxtLink to="/admin/telemetry" class="text-sm text-blue-600 hover:text-blue-800">
          Check Telemetry tab for details &rarr;
        </NuxtLink>
      </div>
    </template>
  </div>
</template>

<script setup>
const { data, pending, error } = await useFetch('/api/admin/stats')

const s = computed(() => data.value || {})

const sortedFeatures = computed(() =>
  [...(s.value.featureUsage || [])].sort((a, b) => b.count - a.count)
)
const maxFeatureCount = computed(() =>
  sortedFeatures.value.length ? sortedFeatures.value[0].count : 1
)

const sortedVersions = computed(() =>
  [...(s.value.versions || [])].sort((a, b) => b.count - a.count)
)
const maxVersionCount = computed(() =>
  sortedVersions.value.length ? sortedVersions.value[0].count : 1
)

const sortedPlatforms = computed(() =>
  [...(s.value.platforms || [])].sort((a, b) => b.count - a.count)
)
const maxPlatformCount = computed(() =>
  sortedPlatforms.value.length ? sortedPlatforms.value[0].count : 1
)

const dailyData = computed(() => {
  const raw = s.value.dailyActive || []
  const maxCount = Math.max(...raw.map(d => d.count), 1)
  return raw.map(d => ({
    ...d,
    barH: Math.round((d.count / maxCount) * 110),
    dayLabel: new Date(d.date + 'T00:00:00').getDate(),
  }))
})

const sparkData = computed(() => {
  const raw = s.value.dailyActive || []
  const maxCount = Math.max(...raw.map(d => d.count), 1)
  return raw.slice(-14).map(d => ({
    h: Math.max(Math.round((d.count / maxCount) * 14), 1),
  }))
})

function barWidth(count, max) {
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
