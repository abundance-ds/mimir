<template>
  <section data-tracker-timeline class="border-b border-rule bg-surface">
    <header class="flex h-8 items-center border-b border-rule-light px-3">
      <h2 class="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-ink-2">
        Exact timeline
      </h2>
      <span class="ml-2 font-mono text-[9px] tabular-nums text-ink-4">
        {{ blocks.length }} block{{ blocks.length === 1 ? '' : 's' }}
      </span>
      <span class="ml-auto text-[9px] text-ink-3">
        {{ rangeLabel }}
      </span>
    </header>

    <div class="px-3 pb-3 pt-2">
      <svg
        class="block h-[92px] w-full"
        role="img"
        :aria-label="`Activity timeline for ${rangeLabel}`"
      >
        <defs>
          <pattern id="tracker-break-pattern" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" class="timeline-pattern-bg" />
            <path d="M-2,8 L8,-2 M4,10 L10,4" class="timeline-pattern-line" />
          </pattern>
          <pattern id="tracker-off-pattern" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0,3 H6" class="timeline-off-line" />
          </pattern>
          <pattern id="tracker-unknown-pattern" width="7" height="7" patternUnits="userSpaceOnUse">
            <circle cx="3.5" cy="3.5" r="1" class="timeline-unknown-dot" />
          </pattern>
          <clipPath v-for="segment in segments" :id="segment.clipId" :key="segment.clipId">
            <rect
              :x="percent(segment.x)"
              :y="segment.y"
              :width="percent(segment.width)"
              :height="segment.height"
            />
          </clipPath>
        </defs>

        <line x1="0" x2="100%" y1="66" y2="66" class="timeline-axis" />
        <g v-for="tick in ticks" :key="tick.position">
          <line
            :x1="percent(tick.position)"
            :x2="percent(tick.position)"
            y1="13"
            y2="72"
            class="timeline-tick"
          />
          <text
            :x="percent(tick.position)"
            y="87"
            :text-anchor="tick.anchor"
            class="timeline-label"
          >{{ tick.label }}</text>
        </g>

        <g
          v-for="segment in segments"
          :key="segment.block.id"
          class="timeline-segment"
          tabindex="0"
          role="button"
          :aria-label="segment.label"
          @click="$emit('select', segment.block)"
          @keydown.enter.prevent="$emit('select', segment.block)"
        >
          <rect
            :x="percent(segment.x)"
            :y="segment.y"
            :width="percent(segment.width)"
            :height="segment.height"
            :class="`timeline-fill timeline-fill-${slug(segment.block.activity)}`"
          >
            <title>{{ segment.label }}</title>
          </rect>
          <text
            v-if="segment.width >= 0.12"
            :x="percent(segment.x)"
            dx="6"
            :y="segment.labelY"
            :clip-path="`url(#${segment.clipId})`"
            class="timeline-segment-label"
          >{{ segment.shortLabel }}</text>
        </g>

        <g v-if="nowPosition !== null" aria-label="Now">
          <line
            :x1="percent(nowPosition)"
            :x2="percent(nowPosition)"
            y1="8"
            y2="68"
            class="timeline-now"
          />
          <circle
            :cx="percent(nowPosition)"
            cy="9"
            r="3.5"
            class="timeline-now-marker"
          />
        </g>
      </svg>
    </div>

    <footer class="flex flex-wrap gap-x-3 gap-y-1 border-t border-rule-light px-3 py-2">
      <span
        v-for="category in visibleCategories"
        :key="category"
        class="inline-flex items-center gap-1.5 font-mono text-[9px] text-ink-3"
      >
        <span
          class="size-2 border border-rule"
          :class="`legend-${slug(category)}`"
          aria-hidden="true"
        />
        {{ category }}
      </span>
    </footer>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  blocks: { type: Array, default: () => [] },
  startMs: { type: Number, required: true },
  endMs: { type: Number, required: true },
  nowMs: { type: Number, default: () => Date.now() },
  locale: { type: String, default: undefined },
})

defineEmits(['select'])

const duration = computed(() => Math.max(1, props.endMs - props.startMs))
const segments = computed(() => props.blocks
  .map((block) => {
    const start = Math.max(props.startMs, Number(block.startMs))
    const end = Math.min(props.endMs, Number(block.endMs))
    if (end <= start) return null
    const x = (start - props.startMs) / duration.value
    const width = Math.max(0.001, (end - start) / duration.value)
    const app = block.domain || block.appName || block.subcategory || block.activity
    const lane = laneGeometry(block.activity)
    return {
      block,
      x,
      width,
      ...lane,
      clipId: `tracker-segment-${block.id}`,
      shortLabel: String(app || block.activity).slice(0, 28),
      label: `${block.activity}, ${formatClock(start)}–${formatClock(end)}, ${formatDuration((end - start) / 1000)}${app ? `, ${app}` : ''}`,
    }
  })
  .filter(Boolean))
