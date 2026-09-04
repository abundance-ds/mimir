<template>
  <div data-tracker-overview>
    <section class="tracker-metrics grid border-b border-rule">
      <article
        v-for="metric in metrics"
        :key="metric.label"
        class="tracker-metric min-h-[74px] border-b border-rule-light px-3 py-2"
      >
        <p class="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-4">{{ metric.label }}</p>
        <p class="mt-1 font-mono text-[18px] font-semibold tabular-nums text-ink">{{ metric.value }}</p>
        <p class="mt-0.5 text-[9px] text-ink-3">{{ metric.detail }}</p>
      </article>
    </section>

    <section class="tracker-shape grid border-b border-rule">
      <div class="tracker-shape-days border-b border-rule">
        <header class="flex h-7 items-center border-b border-rule-light px-3">
          <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Day shape</h2>
          <span class="ml-auto font-mono text-[9px] text-ink-4">{{ report.days.length }} day{{ report.days.length === 1 ? '' : 's' }}</span>
        </header>
        <div v-if="report.days.length" class="max-h-[300px] overflow-y-auto">
          <article
            v-for="day in report.days"
            :key="day.date"
            class="grid grid-cols-[76px_minmax(0,1fr)_54px] items-center gap-2 border-b border-rule-light px-3 py-2 last:border-b-0"
          >
            <span class="font-mono text-[10px] text-ink-3">{{ compactDate(day.date) }}</span>
            <div class="day-shape flex h-4 items-end border border-rule-light bg-chrome-high" :aria-label="dayLabel(day)">
              <span
                v-for="part in dayParts(day)"
                :key="part.category"
                :style="{ width: `${part.percent}%` }"
                :class="`day-part day-part-${slug(part.category)}`"
                :title="`${part.category}: ${duration(part.seconds)}`"
              />
            </div>
            <span class="text-right font-mono text-[10px] tabular-nums text-ink-3">{{ duration(dayTotal(day)) }}</span>
          </article>
        </div>
        <p v-else class="px-3 py-8 text-center text-[9px] text-ink-4">No tracked intervals in this range.</p>
      </div>

      <div>
        <header class="flex h-7 items-center border-b border-rule-light px-3">
          <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Composition</h2>
        </header>
        <div class="divide-y divide-rule-light">
          <article
            v-for="category in categoryRows"
            :key="category.name"
            class="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
          >
            <span class="size-2 border border-rule" :class="`category-mark-${slug(category.name)}`" />
            <span class="text-[10px] font-semibold text-ink-2">{{ category.name }}</span>
            <span class="font-mono text-[10px] tabular-nums text-ink">{{ duration(category.seconds) }}</span>
          </article>
        </div>
      </div>
    </section>

    <section class="tracker-rankings grid border-b border-rule">
      <div class="tracker-rankings-apps border-b border-rule">
        <header class="flex h-7 items-center border-b border-rule-light px-3">
          <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Top applications</h2>
        </header>
        <RankedList :items="report.topApps" empty="No application evidence yet." />
      </div>
      <div>
        <header class="flex h-7 items-center border-b border-rule-light px-3">
          <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Work types</h2>
        </header>
        <RankedList :items="report.subcategories" empty="No classified work types yet." />
      </div>
    </section>

    <section>
      <header class="flex h-7 items-center border-b border-rule-light px-3">
        <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">Weekly rhythm</h2>
        <span class="ml-auto font-mono text-[9px] text-ink-4">Mon–Sun · local hour</span>
      </header>
      <div class="px-3 py-3">
        <div class="heatmap-grid grid gap-px">
          <span />
          <span v-for="hour in 24" :key="`h-${hour}`" class="text-center font-mono text-[9px] text-ink-4">
            {{ hour % 3 === 1 ? hour - 1 : '' }}
          </span>
          <template v-for="(day, weekday) in weekdays" :key="day">
            <span class="self-center font-mono text-[9px] text-ink-4">{{ day }}</span>
            <span
              v-for="hour in 24"
              :key="`${weekday}:${hour - 1}`"
              class="heat-cell h-4 border border-rule-light"
              :style="{ opacity: heatOpacity(weekday, hour - 1) }"
              :title="`${day} ${String(hour - 1).padStart(2, '0')}:00 · ${duration(heatSeconds(weekday, hour - 1))}`"
            />
          </template>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, defineComponent, h } from 'vue'

const props = defineProps({
  report: {
    type: Object,
    default: () => ({
      totals: {},
      days: [],
      topApps: [],
      subcategories: [],
      heatmap: [],
      totalTrackedSeconds: 0,
      longestWorkStreakSeconds: 0,
      workLeisureRatio: null,
      totalBlocks: 0,
    }),
  },
})

