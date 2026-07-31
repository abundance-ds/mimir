<template>
  <section
    ref="root"
    data-tracker-app
    :data-tracker-mode="tracker.mode"
    class="tracker-app flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    tabindex="-1"
  >
    <header class="shrink-0 border-b border-rule bg-chrome-high">
      <div class="flex min-h-10 items-center gap-2 px-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class="status-mark size-2 shrink-0 border border-rule" :class="`status-${tracker.mode}`" />
          <div class="min-w-0">
            <h1 class="truncate text-[11px] font-semibold">Tracker</h1>
            <p class="truncate font-mono text-[9px] text-ink-4">{{ statusLine }}</p>
          </div>
        </div>

        <div v-if="tracker.enabled" class="ml-auto flex items-center">
          <button
            type="button"
            data-tracker-pause
            class="h-7 border border-rule px-2 text-[9px] font-semibold text-ink-2 hover:border-accent/50 hover:bg-accent-soft"
            @click="toggleArmed"
          >
            {{ tracker.armed ? 'Pause' : 'Resume' }}
          </button>
          <button
            v-if="tracker.mode !== 'break'"
            type="button"
            data-tracker-start-break
            class="-ml-px h-7 border border-rule px-2 text-[9px] font-semibold text-ink-2 hover:border-accent/50 hover:bg-accent-soft"
            @click="startBreak(20)"
          >
            Break 20m
          </button>
          <button
            v-else
            type="button"
            data-tracker-end-break
            class="-ml-px h-7 border border-accent/40 bg-accent-soft px-2 text-[9px] font-semibold text-accent hover:bg-chrome-mid"
            @click="endBreak"
          >
            End break · {{ duration(tracker.status.breakRemainingSeconds || 0) }}
          </button>
          <button
            type="button"
            title="Refresh tracker data"
            aria-label="Refresh tracker data"
            :disabled="loading"
            class="ml-1 grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink disabled:opacity-40"
            @click="refreshAll"
          >
            <IconRefresh :size="13" :class="{ 'motion-safe:animate-spin': loading }" />
          </button>
        </div>
      </div>

      <div v-if="tracker.enabled" class="flex min-h-9 flex-wrap items-center border-t border-rule-light">
        <nav class="flex self-stretch" aria-label="Tracker range">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            :data-tracker-tab="tab.id"
            :aria-current="selectedTab === tab.id ? 'page' : undefined"
            class="min-w-[52px] border-r border-rule-light px-3 font-mono text-[9px] font-semibold text-ink-3 hover:bg-chrome-mid hover:text-ink"
            :class="{ 'bg-surface text-accent': selectedTab === tab.id }"
            @click="selectTab(tab.id)"
          >
            {{ tab.label }}
          </button>
        </nav>

        <div v-if="selectedTab !== 'classifications'" class="ml-auto flex h-7 items-center pr-2">
          <button
            v-if="selectedTab !== 'all'"
            type="button"
            aria-label="Previous range"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="moveRange(-1)"
          >
            <IconChevronLeft :size="13" />
          </button>
          <button
            type="button"
            data-tracker-range-label
            class="h-7 min-w-[120px] px-2 text-center font-mono text-[9px] text-ink-2 hover:bg-chrome-mid"
            @click="goToday"
          >
            {{ rangeTitle }}
          </button>
          <button
            v-if="selectedTab !== 'all'"
            type="button"
            aria-label="Next range"
            class="grid size-7 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink"
            @click="moveRange(1)"
          >
            <IconChevronRight :size="13" />
          </button>
        </div>
      </div>
    </header>

    <div
      v-if="tracker.error || error"
      data-tracker-error
      class="flex shrink-0 items-start gap-2 border-b border-rem/25 bg-rem/5 px-3 py-2 text-[9px] text-rem"
      role="alert"
    >
      <IconAlertTriangle :size="12" class="mt-px shrink-0" />
      <span class="min-w-0 flex-1">{{ error || tracker.error }}</span>
      <button type="button" class="font-semibold" @click="error = ''">Dismiss</button>
    </div>

    <div
      v-if="tracker.enabled && tracker.mode === 'needs-access'"
      data-tracker-access-banner
      class="flex shrink-0 items-start gap-3 border-b border-rem/25 bg-rem/5 px-3 py-2"
    >
      <IconLockAccess :size="14" class="mt-px shrink-0 text-rem" />
      <div class="min-w-0 flex-1">
        <p class="text-[9px] font-semibold text-ink">Tracker is armed but waiting for Accessibility</p>
        <p class="mt-0.5 text-[9px] text-ink-3">Grant Mimir access in macOS settings, then return here. Collection begins without a restart.</p>
      </div>
      <button
        type="button"
        class="h-6 shrink-0 border border-rem/35 px-2 text-[9px] font-semibold text-rem hover:bg-rem/10"
        @click="requestAccess"
      >
        Open settings
      </button>
    </div>

    <div v-if="!tracker.enabled" class="grid min-h-0 flex-1 place-items-center px-6 text-center">
      <div class="max-w-md border-y border-rule py-8">
        <IconClockPlay :size="24" class="mx-auto text-ink-4" />
        <h2 class="mt-3 text-[12px] font-semibold">Tracker is off</h2>
        <p class="mt-1 text-[9px] leading-relaxed text-ink-3">
          Enabling starts the native collector and adds its menu-bar control. Nothing is sampled while off.
        </p>
        <button
          type="button"
          data-tracker-enable-empty
          class="mt-4 h-8 border border-accent/40 bg-accent px-3 text-[9px] font-semibold text-accent-ink hover:bg-accent-2"
          @click="enable"
        >
          Enable Tracker
        </button>
      </div>
    </div>

    <TrackerClassifications
      v-else-if="selectedTab === 'classifications'"
      :rules="rules"
      :save-rule="saveClassification"
      @saved="loadClassifications"
    />

    <main v-else class="min-h-0 flex-1 overflow-y-auto" data-tracker-report>
      <TrackerTimeline
        v-if="selectedTab === 'day'"
        :blocks="timelineBlocks"
        :start-ms="range.startMs"
        :end-ms="range.endMs"
        :now-ms="now"
        @select="selectedBlock = $event"
      />

      <aside
        v-if="selectedBlock"
        data-tracker-block-inspector
        class="grid border-b border-rule bg-accent-soft/40 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div class="min-w-0">
          <p class="truncate text-[9px] font-semibold text-ink">
            {{ selectedBlock.appName || selectedBlock.activity }}
            <span class="font-normal text-ink-3">· {{ selectedBlock.subcategory || selectedBlock.domain || selectedBlock.offReason || 'No detail' }}</span>
          </p>
          <p class="mt-0.5 truncate font-mono text-[9px] text-ink-4">
            {{ dateTime(selectedBlock.startMs) }} → {{ dateTime(selectedBlock.endMs) }} ·
            {{ duration(selectedBlock.durationSeconds) }} · {{ selectedBlock.source }}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close block detail"
          class="absolute right-2 grid size-6 place-items-center text-ink-3 hover:bg-chrome-mid sm:static"
          @click="selectedBlock = null"
        >
          <IconX :size="12" />
        </button>
      </aside>

      <TrackerOverview :report="report" />
      <TrackerLog
        :page="page"
        :search="search"
        @select="selectedBlock = $event"
        @search="setSearch"
        @page="setOffset"
      />
    </main>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconClockPlay,
  IconLockAccess,
  IconRefresh,
  IconX,
} from '@tabler/icons-vue'
import { useTrackerStore } from '../../stores/tracker.js'
import TrackerClassifications from './tracker/TrackerClassifications.vue'
import TrackerLog from './tracker/TrackerLog.vue'
import TrackerOverview from './tracker/TrackerOverview.vue'
import TrackerTimeline from './tracker/TrackerTimeline.vue'

