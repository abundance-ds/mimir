<template>
  <div>
    <!-- Browser mode notice -->
    <div v-if="!isTauri" class="browser-notice">
      <IconInfoCircle :size="14" />
      <span>Usage tracking is not available in browser mode.</span>
    </div>

    <!-- Dashboard -->
    <template v-else>

      <!-- A. Month navigation -->
      <div class="month-nav">
        <button class="month-nav-btn" @click="prevMonth">
          <IconChevronLeft :size="14" />
        </button>
        <span class="month-label">{{ monthLabel }}</span>
        <button
          class="month-nav-btn"
          :disabled="isCurrentMonth"
          @click="nextMonth"
        >
          <IconChevronRight :size="14" />
        </button>
        <button
          v-if="!isCurrentMonth"
          class="month-current-btn"
          @click="goCurrentMonth"
        >
          Current month
        </button>
      </div>

      <!-- B. Summary line -->
      <div class="summary-line">
        {{ formatCost(monthData.total_cost ?? 0) }} · {{ monthData.calls ?? 0 }} calls · {{ formatTokens((monthData.total_input_tokens ?? 0) + (monthData.total_output_tokens ?? 0)) }} tokens
      </div>

      <!-- C. SVG daily chart -->
      <div class="chart-container" ref="chartContainerRef">
        <svg viewBox="0 0 460 100" class="chart-svg">
          <!-- Grid lines -->
          <line
            v-for="gl in chart.gridLines"
            :key="'gl-' + gl.y"
            :x1="chart.padding.left"
            :y1="gl.y"
            :x2="460 - chart.padding.right"
            :y2="gl.y"
            stroke="var(--color-rule-light)"
            stroke-width="0.5"
          />
          <!-- Grid labels -->
          <text
            v-for="gl in chart.gridLines"
            :key="'glt-' + gl.y"
            :x="chart.padding.left - 4"
            :y="gl.y + 3"
            text-anchor="end"
            class="chart-axis-label"
          >{{ gl.label }}</text>

          <!-- Bars -->
          <rect
            v-for="bar in chart.bars"
            :key="'bar-' + bar.day"
            :x="bar.x"
            :y="bar.y"
            :width="Math.max(0, bar.w - 1)"
            :height="bar.h"
            fill="var(--color-accent)"
            opacity="0.65"
            rx="1"
            class="chart-bar"
            @mouseenter="showTooltip($event, bar)"
            @mouseleave="hideTooltip"
          />

          <!-- Today marker -->
          <line
            v-if="chart.todayX !== null"
            :x1="chart.todayX"
            :y1="chart.plotBottom"
            :x2="chart.todayX + chart.barW - 1"
            :y2="chart.plotBottom"
            stroke="var(--color-accent)"
            stroke-width="2"
          />

          <!-- X-axis day labels -->
          <text
            v-for="lbl in chart.xLabels"
            :key="'xl-' + lbl.day"
            :x="lbl.x"
            :y="chart.plotBottom + 12"
            text-anchor="middle"
            class="chart-axis-label"
          >{{ lbl.day }}</text>
        </svg>

        <!-- Tooltip -->
        <div
          v-if="tooltip.visible"
          class="chart-tooltip"
          :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
        >
          <div class="tt-date">{{ tooltip.date }}</div>
          <div class="tt-row">{{ formatCost(tooltip.cost) }} · {{ tooltip.calls }} calls</div>
          <div class="tt-row">{{ formatTokens(tooltip.inputTokens + tooltip.outputTokens) }} tokens</div>
        </div>
      </div>

      <!-- D. Budget progress bar -->
      <div class="budget-bar-section">
        <div class="budget-bar-label">
          <template v-if="budgetLimit > 0">
            {{ formatCost(monthData.total_cost ?? 0) }} / {{ formatCost(budgetLimit) }} budget
          </template>
          <template v-else>
            {{ formatCost(monthData.total_cost ?? 0) }} — no budget set
          </template>
        </div>
        <div v-if="budgetLimit > 0" class="budget-bar-track">
          <div
            class="budget-bar-fill"
            :style="{ width: budgetPct + '%', background: budgetColor }"
          ></div>
        </div>
      </div>

      <!-- E. Breakdown tables -->
      <div class="section-title" style="margin-top: 20px">Breakdown</div>

      <div class="breakdown-controls">
        <div class="segmented-control">
          <button
            class="segmented-btn"
            :class="breakdownMode === 'feature' && 'segmented-active'"
            @click="breakdownMode = 'feature'"
          >By Feature</button>
          <button
            class="segmented-btn"
            :class="breakdownMode === 'model' && 'segmented-active'"
            @click="breakdownMode = 'model'"
          >By Model</button>
        </div>
      </div>

      <table class="breakdown-table">
        <thead>
          <tr>
            <th class="bt-name">Name</th>
            <th class="bt-num">Cost</th>
            <th class="bt-num">Tokens</th>
            <th class="bt-num">Calls</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in breakdownRows"
            :key="row.name"
            :class="i % 2 === 1 && 'bt-alt'"
          >
            <td class="bt-name">{{ row.name }}</td>
            <td class="bt-num bt-mono">{{ formatCost(row.cost) }}</td>
            <td class="bt-num bt-mono">{{ formatTokens(row.input_tokens + row.output_tokens) }}</td>
            <td class="bt-num bt-mono">{{ row.calls }}</td>
          </tr>
          <tr v-if="breakdownRows.length === 0">
            <td colspan="4" class="bt-empty">No data for this month</td>
          </tr>
        </tbody>
      </table>

      <!-- F. Budget setting -->
      <div class="section-title" style="margin-top: 24px">Budget</div>
      <div class="setting-row last">
        <div class="setting-label">
          Monthly limit
          <span class="setting-desc">Set to 0 for unlimited. Sends are blocked at limit.</span>
        </div>
        <div class="budget-input-group">
          <span class="budget-prefix">$</span>
          <input
            ref="budgetInputRef"
            type="number"
            class="budget-input"
            :value="budgetInputVal"
            min="0"
            step="1"
            @blur="saveBudget"
            @keydown.enter="saveBudget"
            @input="budgetInputVal = Number($event.target.value)"
          />
        </div>
      </div>

      <!-- Success message -->
      <Transition name="budget-msg">
        <div v-if="showSaved" class="budget-saved">Budget updated</div>
      </Transition>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { IconInfoCircle, IconChevronLeft, IconChevronRight } from '@tabler/icons-vue'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// ── State ──