const ticks = computed(() => {
  const count = 5
  return Array.from({ length: count }, (_, index) => {
    const position = index / (count - 1)
    return {
      position,
      anchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
      label: duration.value <= 36 * 60 * 60 * 1000
        ? formatClock(props.startMs + duration.value * position)
        : formatDate(props.startMs + duration.value * position),
    }
  })
})
const nowPosition = computed(() => (
  props.nowMs >= props.startMs && props.nowMs <= props.endMs
    ? (props.nowMs - props.startMs) / duration.value
    : null
))
const visibleCategories = computed(() => (
  [...new Set(props.blocks.map(block => block.activity))]
))
const rangeLabel = computed(() => (
  `${formatDate(props.startMs)} ${formatClock(props.startMs)} – ${formatDate(props.endMs)} ${formatClock(props.endMs)}`
))

function formatClock(value) {
  return new Intl.DateTimeFormat(props.locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDate(value) {
  return new Intl.DateTimeFormat(props.locale, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatDuration(seconds) {
  const minutes = Math.max(0, Math.round(seconds / 60))
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`
}

function slug(value) {
  return String(value || 'unknown').toLowerCase()
}

function percent(value) {
  return `${Math.max(0, Math.min(1, Number(value || 0))) * 100}%`
}

function laneGeometry(activity) {
  return {
    Work: { y: 20, height: 39, labelY: 44 },
    Leisure: { y: 24, height: 35, labelY: 46 },
    Other: { y: 29, height: 30, labelY: 48 },
    Break: { y: 20, height: 39, labelY: 44 },
    AFK: { y: 34, height: 25, labelY: 50 },
    OFF: { y: 40, height: 19, labelY: 53 },
    UNKNOWN: { y: 20, height: 39, labelY: 44 },
  }[activity] || { y: 29, height: 30, labelY: 48 }
}
</script>

<style scoped>
.timeline-axis { stroke: var(--color-rule); stroke-width: 1; }
.timeline-tick { stroke: var(--color-rule-light); stroke-width: 1; }
.timeline-label {
  fill: var(--color-ink-4);
  font-family: var(--font-mono);
  font-size: 9px;
}
.timeline-fill {
  stroke: var(--color-surface);
  stroke-width: 1;
  cursor: pointer;
}
.timeline-segment:focus { outline: none; }
.timeline-segment:focus .timeline-fill {
  stroke: var(--color-accent);
  stroke-width: 2;
}
.timeline-fill-work, .legend-work { fill: var(--color-accent); background: var(--color-accent); }
.timeline-fill-leisure, .legend-leisure { fill: var(--color-ink-2); background: var(--color-ink-2); }
.timeline-fill-other, .legend-other { fill: var(--color-add); background: var(--color-add); }
.timeline-fill-afk, .legend-afk { fill: var(--color-rule); background: var(--color-rule); }
.timeline-fill-break { fill: url(#tracker-break-pattern); }
.legend-break {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}
.timeline-fill-off { fill: url(#tracker-off-pattern); }
.legend-off { background: var(--color-chrome); }
.timeline-fill-unknown { fill: url(#tracker-unknown-pattern); }
.legend-unknown { background: var(--color-rem); }
.timeline-pattern-bg { fill: var(--color-accent-soft); }
.timeline-pattern-line { stroke: var(--color-accent); stroke-width: 1; }
.timeline-off-line { stroke: var(--color-ink-4); stroke-width: 1; }
.timeline-unknown-dot { fill: var(--color-rem); }
.timeline-segment-label {
  fill: var(--color-accent-ink);
  font-family: var(--font-mono);
  font-size: 9px;
  pointer-events: none;
}
.timeline-fill-afk + .timeline-segment-label,
.timeline-fill-off + .timeline-segment-label,
.timeline-fill-break + .timeline-segment-label,
.timeline-fill-unknown + .timeline-segment-label {
  fill: var(--color-ink-2);
}
.timeline-now {
  stroke: var(--color-rem);
  stroke-width: 1.5;
}
.timeline-now-marker { fill: var(--color-rem); }
</style>
