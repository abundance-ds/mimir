<template>
  <section
    data-terminal-activity
    :data-activity-id="activityId"
    :data-mode="mode"
    :data-status="status"
    class="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    @pointerdown="focusTerminal"
  >
    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-rule bg-chrome-high px-2"
      :aria-label="`${activity.title} terminal controls`"
    >
      <div
        aria-hidden="true"
        class="grid h-6 w-6 shrink-0 place-items-center border border-rule bg-surface font-mono text-[9px] font-semibold text-ink-2"
      >
        <IconRobot v-if="mode === 'agent'" :size="13" :stroke-width="1.7" />
        <IconTerminal2 v-else :size="13" :stroke-width="1.7" />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[11px] font-semibold">{{ activity.title }}</span>
          <span class="truncate font-mono text-[9px] text-ink-3">
            {{ activity.workspacePath || activity.launch?.cwd || 'local' }}
          </span>
        </div>
        <span class="block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-3">
          {{ mode === 'agent' ? 'Agent session' : 'Terminal' }}
        </span>
      </div>

      <div
        data-terminal-status
        role="status"
        aria-live="polite"
        class="mr-1 flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-ink-3"
      >
        <span
          aria-hidden="true"
          class="h-1.5 w-1.5 rounded-full"
          :class="statusSignalClass"
        />
        <span>{{ statusLabel }}</span>
      </div>

      <button
        v-if="live"
        type="button"
        data-terminal-paste
        title="Paste from clipboard"
        aria-label="Paste from clipboard"
        class="grid h-7 w-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        @pointerdown.stop
        @click.stop="pasteFromClipboard"
      >
        <IconClipboard :size="13" :stroke-width="1.7" />
      </button>
      <button
        v-if="live"
        type="button"
        data-terminal-interrupt
        title="Interrupt process (Ctrl-C)"
        aria-label="Interrupt process"
        class="grid h-7 w-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        @pointerdown.stop
        @click.stop="interrupt"
      >
        <IconPlayerPause :size="13" :stroke-width="1.7" />
      </button>
      <button
        v-if="live"
        type="button"
        data-terminal-stop
        title="Stop process"
        aria-label="Stop process"
        :disabled="stopping"
        class="grid h-7 w-7 shrink-0 place-items-center text-ink-3 hover:bg-rem/10 hover:text-rem focus-visible:outline focus-visible:outline-1 focus-visible:outline-rem disabled:opacity-40"
        @pointerdown.stop
        @click.stop="stop"
      >
        <IconPlayerStop :size="13" :stroke-width="1.7" />
      </button>
      <button
        v-else-if="ended"
        type="button"
        data-terminal-restart
        :title="restartTitle"
        class="flex h-7 shrink-0 items-center gap-1.5 px-2 font-mono text-[9px] font-medium text-ink-2 hover:bg-chrome hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        @pointerdown.stop
        @click.stop="requestRestart"
      >
        <IconRefresh :size="12" :stroke-width="1.7" />
        {{ restartLabel }}
      </button>
    </header>

    <div
      v-if="mode === 'agent' && status === 'needs-input'"
      data-terminal-attention
      role="status"
      class="flex h-7 shrink-0 items-center border-b border-accent/25 bg-accent-soft px-3 font-mono text-[9px] text-accent"
    >
      Input requested · focus the session to continue
    </div>

    <div class="relative min-h-0 flex-1 bg-surface">
      <div
        ref="surface"
        data-terminal-surface
        tabindex="-1"
        role="application"
        :aria-label="`${activity.title} ${mode} session`"
        class="terminal-canvas absolute inset-0 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      />

      <div
        v-if="loading"
        data-terminal-loading
        role="status"
        class="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-rule-light"
      >
        <div class="h-full w-1/3 bg-accent motion-safe:animate-pulse" />
      </div>
    </div>

    <div
      v-if="error"
      data-terminal-error
      role="alert"
      class="shrink-0 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      {{ error }}
    </div>
  </section>
</template>

<script setup>
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  IconClipboard,
  IconPlayerPause,
  IconPlayerStop,
  IconRefresh,
  IconRobot,
  IconTerminal2,
} from '@tabler/icons-vue'
import {
  activitySnapshot,
  listenToActivityEvents,
  resizeActivity,
  stopActivity,
  writeActivity,
} from '../../services/activities.js'
import {
  eventActivityId,
  isEndedStatus,
  orderedReplayChunks,
  readTerminalTheme,
  terminalBytes,
  terminalStatusLabel,
} from './terminalActivity.js'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
  fontSize: { type: Number, default: 12 },
})

const emit = defineEmits([
  'ready',
  'status',
  'exit',
  'interrupt',
  'stop',
  'restart',
  'restart-ready',
])