const now = new Date()
const selectedMonth = ref(
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
)

const monthData = ref({ total_cost: 0, calls: 0, total_input_tokens: 0, total_output_tokens: 0, by_feature: [], by_model: [] })
const dailyData = ref([])
const budgetLimit = ref(0)
const budgetInputVal = ref(0)
const showSaved = ref(false)
const budgetInputRef = ref(null)
const chartContainerRef = ref(null)

const breakdownMode = ref('feature')

let saveTimeout = null

// ── Tooltip ──

const tooltip = ref({
  visible: false, x: 0, y: 0,
  date: '', cost: 0, calls: 0, inputTokens: 0, outputTokens: 0,
})

function showTooltip(event, bar) {
  const container = chartContainerRef.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  const svgRect = container.querySelector('svg')?.getBoundingClientRect()
  if (!svgRect) return

  // Map bar SVG coords to pixel coords relative to container
  const scaleX = svgRect.width / 460
  const scaleY = svgRect.height / 100
  const px = (bar.x + bar.w / 2) * scaleX + (svgRect.left - rect.left)
  const py = bar.y * scaleY + (svgRect.top - rect.top)

  tooltip.value = {
    visible: true,
    x: Math.max(0, Math.min(px - 50, rect.width - 120)),
    y: Math.max(0, py - 58),
    date: bar.date,
    cost: bar.cost,
    calls: bar.calls,
    inputTokens: bar.inputTokens,
    outputTokens: bar.outputTokens,
  }
}

function hideTooltip() {
  tooltip.value.visible = false
}

// ── Derived ──

const isCurrentMonth = computed(() => {
  const n = new Date()
  return selectedMonth.value === `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
})

const monthLabel = computed(() => {
  const [y, m] = selectedMonth.value.split('-').map(Number)
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[m - 1]} ${y}`
})

const breakdownRows = computed(() => {
  return breakdownMode.value === 'feature'
    ? (monthData.value.by_feature ?? [])
    : (monthData.value.by_model ?? [])
})

const budgetPct = computed(() => {
  if (budgetLimit.value <= 0) return 0
  return Math.min(120, ((monthData.value.total_cost ?? 0) / budgetLimit.value) * 100)
})

const budgetColor = computed(() => {
  const pct = budgetPct.value
  if (pct >= 100) return 'var(--color-rem)'
  if (pct >= 80) return 'color-mix(in srgb, var(--color-rem) 70%, transparent)'
  return 'var(--color-accent)'
})