const props = defineProps({
  active: { type: Boolean, default: false },
})

const tracker = useTrackerStore()
const root = ref(null)
const selectedTab = ref('day')
const anchor = ref(new Date())
const now = ref(Date.now())
const loading = ref(false)
const error = ref('')
const ready = ref(false)
const selectedBlock = ref(null)
const search = ref('')
const offset = ref(0)
const report = ref(emptyReport())
const page = ref({ blocks: [], total: 0, offset: 0, limit: 100 })
const timelineBlocks = ref([])
const rules = ref([])
let refreshGeneration = 0
let searchTimer = null
let tickTimer = null

const tabs = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All' },
  { id: 'classifications', label: 'Classifications' },
]
const range = computed(() => reportRange(selectedTab.value, anchor.value))
const rangeTitle = computed(() => formatRangeTitle(selectedTab.value, range.value))
const statusLine = computed(() => {
  if (!tracker.enabled) return 'Disabled · no collector running'
  if (tracker.mode === 'break') return `Break · ${duration(tracker.status.breakRemainingSeconds || 0)} remaining`
  if (tracker.mode === 'needs-access') return 'Needs Accessibility · no window evidence yet'
  if (tracker.mode === 'paused') return 'Paused · history retained'
  if (tracker.mode === 'unsupported') return 'This collector currently requires macOS'
  if (tracker.mode === 'error') return tracker.status.diagnostic || 'Collector needs attention'
  const current = tracker.status.current
  if (current?.activity === 'UNKNOWN') {
    const subject = current.domain || current.appName || 'new application'
    return tracker.status.config.classificationEnabled
      ? `Classifying · ${subject}`
      : `Needs classification · ${subject}`
  }
  return current
    ? `${current.activity} · ${current.domain || current.appName || current.subcategory || 'system'}`
    : 'Armed · waiting for first observation'
})