const surface = ref(null)
const status = ref(props.activity.status || 'starting')
const hasExited = ref(Boolean(props.activity.session?.exit))
const live = ref(!hasExited.value)
const loading = ref(true)
const stopping = ref(false)
const error = ref('')

const activityId = computed(() => props.activity.id)
const mode = computed(() => props.activity.kind === 'agent' ? 'agent' : 'terminal')
const ended = computed(() => hasExited.value || (!live.value && isEndedStatus(status.value)))
const canResume = computed(() => (
  mode.value === 'agent'
  && Boolean(props.activity.host?.resumeStrategy)
  && props.activity.host?.resumeStrategy !== 'none'
))
const restartLabel = computed(() => canResume.value ? 'Resume' : 'Run again')
const restartTitle = computed(() => (
  canResume.value
    ? `Resume the latest ${props.activity.title} session in this workspace`
    : 'Start this Activity again'
))
const statusLabel = computed(() => terminalStatusLabel(status.value))
const statusSignalClass = computed(() => {
  if (status.value === 'working' || status.value === 'needs-input') return 'bg-accent'
  if (status.value === 'done') return 'bg-add'
  if (status.value === 'error') return 'bg-rem'
  if (['idle', 'ready', 'starting'].includes(status.value)) return 'bg-ink-3'
  return 'bg-ink-4'
})

let terminal = null
let fitAddon = null
let webLinksAddon = null
let dataDisposable = null
let resizeObserver = null
let themeObserver = null
let unlistenEvents = null
let disposed = false
let hydrated = false
let lastSequence = 0
let pendingEvents = []
let inputQueue = Promise.resolve()
let resizeFrame = 0
let lastSize = { cols: 0, rows: 0 }

onMounted(initialize)

async function initialize() {
  try {
    terminal = new Terminal({
      theme: readTerminalTheme(),
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: clampFontSize(props.fontSize),
      fontWeight: '400',
      fontWeightBold: '600',
      cursorBlink: true,
      cursorStyle: mode.value === 'agent' ? 'bar' : 'block',
      scrollback: 10_000,
      allowTransparency: false,
      convertEol: false,
    })
    fitAddon = new FitAddon()
    webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(surface.value)
    dataDisposable = terminal.onData((value) => enqueueInput(terminalBytes(value)))
    installResizeObserver()
    installThemeObserver()

    // Subscribe before snapshotting. Output received in the small hydration
    // window is queued, then sequence-deduplicated against replay.
    const stopListening = await listenToActivityEvents(handleActivityEvent)
    if (disposed) {
      stopListening()
      return
    }
    unlistenEvents = stopListening

    scheduleFit()
    const snapshot = await activitySnapshot(activityId.value)
    if (disposed) return
    applySnapshot(snapshot)
    const snapshotEnded = ended.value
    hydrated = true
    const queued = pendingEvents
    pendingEvents = []
    for (const event of queued) applyEvent(event)
    loading.value = false
    emit('ready', { activityId: activityId.value, snapshot })
    if (snapshotEnded) {
      emit('restart-ready', {
        activityId: activityId.value,
        record: snapshot.record,
      })
    }

    if (props.active) {
      await nextTick()
      scheduleFit()
      terminal?.focus()
    }
  } catch (cause) {
    loading.value = false
    error.value = errorMessage(cause, 'Could not attach to this Activity.')
  }
}

function applySnapshot(snapshot) {
  const record = snapshot?.record
  status.value = record?.status || status.value
  hasExited.value = Boolean(record?.session?.exit)
  // Agent status "done" can be a live completion pulse that settles back to
  // idle. A session without an exit record remains interactive.
  live.value = Boolean(snapshot?.live) || Boolean(record?.session && !record.session.exit)
  for (const chunk of orderedReplayChunks(snapshot)) writeOutput(chunk)
  lastSequence = Math.max(
    lastSequence,
    Number(snapshot?.scrollback?.lastSequence || 0),
  )
}

function handleActivityEvent(event) {
  if (eventActivityId(event) !== activityId.value) return
  if (!hydrated) {
    pendingEvents.push(event)
    return
  }
  applyEvent(event)
}

function applyEvent(event) {
  if (event.type === 'output') {
    writeOutput(event)
    return
  }
  if (event.type === 'status') {
    status.value = event.status
    if (!hasExited.value) live.value = true
    emit('status', {
      activityId: activityId.value,
      status: event.status,
      titleHint: event.titleHint || null,
      needsInputIsBlocking: Boolean(event.needsInputIsBlocking),
    })
    return
  }
  if (event.type === 'exit') {
    status.value = event.record?.status || statusFromExit(event.exit?.reason)
    hasExited.value = true
    live.value = false
    stopping.value = false
    emit('exit', event)
    emit('restart-ready', {
      activityId: activityId.value,
      record: event.record || null,
    })
  }
}