const RankedList = defineComponent({
  props: {
    items: { type: Array, default: () => [] },
    empty: { type: String, default: '' },
  },
  setup(listProps) {
    return () => listProps.items.length
      ? h('div', { class: 'divide-y divide-rule-light' }, listProps.items.slice(0, 10).map((item, index) => (
          h('article', {
            class: 'grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2',
          }, [
            h('span', { class: 'font-mono text-[9px] text-ink-4' }, String(index + 1).padStart(2, '0')),
            h('span', { class: 'truncate text-[10px] text-ink-2', title: item.label }, item.label),
            h('span', { class: 'font-mono text-[9px] tabular-nums text-ink-3' }, duration(item.seconds)),
          ])
        )))
      : h('p', { class: 'px-3 py-8 text-center text-[9px] text-ink-4' }, listProps.empty)
  },
})

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const metrics = computed(() => [
  {
    label: 'Work',
    value: duration(props.report.totals?.Work || 0),
    detail: `${percentage(props.report.totals?.Work || 0)} of tracked time`,
  },
  {
    label: 'Leisure',
    value: duration(props.report.totals?.Leisure || 0),
    detail: props.report.workLeisureRatio == null
      ? 'No work/leisure ratio yet'
      : `${props.report.workLeisureRatio.toFixed(1)}× work : leisure`,
  },
  {
    label: 'Longest focus',
    value: duration(props.report.longestWorkStreakSeconds || 0),
    detail: 'Consecutive classified work',
  },
  {
    label: 'Evidence',
    value: Number(props.report.totalBlocks || 0).toLocaleString(),
    detail: `${duration(props.report.totalTrackedSeconds || 0)} observed`,
  },
])
const categoryRows = computed(() => (
  ['Work', 'Leisure', 'Other', 'Break', 'AFK', 'UNKNOWN', 'OFF']
    .map(name => ({ name, seconds: Number(props.report.totals?.[name] || 0) }))
    .filter(item => item.seconds > 0)
))
const heatMaximum = computed(() => Math.max(
  1,
  ...props.report.heatmap.map(cell => Number(cell.seconds || 0)),
))

function dayParts(day) {
  const total = dayTotal(day)
  if (!total) return []
  return ['Work', 'Leisure', 'Other', 'Break', 'AFK', 'UNKNOWN']
    .map(category => ({
      category,
      seconds: Number(day.totals?.[category] || 0),
      percent: (Number(day.totals?.[category] || 0) / total) * 100,
    }))
    .filter(part => part.seconds > 0)
}

function dayTotal(day) {
  return Object.entries(day.totals || {})
    .filter(([category]) => category !== 'OFF')
    .reduce((sum, [, seconds]) => sum + Number(seconds || 0), 0)
}

function dayLabel(day) {
  return `${day.date}: ${dayParts(day).map(part => `${part.category} ${duration(part.seconds)}`).join(', ')}`
}

function heatSeconds(weekday, hour) {
  return Number(props.report.heatmap.find(
    cell => cell.weekday === weekday && cell.hour === hour,
  )?.seconds || 0)
}

function heatOpacity(weekday, hour) {
  const seconds = heatSeconds(weekday, hour)
  return seconds ? 0.15 + (seconds / heatMaximum.value) * 0.85 : 0.04
}

function compactDate(value) {
  const parsed = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(parsed)
}

function percentage(seconds) {
  const total = Number(props.report.totalTrackedSeconds || 0)
  return total ? `${Math.round((seconds / total) * 100)}%` : '0%'
}

function duration(seconds) {
  const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60 ? `${minutes % 60}m` : ''}`.trim()
}

function slug(value) {
  return String(value || 'unknown').toLowerCase()
}
</script>

<style scoped>
.tracker-metrics { grid-template-columns: minmax(0, 1fr); }
.tracker-metric:last-child { border-bottom-width: 0; }
.tracker-shape { grid-template-columns: minmax(0, 1fr); }
.tracker-rankings { grid-template-columns: minmax(0, 1fr); }
.heatmap-grid { grid-template-columns: 24px repeat(24, minmax(9px, 1fr)); }
.day-part { min-width: 1px; }
.day-part-work { height: 100%; }
.day-part-leisure { height: 75%; }
.day-part-other { height: 55%; }
.day-part-break, .day-part-unknown { height: 100%; }
.day-part-afk { height: 30%; }

@container tracker (min-width: 420px) {
  .tracker-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tracker-metric:nth-child(odd) { border-right-width: 1px; }
  .tracker-metric:nth-last-child(-n + 2) { border-bottom-width: 0; }
}

@container tracker (min-width: 560px) {
  .tracker-rankings { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tracker-rankings-apps {
    border-right-width: 1px;
    border-bottom-width: 0;
  }
}

@container tracker (min-width: 720px) {
  .tracker-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .tracker-metric { border-right-width: 1px; border-bottom-width: 0; }
  .tracker-metric:last-child { border-right-width: 0; }
  .tracker-shape { grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.65fr); }
  .tracker-shape-days {
    border-right-width: 1px;
    border-bottom-width: 0;
  }
}

.day-part-work, .category-mark-work { background: var(--color-accent); }
.day-part-leisure, .category-mark-leisure { background: var(--color-ink-2); }
.day-part-other, .category-mark-other { background: var(--color-add); }
.day-part-break, .category-mark-break {
  background: var(--color-accent-soft);
  outline: 1px solid var(--color-accent);
}
.day-part-afk, .category-mark-afk { background: var(--color-rule); }
.day-part-unknown, .category-mark-unknown { background: var(--color-rem); }
.day-part-off, .category-mark-off { background: var(--color-chrome); }
.heat-cell { background: var(--color-accent); }
</style>