watch(
  [
    () => range.value.startMs,
    () => range.value.endMs,
    () => tracker.status.revision,
  ],
  () => {
    if (!ready.value || !props.active) return
    if (selectedTab.value === 'classifications') void loadClassifications()
    else void refreshData()
  },
)
watch(() => props.active, (active) => {
  if (ready.value && active) void refreshAll()
})

onMounted(async () => {
  await tracker.initialize().catch(cause => { error.value = message(cause) })
  ready.value = true
  if (selectedTab.value === 'classifications') await loadClassifications()
  else await refreshData()
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
    if (props.active && tracker.enabled && selectedTab.value !== 'classifications') {
      void refreshData({ quiet: true })
    }
  }, 30_000)
})

onUnmounted(() => {
  window.clearInterval(tickTimer)
  window.clearTimeout(searchTimer)
})

function focusEntry() {
  root.value?.focus()
}

defineExpose({ focusEntry })

async function refreshAll() {
  await tracker.refresh().catch(cause => { error.value = message(cause) })
  if (selectedTab.value === 'classifications') await loadClassifications()
  else await refreshData()
}

async function refreshData({ quiet = false } = {}) {
  if (!tracker.enabled) return
  const generation = ++refreshGeneration
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const query = {
      startMs: range.value.startMs,
      endMs: range.value.endMs,
      categories: [],
      search: search.value.trim() || null,
      offset: offset.value,
      limit: 100,
    }
    const requests = [
      tracker.report({
        startMs: range.value.startMs,
        endMs: range.value.endMs,
        timezone: tracker.status.config.timezone,
      }),
      tracker.query(query),
    ]
    if (selectedTab.value === 'day') {
      requests.push(tracker.query({
        startMs: range.value.startMs,
        endMs: range.value.endMs,
        categories: [],
        search: null,
        offset: 0,
        limit: 500,
      }))
    }
    const [nextReport, nextPage, timelinePage] = await Promise.all(requests)
    if (generation !== refreshGeneration) return
    report.value = nextReport
    page.value = nextPage
    timelineBlocks.value = timelinePage?.blocks || []
    selectedBlock.value = selectedBlock.value
      ? nextPage.blocks.find(block => block.id === selectedBlock.value.id) || null
      : null
  } catch (cause) {
    if (generation === refreshGeneration) error.value = message(cause)
  } finally {
    if (generation === refreshGeneration) loading.value = false
  }
}