// ── Chart computation ──

const chart = computed(() => {
  const [y, m] = selectedMonth.value.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const padding = { top: 8, right: 12, bottom: 18, left: 36 }
  const plotW = 460 - padding.left - padding.right
  const plotH = 100 - padding.top - padding.bottom
  const barW = plotW / daysInMonth
  const plotBottom = padding.top + plotH

  const dayMap = {}
  for (const d of dailyData.value) {
    const dayNum = parseInt(d.date.split('-')[2], 10)
    dayMap[dayNum] = d
  }

  const maxCost = Math.max(0.01, ...dailyData.value.map(d => d.cost))

  // Grid lines (2-3 lines)
  const gridLines = []
  const niceStep = niceGridStep(maxCost)
  for (let v = niceStep; v <= maxCost * 1.1; v += niceStep) {
    const yy = plotBottom - (v / maxCost) * plotH
    if (yy < padding.top - 2) break
    gridLines.push({ y: yy, label: formatCostShort(v) })
    if (gridLines.length >= 3) break
  }

  // Bars
  const bars = []
  const todayDate = new Date()
  const todayDay = todayDate.getFullYear() === y && todayDate.getMonth() + 1 === m
    ? todayDate.getDate() : null

  let todayX = null

  for (let day = 1; day <= daysInMonth; day++) {
    const x = padding.left + (day - 1) * barW
    const entry = dayMap[day]
    const cost = entry ? entry.cost : 0
    const h = cost > 0 ? Math.max(1, (cost / maxCost) * plotH) : 0
    const yy = plotBottom - h

    bars.push({
      day,
      x,
      y: yy,
      w: barW,
      h,
      date: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      cost,
      calls: entry ? entry.calls : 0,
      inputTokens: entry ? entry.input_tokens : 0,
      outputTokens: entry ? entry.output_tokens : 0,
    })

    if (day === todayDay) {
      todayX = x
    }
  }

  // X labels: day 1, every 5th, last day
  const xLabels = []
  const labelSet = new Set([1, daysInMonth])
  for (let d = 5; d <= daysInMonth; d += 5) labelSet.add(d)
  for (const d of [...labelSet].sort((a, b) => a - b)) {
    xLabels.push({ day: d, x: padding.left + (d - 1) * barW + barW / 2 })
  }

  return { padding, plotW, plotH, barW, plotBottom, gridLines, bars, xLabels, todayX }
})

function niceGridStep(max) {
  if (max <= 0.05) return 0.01
  if (max <= 0.2) return 0.05
  if (max <= 0.5) return 0.1
  if (max <= 2) return 0.5
  if (max <= 5) return 1
  if (max <= 20) return 5
  if (max <= 50) return 10
  if (max <= 200) return 50
  return Math.pow(10, Math.floor(Math.log10(max)))
}

function formatCostShort(n) {
  if (n < 1) return `$${n.toFixed(2)}`
  if (n < 10) return `$${n.toFixed(1)}`
  return `$${Math.round(n)}`
}

// ── Format helpers ──

function formatCost(n) {
  return `$${(n ?? 0).toFixed(2)}`
}

function formatTokens(n) {
  if (n == null) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ── Month navigation ──

function prevMonth() {
  const [y, m] = selectedMonth.value.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  selectedMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function nextMonth() {
  if (isCurrentMonth.value) return
  const [y, m] = selectedMonth.value.split('-').map(Number)
  const d = new Date(y, m, 1)
  selectedMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function goCurrentMonth() {
  const n = new Date()
  selectedMonth.value = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}

// ── Data fetching ──

async function loadData() {
  if (!isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const month = selectedMonth.value
    const [data, daily, limitRaw] = await Promise.all([
      invoke('usage_query_month', { month }),
      invoke('usage_query_daily', { month }),
      invoke('usage_get_setting', { key: 'budget_limit' }),
    ])
    monthData.value = data
    dailyData.value = daily
    const parsed = parseFloat(limitRaw)
    budgetLimit.value = isNaN(parsed) ? 0 : parsed
    budgetInputVal.value = budgetLimit.value
  } catch (e) {
    // silently handle — data stays at defaults
  }
}

async function refreshMonth() {
  if (!isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const month = selectedMonth.value
    const [data, daily] = await Promise.all([
      invoke('usage_query_month', { month }),
      invoke('usage_query_daily', { month }),
    ])
    monthData.value = data
    dailyData.value = daily
  } catch (e) {
    // silently handle
  }
}

watch(selectedMonth, refreshMonth)

async function saveBudget() {
  if (!isTauri) return
  const val = Math.max(0, budgetInputVal.value || 0)
  budgetInputVal.value = val
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('usage_set_setting', { key: 'budget_limit', value: String(val) })
    budgetLimit.value = val
    showSaved.value = true
    clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => { showSaved.value = false }, 2000)
  } catch (e) {
    // silently handle
  }
}

onMounted(loadData)
</script>

<style scoped>
/* ── Browser notice ── */
.browser-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  padding: 14px;
}

