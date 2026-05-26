<template>
  <div class="aw-main">
    <div class="aw-scroll" ref="scrollRef">
      <div class="aw-inner">
        <!-- Header -->
        <div class="aw-header">
          <div class="aw-header-top">
            <span class="aw-icon">{{ app?.icon || '▶' }}</span>
            <div class="aw-title-block">
              <h1 class="aw-title">{{ session.label }}</h1>
              <span class="aw-project">{{ projectName }}</span>
            </div>
            <span class="aw-badge" :class="badgeClass">
              <IconLoader v-if="isRunning" :size="11" class="aw-spin" />
              <IconCheck v-else-if="isCompleted" :size="11" />
              <IconX v-else :size="11" />
              {{ badgeLabel }}
            </span>
          </div>
          <div class="aw-header-meta">
            <span v-if="elapsed" class="aw-elapsed">{{ elapsed }}</span>
            <span v-if="stepCount" class="aw-steps">{{ stepCount }} step{{ stepCount !== 1 ? 's' : '' }}</span>
          </div>
        </div>

        <!-- Timeline -->
        <div v-if="steps.length" class="aw-timeline">
          <div
            v-for="(step, i) in steps"
            :key="i"
            class="aw-step"
            :class="{ 'is-current': isCurrentStep(i), 'is-done': isStepDone(i) }"
          >
            <div class="aw-step-rail">
              <div class="aw-step-dot">
                <IconCheck v-if="isStepDone(i)" :size="10" />
                <IconLoader v-else-if="isCurrentStep(i)" :size="10" class="aw-spin" />
                <span v-else class="aw-dot-inner" />
              </div>
              <div v-if="i < steps.length - 1" class="aw-step-line" />
            </div>
            <div class="aw-step-content">
              <div class="aw-step-header">
                <span class="aw-step-name">{{ step.name }}</span>
                <span v-if="stepDuration(i)" class="aw-step-dur">{{ stepDuration(i) }}</span>
              </div>
              <div v-if="stepLogs(i).length" class="aw-step-logs">
                <div v-for="(log, j) in stepLogs(i)" :key="j" class="aw-log">{{ log.message }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Error -->
        <div v-if="isFailed" class="aw-error">
          <IconAlertTriangle :size="14" />
          <span>{{ error }}</span>
        </div>

        <!-- Annotated file banner -->
        <div
          v-if="annotatedPath && isCompleted"
          class="group flex items-start gap-3 px-3.5 py-3 rounded-lg bg-[color-mix(in_srgb,var(--color-add)_6%,transparent)] border border-[color-mix(in_srgb,var(--color-add)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-add)_10%,transparent)] transition-colors"
          @click="revealAnnotated"
        >
          <IconFileCheck :size="15" class="text-[var(--color-add)] shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <span class="block font-sans text-[12.5px] font-semibold text-ink leading-tight">{{ annotatedFilename }}</span>
            <span class="block font-mono text-[10px] text-ink-3 mt-1 truncate">{{ annotatedDir }}</span>
          </div>
          <span class="shrink-0 font-sans text-[10px] text-ink-3 group-hover:text-ink-2 transition-colors mt-0.5">
            <IconFolderOpen :size="14" />
          </span>
        </div>

        <!-- Report -->
        <div v-if="isCompleted && doneSummary" class="aw-result">
          <div class="aw-report-rendered" v-html="renderedReport" />
        </div>

        <!-- Usage -->
        <div v-if="!isRunning && doneUsage" class="aw-usage">
          <span class="aw-usage-item">
            <span class="aw-usage-label">Input</span>
            <span class="aw-usage-value">{{ formatTokens(doneUsage.input_tokens || session.usage?.inputTokens || 0) }}</span>
          </span>
          <span class="aw-usage-sep" />
          <span class="aw-usage-item">
            <span class="aw-usage-label">Output</span>
            <span class="aw-usage-value">{{ formatTokens(doneUsage.output_tokens || session.usage?.outputTokens || 0) }}</span>
          </span>
          <span v-if="costDisplay" class="aw-usage-sep" />
          <span v-if="costDisplay" class="aw-usage-item">
            <span class="aw-usage-label">Cost</span>
            <span class="aw-usage-value">{{ costDisplay }}</span>
          </span>
        </div>

        <!-- Actions -->
        <div class="aw-actions">
          <button v-if="isRunning" class="aw-btn aw-btn--cancel" @click="handleCancel">
            <IconPlayerStop :size="13" />
            Cancel
          </button>
          <template v-else>
            <button class="aw-btn aw-btn--rerun" @click="handleRerun">
              <IconRefresh :size="13" />
              Re-run
            </button>
            <button v-if="doneSummary" class="aw-btn" @click="saveReport">
              <IconDownload :size="13" />
              Save report
            </button>
            <button class="aw-btn aw-btn--done" @click="markDone">
              Done
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { useProjectStore } from '../../stores/panel/projects.js'
import { useAppStore } from '../../stores/panel/apps.js'
import { doneSession, launchApp } from '../../stores/panel/actions.js'
import { formatCost } from '../../stores/panel/helpers.js'
import { IconCheck, IconX, IconLoader, IconAlertTriangle, IconPlayerStop, IconRefresh, IconFileCheck, IconDownload, IconFolderOpen } from '@tabler/icons-vue'

const props = defineProps({
  session: { type: Object, required: true },
  app: { type: Object, default: null },
})

const emit = defineEmits(['cancel'])

const projStore = useProjectStore()
const appStore = useAppStore()
const scrollRef = ref(null)

// Lightweight markdown renderer for review reports
function renderMarkdown(text) {
  if (!text) return ''
  return text
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headings (## and ###)
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Unordered list items
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Numbered list items
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> items in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Paragraphs (double newline)
    .replace(/\n\n+/g, '</p><p>')
    // Single newlines within paragraphs
    .replace(/\n/g, '<br>')
    // Wrap in paragraph tags
    .replace(/^(.+)/, '<p>$1')
    .replace(/(.+)$/, '$1</p>')
    // Clean up empty paragraphs
    .replace(/<p><\/p>/g, '')
    // Clean up paragraphs around block elements
    .replace(/<p>(<h[2-4]>)/g, '$1')
    .replace(/(<\/h[2-4]>)<\/p>/g, '$1')
    .replace(/<p>(<hr>)<\/p>/g, '$1')
    .replace(/<p>(<ul>)/g, '$1')
    .replace(/(<\/ul>)<\/p>/g, '$1')
}

const status = computed(() => props.session.appStatus)
const events = computed(() => props.session.appEvents || [])
const result = computed(() => props.session.appResult)
const error = computed(() => props.session.appError)
const name = computed(() => props.session.appName || props.app?.name || 'App')
const startedAt = computed(() => props.session.appStartedAt)
const completedAt = computed(() => props.session.appCompletedAt)

const isRunning = computed(() => status.value === 'running')
const isCompleted = computed(() => status.value === 'completed')
const isFailed = computed(() => status.value === 'failed' || status.value === 'aborted')

const badgeClass = computed(() => ({
  'aw-badge--running': isRunning.value,
  'aw-badge--done': isCompleted.value,
  'aw-badge--error': isFailed.value,
}))

const badgeLabel = computed(() => {
  if (isRunning.value) return 'Running'
  if (isCompleted.value) return 'Completed'
  if (status.value === 'aborted') return 'Cancelled'
  return 'Failed'
})

const projectName = computed(() =>
  projStore.projects.find((p) => p.id === props.session.projectId)?.name || 'Personal'
)

const steps = computed(() => events.value.filter((e) => e.type === 'step'))
const stepCount = computed(() => steps.value.length)

const currentStepIndex = computed(() => steps.value.length - 1)

function isStepDone(i) {
  if (isRunning.value && i === currentStepIndex.value) return false
  return !isRunning.value || i < currentStepIndex.value
}

function isCurrentStep(i) {
  return isRunning.value && i === currentStepIndex.value
}

function stepLogs(i) {
  const allEvents = events.value
  const step = steps.value[i]
  const stepIdx = allEvents.indexOf(step)
  const nextStep = steps.value[i + 1]
  const endIdx = nextStep ? allEvents.indexOf(nextStep) : allEvents.length
  return allEvents.slice(stepIdx + 1, endIdx).filter((e) => e.type === 'log')
}

function stepDuration(i) {
  const step = steps.value[i]
  const next = steps.value[i + 1]
  if (!step?.time) return ''
  const end = next?.time || (isStepDone(i) ? (completedAt.value ? Date.parse(completedAt.value) : Date.now()) : null)
  if (!end) return ''
  const ms = end - step.time
  if (ms < 1000) return '<1s'
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

// Elapsed timer
const elapsedMs = ref(0)
let elapsedTimer = null

function updateElapsed() {
  if (!startedAt.value) return
  const start = Date.parse(startedAt.value)
  const end = completedAt.value ? Date.parse(completedAt.value) : Date.now()
  elapsedMs.value = end - start
}

function startTimer() {
  stopTimer()
  updateElapsed()
  if (isRunning.value) {
    elapsedTimer = setInterval(updateElapsed, 1000)
  }
}

function stopTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
}

watch(isRunning, (running) => {
  if (running) startTimer()
  else { updateElapsed(); stopTimer() }
}, { immediate: true })

onUnmounted(stopTimer)

const elapsed = computed(() => {
  const ms = elapsedMs.value
  if (ms < 1000) return ''
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m ${s}s`
})

// Done event data
const doneEvent = computed(() => events.value.find((e) => e.type === 'done'))
const doneSummary = computed(() => doneEvent.value?.summary)
const doneUsage = computed(() => doneEvent.value?.usage)

const renderedReport = computed(() => renderMarkdown(doneSummary.value))

const annotatedPath = computed(() => {
  // Check result object first
  if (result.value?.annotatedPath) return result.value.annotatedPath
  // Fall back to scanning log events for the output path
  const logs = events.value.filter(e => e.type === 'log')
  const pathLog = logs.find(l => l.message?.startsWith('Reviewed copy:'))
  if (pathLog) return pathLog.message.replace('Reviewed copy: ', '').trim()
  return null
})

const annotatedFilename = computed(() => {
  const p = annotatedPath.value
  if (!p) return ''
  return p.split(/[/\\]/).pop() || p
})

const annotatedDir = computed(() => {
  const p = annotatedPath.value
  if (!p) return ''
  const parts = p.split(/[/\\]/)
  parts.pop()
  return parts.join('/') || '/'
})

async function revealAnnotated() {
  if (!annotatedPath.value) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_finder', { path: annotatedPath.value })
  } catch (e) {
    console.warn('[AppStandard] reveal failed:', e)
  }
}

const costDisplay = computed(() => {
  const cost = doneUsage.value?.cost || props.session.usage?.estimatedCost
  if (!cost || cost <= 0) return ''
  return formatCost(cost)
})

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// Auto-scroll during run
watch(() => events.value.length, () => {
  if (!isRunning.value) return
  requestAnimationFrame(() => {
    scrollRef.value?.scrollTo({ top: scrollRef.value.scrollHeight, behavior: 'smooth' })
  })
})

function handleCancel() {
  emit('cancel')
}

async function handleRerun() {
  const appId = props.session.appId
  const projectId = props.session.projectId
  if (appId) {
    await launchApp(appId, projectId)
  }
}

async function saveReport() {
  const text = doneSummary.value
  if (!text) return
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { invoke } = await import('@tauri-apps/api/core')
    const defaultName = `${(name.value || 'report').replace(/[^a-zA-Z0-9_-]/g, '_')}_review.md`
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (filePath) await invoke('write_text_file', { path: filePath, content: text })
  } catch (e) {
    console.warn('[AppStandard] save report failed:', e)
  }
}

function markDone() {
  doneSession()
}
</script>

<style scoped>
.aw-main {
  position: relative;
  flex: 1; display: flex; flex-direction: column;
  min-width: 0; background: var(--color-chrome-high);
  overflow: hidden;
}
.aw-scroll {
  flex: 1; overflow-y: auto; padding: 0 24px;
}
.aw-scroll::-webkit-scrollbar { width: 4px; }
.aw-scroll::-webkit-scrollbar-track { background: transparent; }
.aw-scroll::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }

.aw-inner {
  max-width: 560px; width: 100%; margin: 0 auto;
  padding: 48px 0 40px; display: flex; flex-direction: column; gap: 20px;
}

/* ---- Header ---- */
.aw-header { display: flex; flex-direction: column; gap: 6px; }

.aw-header-top {
  display: flex; align-items: flex-start; gap: 10px;
}

.aw-icon {
  font-size: 20px; line-height: 1; flex-shrink: 0; margin-top: 2px;
}

.aw-title-block { flex: 1; min-width: 0; }

.aw-title {
  font-family: var(--font-sans); font-size: 17px; font-weight: 400;
  color: var(--color-ink); line-height: 1.3; margin: 0;
}

.aw-project {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
  margin-top: 2px; display: block;
}

.aw-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-sans); font-size: 10.5px; font-weight: 600;
  padding: 3px 8px; border-radius: 10px;
  flex-shrink: 0; letter-spacing: 0.2px; text-transform: uppercase;
}
.aw-badge--running {
  color: var(--color-ink-2); background: var(--color-chrome);
}
.aw-badge--done {
  color: var(--color-add); background: color-mix(in srgb, var(--color-add) 10%, transparent);
}
.aw-badge--error {
  color: var(--color-rem); background: color-mix(in srgb, var(--color-rem) 10%, transparent);
}

.aw-header-meta {
  display: flex; align-items: center; gap: 10px;
  padding-left: 30px;
  font-family: var(--font-mono); font-size: 10.5px; color: var(--color-ink-3);
}

/* ---- Timeline ---- */
.aw-timeline {
  display: flex; flex-direction: column;
}

.aw-step {
  display: flex; gap: 12px; min-height: 28px;
}

.aw-step-rail {
  display: flex; flex-direction: column; align-items: center;
  width: 18px; flex-shrink: 0;
}

.aw-step-dot {
  width: 18px; height: 18px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  background: var(--color-chrome); color: var(--color-ink-3);
  border: 1.5px solid var(--color-rule);
  transition: all 200ms ease;
}
.aw-step.is-done .aw-step-dot {
  background: color-mix(in srgb, var(--color-add) 12%, transparent);
  border-color: var(--color-add); color: var(--color-add);
}
.aw-step.is-current .aw-step-dot {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  border-color: var(--color-accent); color: var(--color-accent);
}

.aw-dot-inner {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--color-ink-3);
}

.aw-step-line {
  width: 1.5px; flex: 1; min-height: 8px;
  background: var(--color-rule);
  margin: 2px 0;
}
.aw-step.is-done .aw-step-line {
  background: color-mix(in srgb, var(--color-add) 40%, var(--color-rule));
}

.aw-step-content {
  flex: 1; min-width: 0; padding-bottom: 12px;
}

.aw-step-header {
  display: flex; align-items: center; gap: 8px;
  min-height: 18px;
}

.aw-step-name {
  font-family: var(--font-sans); font-size: 12.5px; font-weight: 500;
  color: var(--color-ink);
}
.aw-step.is-current .aw-step-name { color: var(--color-accent); }

.aw-step-dur {
  font-family: var(--font-mono); font-size: 10px; color: var(--color-ink-3);
}

.aw-step-logs {
  display: flex; flex-direction: column; gap: 1px;
  margin-top: 4px;
}

.aw-log {
  font-family: var(--font-mono); font-size: 11px; color: var(--color-ink-3);
  line-height: 1.5;
}

/* ---- Error ---- */
.aw-error {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 12px; border-radius: 8px;
  background: color-mix(in srgb, var(--color-rem) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-rem) 20%, transparent);
  color: var(--color-rem);
  font-family: var(--font-sans); font-size: 12px; line-height: 1.5;
}
.aw-error svg { flex-shrink: 0; margin-top: 1px; }

/* ---- Result ---- */
.aw-result {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px; border-radius: 8px;
  background: var(--color-chrome-mid); border: 1px solid var(--color-rule-light);
}

/* ---- Rendered report ---- */
.aw-report-rendered {
  font-family: var(--font-sans); font-size: 13px; color: var(--color-ink);
  line-height: 1.6;
}
.aw-report-rendered h2 {
  font-family: var(--font-sans); font-size: 16px; font-weight: 400;
  margin: 20px 0 8px; color: var(--color-ink);
}
.aw-report-rendered h3 {
  font-size: 13.5px; font-weight: 600;
  margin: 16px 0 6px; color: var(--color-ink);
}
.aw-report-rendered h4 {
  font-size: 12.5px; font-weight: 600;
  margin: 12px 0 4px; color: var(--color-ink-2);
}
.aw-report-rendered p {
  margin: 0 0 8px;
}
.aw-report-rendered ul {
  margin: 4px 0 8px; padding-left: 20px;
}
.aw-report-rendered li {
  margin-bottom: 4px;
}
.aw-report-rendered strong { font-weight: 600; }
.aw-report-rendered em { font-style: italic; }
.aw-report-rendered code {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--color-chrome); padding: 1px 4px; border-radius: 3px;
}
.aw-report-rendered hr {
  border: none; border-top: 1px solid var(--color-rule-light);
  margin: 16px 0;
}
.aw-report-rendered h2:first-child,
.aw-report-rendered h3:first-child { margin-top: 0; }

/* ---- Usage ---- */
.aw-usage {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 8px;
  background: var(--color-chrome); border: 1px solid var(--color-rule-light);
}

.aw-usage-item {
  display: flex; flex-direction: column; gap: 1px;
}

.aw-usage-label {
  font-family: var(--font-sans); font-size: 10px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--color-ink-3);
}

.aw-usage-value {
  font-family: var(--font-mono); font-size: 12px; font-weight: 500;
  color: var(--color-ink-2);
}

.aw-usage-sep {
  width: 1px; height: 24px; background: var(--color-rule-light);
}

/* ---- Actions ---- */
.aw-actions {
  display: flex; align-items: center; gap: 8px;
}

.aw-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 7px;
  font-family: var(--font-sans); font-size: 12px; font-weight: 500;
  border: 1px solid var(--color-rule); background: var(--color-chrome-mid);
  color: var(--color-ink-2);
}
.aw-btn:hover { background: var(--color-chrome-high); border-color: var(--color-rule); color: var(--color-ink); }

.aw-btn--cancel {
  border-color: color-mix(in srgb, var(--color-rem) 30%, var(--color-rule));
  color: var(--color-rem);
}
.aw-btn--cancel:hover {
  background: color-mix(in srgb, var(--color-rem) 8%, transparent);
  border-color: var(--color-rem);
}

.aw-btn--rerun {
  background: var(--color-accent); border-color: var(--color-accent);
  color: var(--color-accent-ink); font-weight: 600;
}
.aw-btn--rerun:hover { opacity: 0.9; }

.aw-btn--done {
  border-color: var(--color-rule); background: var(--color-chrome-mid);
  color: var(--color-ink-2); font-weight: 500;
}
.aw-btn--done:hover { background: var(--color-chrome-high); color: var(--color-ink); }

.aw-spin { animation: aw-spin 1s linear infinite; }
@keyframes aw-spin { to { transform: rotate(360deg); } }
</style>