async function loadClassifications() {
  loading.value = true
  error.value = ''
  try {
    rules.value = await tracker.classifications()
  } catch (cause) {
    error.value = message(cause)
  } finally {
    loading.value = false
  }
}

function selectTab(tab) {
  selectedTab.value = tab
  selectedBlock.value = null
  offset.value = 0
  if (tab === 'classifications') void loadClassifications()
  else void refreshData()
}

function moveRange(direction) {
  const value = new Date(anchor.value)
  if (selectedTab.value === 'day') value.setDate(value.getDate() + direction)
  else if (selectedTab.value === 'week') value.setDate(value.getDate() + direction * 7)
  else if (selectedTab.value === 'month') value.setMonth(value.getMonth() + direction)
  anchor.value = value
  offset.value = 0
}

function goToday() {
  anchor.value = new Date()
  offset.value = 0
}

function setSearch(value) {
  search.value = value
  offset.value = 0
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => refreshData(), 180)
}

function setOffset(value) {
  offset.value = Math.max(0, Number(value || 0))
  void refreshData()
}

async function saveClassification(update) {
  await tracker.updateClassification(update)
  await Promise.all([loadClassifications(), refreshData({ quiet: true })])
}

async function toggleArmed() {
  await act(() => tracker.setArmed(!tracker.armed))
}

async function startBreak(minutes) {
  await act(() => tracker.startBreak(minutes))
}

async function endBreak() {
  await act(() => tracker.endBreak())
}

async function requestAccess() {
  await act(() => tracker.requestAccessibility())
}

async function enable() {
  await act(() => tracker.setEnabled(true))
}

async function act(operation) {
  error.value = ''
  try {
    await operation()
    await refreshAll()
  } catch (cause) {
    error.value = message(cause)
  }
}

function reportRange(tab, date) {
  const anchorDate = new Date(date)
  if (tab === 'all') {
    return {
      startMs: new Date(2000, 0, 1).getTime(),
      endMs: startOfTomorrow().getTime(),
    }
  }
  let start
  let end
  if (tab === 'month') {
    start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1)
    end = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1)
  } else if (tab === 'week') {
    start = startOfDay(anchorDate)
    const weekday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - weekday)
    end = new Date(start)
    end.setDate(end.getDate() + 7)
  } else {
    start = startOfDay(anchorDate)
    end = new Date(start)
    end.setDate(end.getDate() + 1)
  }
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function startOfDay(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

function startOfTomorrow() {
  const date = startOfDay(new Date())
  date.setDate(date.getDate() + 1)
  return date
}

function formatRangeTitle(tab, value) {
  if (tab === 'all') return 'All recorded time'
  const start = new Date(value.startMs)
  const end = new Date(value.endMs - 1)
  if (tab === 'day') {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(start)
  }
  if (tab === 'month') {
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(start)
  }
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  return `${formatter.format(start)}–${formatter.format(end)}`
}

function dateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function duration(seconds) {
  const value = Math.max(0, Number(seconds || 0))
  if (value < 60) return `${Math.ceil(value)}s`
  const minutes = Math.round(value / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function emptyReport() {
  return {
    totals: {},
    days: [],
    topApps: [],
    subcategories: [],
    heatmap: [],
    totalTrackedSeconds: 0,
    longestWorkStreakSeconds: 0,
    workLeisureRatio: null,
    totalBlocks: 0,
  }
}

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Tracker data could not load.')
}
</script>

<style scoped>
.tracker-app { container: tracker / inline-size; }
.status-disabled { background: var(--color-ink-4); }
.status-needs-access, .status-error { background: var(--color-rem); }
.status-paused, .status-unsupported { background: var(--color-rule); }
.status-armed { background: var(--color-add); }
.status-break { background: var(--color-accent); }
button:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: -1px;
}
</style>