/* ── Month navigation ── */
.month-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px 0 4px;
}

.month-nav-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-rule-light);
  border-radius: 6px;
  background: transparent;
  color: var(--color-ink-3);
  padding: 0;
}
.month-nav-btn:hover:not(:disabled) {
  border-color: var(--color-rule);
  color: var(--color-ink);
}
.month-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.month-label {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
  min-width: 110px;
  text-align: center;
}

.month-current-btn {
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-accent);
  background: none;
  border: none;
  padding: 2px 6px;
}
.month-current-btn:hover {
  opacity: 0.7;
}

/* ── Summary line ── */
.summary-line {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-ink-3);
  padding: 6px 0 14px;
}

/* ── Chart ── */
.chart-container {
  position: relative;
  margin: 0 -2px;
}

.chart-svg {
  width: 100%;
  height: auto;
  display: block;
}

.chart-axis-label {
  font-family: var(--font-mono);
  font-size: 7px;
  fill: var(--color-ink-3);
}

.chart-bar {
  cursor: crosshair;
}
.chart-bar:hover {
  opacity: 0.9;
}

/* ── Tooltip ── */
.chart-tooltip {
  position: absolute;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 10px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  z-index: 10;
  pointer-events: none;
  white-space: nowrap;
}

.tt-date {
  font-family: var(--font-sans);
  font-weight: 600;
  color: var(--color-ink);
  margin-bottom: 3px;
}

.tt-row {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--color-ink-3);
  line-height: 1.5;
}

/* ── Budget progress bar ── */
.budget-bar-section {
  padding: 6px 0 4px;
}

.budget-bar-label {
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--color-ink-3);
  margin-bottom: 6px;
  text-align: center;
}

.budget-bar-track {
  width: 100%;
  height: 4px;
  background: var(--color-chrome-mid);
  border-radius: 2px;
  overflow: hidden;
}

.budget-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 300ms ease;
}

/* ── Breakdown ── */
.breakdown-controls {
  display: flex;
  margin-bottom: 10px;
}

.breakdown-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-sans);
  font-size: 11px;
}

.breakdown-table thead th {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--color-ink-3);
  padding: 4px 0 6px;
  border-bottom: 1px solid var(--color-rule-light);
}

.breakdown-table tbody td {
  padding: 6px 0;
  color: var(--color-ink-2);
}

.breakdown-table tbody tr.bt-alt {
  background: var(--color-chrome-mid);
}

.bt-name {
  text-align: left;
  padding-left: 2px !important;
}

.bt-num {
  text-align: right;
  padding-right: 2px !important;
}

.bt-mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.bt-empty {
  text-align: center !important;
  color: var(--color-ink-3);
  padding: 16px 0 !important;
  font-style: italic;
}

/* ── Budget input ── */
.budget-input-group {
  display: flex;
  align-items: center;
}

.budget-prefix {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-ink-3);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-right: none;
  border-radius: 4px 0 0 4px;
  padding: 0 6px;
  height: 28px;
  display: flex;
  align-items: center;
}

.budget-input {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule-light);
  border-radius: 0 4px 4px 0;
  padding: 0 8px;
  width: 72px;
  height: 28px;
  outline: none;
  transition: border-color 120ms ease;
}
.budget-input:focus {
  border-color: var(--color-accent);
}

/* Hide spin buttons */
.budget-input::-webkit-inner-spin-button,
.budget-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.budget-input[type='number'] {
  -moz-appearance: textfield;
}

/* ── Success message ── */
.budget-saved {
  text-align: center;
  font-family: var(--font-sans);
  font-size: 10px;
  color: var(--color-add);
  margin-top: 10px;
}

.budget-msg-enter-active {
  transition: opacity 200ms ease;
}
.budget-msg-leave-active {
  transition: opacity 400ms ease;
}
.budget-msg-enter-from,
.budget-msg-leave-to {
  opacity: 0;
}
</style>