function writeOutput(chunk) {
  const sequence = Number(chunk?.sequence || 0)
  if (sequence && sequence <= lastSequence) return
  const bytes = terminalBytes(chunk?.bytes)
  if (bytes.byteLength) terminal?.write(bytes)
  if (sequence) lastSequence = sequence
}

function enqueueInput(bytes) {
  if (!bytes.byteLength || !live.value) return inputQueue
  inputQueue = inputQueue
    .then(() => writeActivity(activityId.value, bytes))
    .then(() => true)
    .catch((cause) => {
      error.value = errorMessage(cause, 'Could not send terminal input.')
      return false
    })
  return inputQueue
}

async function interrupt() {
  const sent = await enqueueInput(Uint8Array.of(3))
  if (sent) emit('interrupt', { activityId: activityId.value })
  terminal?.focus()
}

async function stop() {
  if (stopping.value) return
  stopping.value = true
  error.value = ''
  try {
    await stopActivity(activityId.value)
    emit('stop', { activityId: activityId.value })
  } catch (cause) {
    stopping.value = false
    error.value = errorMessage(cause, 'Could not stop this Activity.')
  }
}

function requestRestart() {
  emit('restart', {
    activityId: activityId.value,
    activity: props.activity,
  })
}

async function pasteFromClipboard() {
  try {
    const value = await navigator.clipboard.readText()
    await pasteText(value)
  } catch (cause) {
    error.value = errorMessage(cause, 'Clipboard access failed.')
  }
}

async function pasteText(value = '') {
  const bytes = terminalBytes(value)
  if (!bytes.byteLength || !live.value) return false
  const sent = await enqueueInput(bytes)
  if (!sent) return false
  terminal?.focus()
  return true
}

function focusTerminal() {
  terminal?.focus()
}

function installResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(surface.value)
}

function scheduleFit() {
  if (disposed || !fitAddon || !terminal || resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    if (disposed || !surface.value) return
    const rect = surface.value.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    try {
      fitAddon.fit()
    } catch {
      return
    }
    const size = { cols: terminal.cols, rows: terminal.rows }
    if (size.cols <= 0 || size.rows <= 0) return
    if (size.cols === lastSize.cols && size.rows === lastSize.rows) return
    lastSize = size
    resizeActivity(activityId.value, size.cols, size.rows).catch(() => {})
  })
}

function installThemeObserver() {
  if (typeof MutationObserver === 'undefined') return
  themeObserver = new MutationObserver(() => {
    if (terminal) terminal.options.theme = readTerminalTheme()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class'],
  })
}

watch(
  () => [props.activity.status, props.activity.session?.exit],
  ([nextStatus, sessionExit]) => {
    if (!nextStatus) return
    status.value = nextStatus
    if (sessionExit) {
      hasExited.value = true
      live.value = false
      stopping.value = false
    } else if (!hasExited.value) {
      live.value = true
    }
  },
)

watch(
  () => props.active,
  async (active) => {
    if (!active || disposed) return
    await nextTick()
    scheduleFit()
    terminal?.focus()
  },
)

watch(
  () => props.fontSize,
  (fontSize) => {
    if (!terminal) return
    terminal.options.fontSize = clampFontSize(fontSize)
    lastSize = { cols: 0, rows: 0 }
    scheduleFit()
  },
)

onBeforeUnmount(() => {
  disposed = true
  hydrated = false
  pendingEvents = []
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  unlistenEvents?.()
  unlistenEvents = null
  dataDisposable?.dispose()
  dataDisposable = null
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  terminal?.dispose()
  terminal = null
  // ActivitySupervisor owns the process. Detaching this renderer surface must
  // never stop, interrupt, or otherwise mutate the running Activity.
})

defineExpose({
  focus: focusTerminal,
  pasteText,
  fit: scheduleFit,
})

function clampFontSize(value) {
  return Math.max(9, Math.min(24, Number(value) || 12))
}

function errorMessage(cause, fallback) {
  return cause instanceof Error ? cause.message : String(cause || fallback)
}

function statusFromExit(reason) {
  return {
    completed: 'done',
    failed: 'error',
    stopped: 'stopped',
    interrupted: 'interrupted',
  }[reason] || 'stopped'
}
</script>

<style scoped>
.terminal-canvas {
  contain: strict;
}

.terminal-canvas :deep(.xterm) {
  height: 100%;
  padding: 10px 10px 8px 12px;
}

.terminal-canvas :deep(.xterm-viewport) {
  overflow-y: auto;
}

.terminal-canvas :deep(.xterm-viewport::-webkit-scrollbar) {
  width: 4px;
}

.terminal-canvas :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: var(--color-rule);
  border-radius: 0;
}

.terminal-canvas :deep(.xterm-screen canvas) {
  image-rendering: auto;
}
</style>
