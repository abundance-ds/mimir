<template>
  <div class="context-donut">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle
        :cx="size / 2" :cy="size / 2" :r="r"
        fill="none" :stroke="trackColor" :stroke-width="strokeWidth"
      />
      <circle
        v-if="percent > 0"
        :cx="size / 2" :cy="size / 2" :r="r"
        fill="none" :stroke="fillColor" :stroke-width="strokeWidth"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="circumference * (1 - percent)"
        stroke-linecap="round"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
      />
    </svg>
    <div class="donut-tooltip">
      <div>{{ contextLine }}</div>
      <div v-if="costLabel">{{ costLabel }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  percent: { type: Number, default: 0 },
  size: { type: Number, default: 16 },
  tokenCount: { type: Number, default: 0 },
  contextWindow: { type: Number, default: 0 },
  costLabel: { type: String, default: '' },
})

const strokeWidth = 2
const r = computed(() => (props.size - strokeWidth) / 2)
const circumference = computed(() => 2 * Math.PI * r.value)

const trackColor = 'var(--color-rule)'
const fillColor = computed(() => {
  if (props.percent >= 0.85) return 'var(--color-rem)'
  if (props.percent >= 0.6) return 'var(--color-accent)'
  return 'var(--color-ink-4)'
})

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

const contextLine = computed(() => {
  if (!props.contextWindow) return ''
  const pct = Math.round(props.percent * 100)
  return `${formatTokens(props.tokenCount)} / ${formatTokens(props.contextWindow)} (${pct}%)`
})
</script>

<style scoped>
.context-donut {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: default;
}
.donut-tooltip {
  position: absolute; bottom: calc(100% + 6px); left: 50%;
  transform: translateX(-50%);
  background: var(--color-ink); color: var(--color-surface);
  font-family: var(--font-mono); font-size: 10px; line-height: 1.5;
  padding: 4px 8px; border-radius: 4px;
  white-space: nowrap; pointer-events: none;
  opacity: 0; transition: opacity 120ms ease;
}
.context-donut:hover .donut-tooltip { opacity: 1; }
</style>
