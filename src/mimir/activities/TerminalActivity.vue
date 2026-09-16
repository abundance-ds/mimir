<template>
  <section
    data-terminal-activity
    :data-activity-id="activityId"
    :data-mode="mode"
    :data-status="status"
    class="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    @pointerdown="focusTerminal"
  >
    <Teleport v-if="active" to="[data-pane-actions='activity']">
      <div
        data-terminal-controls
        :aria-label="`${activity.title} process controls`"
        class="flex items-center"
      >
        <button
          v-if="live && mode === 'terminal'"
          type="button"
          data-terminal-interrupt
          title="Interrupt command (Ctrl-C)"
          aria-label="Interrupt command (Ctrl-C)"
          class="pane-icon-button"
          @pointerdown.stop
          @click.stop="interrupt"
        >
          <IconPlayerStop :size="15" :stroke-width="1.8" />
        </button>
        <button
          v-else-if="ended && status !== 'interrupted'"
          type="button"
          data-terminal-restart
          :data-resume-emphasis="canResume ? 'accent' : 'neutral'"
          :title="restartTitle"
          class="flex h-7 shrink-0 items-center gap-1.5 border px-2 font-mono text-[9px] font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          :class="canResume
            ? 'border-accent/40 bg-accent-soft text-accent hover:border-accent hover:bg-accent hover:text-accent-ink'
            : 'border-transparent text-ink-2 hover:bg-chrome hover:text-ink'"
          @pointerdown.stop
          @click.stop="requestRestart"
        >
          <IconRefresh :size="12" :stroke-width="1.7" />
          {{ restartLabel }}
        </button>
      </div>
    </Teleport>

    <div class="relative min-h-0 flex-1 bg-surface">
      <div
        ref="surface"
        data-terminal-surface
        :data-renderer="renderer"
        :data-catching-up="catchingUp"
        :style="{ opacity: loading || catchingUp ? 0 : 1 }"
        tabindex="-1"
        role="application"
        :aria-label="`${activity.title} ${mode} session`"
        class="terminal-canvas absolute overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      />

      <div
        v-if="loading"
        data-terminal-loading
        role="status"
        class="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-rule-light"
      >
        <div class="terminal-loading-bar h-full w-1/3 bg-accent" />
      </div>
    </div>

    <div
      v-if="displayError"
      data-terminal-error
      role="alert"
      class="flex shrink-0 items-start gap-2 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      <span class="min-w-0 flex-1">{{ displayError }}</span>
      <button
        type="button"
        data-terminal-error-dismiss
        title="Dismiss terminal error"
        aria-label="Dismiss terminal error"
        class="grid size-5 shrink-0 place-items-center hover:bg-chrome focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        @click="dismissError"
      >
        <IconX :size="12" :stroke-width="1.8" />
      </button>
    </div>
  </section>
</template>

<script setup>
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  IconPlayerStop,
  IconRefresh,
  IconX,
} from '@tabler/icons-vue'
import {
  attachTerminalActivity,
  checkpointTerminalActivity,
  listenToActivityEvents,
  proposeActivityTitle,
  releaseTerminalActivity,
  resizeActivity,
  writeActivity,
} from '../../services/activities.js'
import { getDataDir } from '../../services/dataDir.js'
import {
  eventActivityId,
  isEndedStatus,
  prepareTerminalFonts,
  readTerminalTheme,
  terminalBytes,
} from './terminalActivity.js'
import { graphLinkId } from '../../editor/codemirror/graphLinkSyntax.js'
import { createTerminalLinkProvider } from './terminalLinks.js'
import { createTerminalPromptTitleTracker } from './terminalPromptTitle.js'
import { openExternalUrl } from '../../services/externalLinks.js'
import { SYSTEM_MONO_FONT_STACK } from '../../shared/fonts.js'
import { parentPath } from '../../shared/utils/path.js'

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
  fontSize: { type: Number, default: 12 },
  restoring: { type: Boolean, default: false },
})

const emit = defineEmits([
  'ready',
  'exit',
  'interrupt',
  'restart',
  'restart-ready',
  'activity-input',
  'diagnostic',
  'open-file',
  'open-graph-node',
  'surface-error',
])

const surface = ref(null)
const status = ref(props.activity.status || 'starting')
const hasExited = ref(Boolean(props.activity.session?.exit))
const live = ref(status.value !== 'interrupted' && !hasExited.value)
const loading = ref(true)
const catchingUp = ref(false)
const error = ref('')
const dismissedActivityError = ref('')
const renderer = ref('dom')

const CHECKPOINT_FORMAT_VERSION = 1
const XTERM_VERSION = '6.0.0'
const UNICODE_VERSION = '11'
const CHECKPOINT_QUIET_MS = 750
const CHECKPOINT_MAX_MS = 30_000
const CHECKPOINT_OUTPUT_BYTES = 512 * 1024
const OUTPUT_BATCH_BYTES = 256 * 1024

const activityId = computed(() => props.activity.id)
const mode = computed(() => props.activity.kind === 'agent' ? 'agent' : 'terminal')
const ended = computed(() => hasExited.value || (!live.value && isEndedStatus(status.value)))
const displayError = computed(() => error.value || (
  props.activity.error !== dismissedActivityError.value
    ? props.activity.error || ''
    : ''
))
const canResume = computed(() => (
  mode.value === 'agent'
  && Boolean(props.activity.host?.resumeStrategy)
  && props.activity.host?.resumeStrategy !== 'none'
  && Boolean(props.activity.session?.cliSessionId)
))
const restartLabel = computed(() => canResume.value ? 'Resume' : 'Run again')
const restartTitle = computed(() => (
  canResume.value
    ? `Resume this exact ${props.activity.title} session`
    : 'Start this Activity again'
))
let terminal = null
let fitAddon = null
let serializeAddon = null
let webglAddon = null
let webglContextLossDisposable = null
let terminalLinkDisposable = null
let terminalHomeDirectory = ''
let dataDisposable = null
let resizeObserver = null
let themeObserver = null
let unlistenEvents = null
let disposed = false
let hydrated = false
let initialAttachComplete = false
let appliedSequence = 0
let queuedSequence = 0
let pendingEvents = []
let inputQueue = Promise.resolve()
let terminalEventQueue = Promise.resolve()
let queuedTerminalEvents = []
let drainingTerminalEvents = false
let terminalOutputFailed = false
let revealFrame = 0
let terminalAttachmentQueue = Promise.resolve()
let resizeFrame = 0
let lastSize = { cols: 0, rows: 0 }
let entryFocusRequested = false
let ownerId = crypto.randomUUID()
let runId = ''
let leaseGeneration = 0
let checkpointRevision = 0
let checkpointThroughSequence = 0
let checkpointTimer = 0
let checkpointInFlight = null
let checkpointAgain = false
let outputBytesSinceCheckpoint = 0
let lastCheckpointAt = performance.now()
const promptTitleTracker = createTerminalPromptTitleTracker()
let titleProposalInFlight = null

onMounted(initialize)

async function initialize() {
  try {
    const fontSize = clampFontSize(props.fontSize)
    const [, homeDirectory] = await Promise.all([
      prepareTerminalFonts(fontSize),
      getDataDir()
        .then(directory => parentPath(directory) || '')
        .catch(() => ''),
    ])
    terminalHomeDirectory = homeDirectory
    if (disposed || !surface.value) return
    terminal = new Terminal({
      theme: readTerminalTheme(),
      fontFamily: SYSTEM_MONO_FONT_STACK,
      fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: mode.value === 'agent' ? 'bar' : 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 10_000,
      allowTransparency: false,
      convertEol: false,
      customGlyphs: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 3,
      linkHandler: {
        activate: (_event, uri) => openTerminalUrl(uri),
      },
      // The Unicode 11 addon registers itself through xterm's proposed API.
      allowProposedApi: true,
    })
    fitAddon = new FitAddon()
    serializeAddon = new SerializeAddon()
    terminalLinkDisposable = terminal.registerLinkProvider(createTerminalLinkProvider(terminal, {
      baseDirectory: () => props.activity.launch?.cwd || props.activity.workspacePath || '',
      homeDirectory: () => terminalHomeDirectory,
      onOpenFile: reference => emit('open-file', reference),
      onOpenUrl: openTerminalUrl,
    }))
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon((_event, uri) => openTerminalUrl(uri)))
    terminal.loadAddon(new Unicode11Addon())
    terminal.loadAddon(serializeAddon)
    terminal.unicode.activeVersion = UNICODE_VERSION
    terminal.attachCustomKeyEventHandler(handleCustomKey)
    terminal.open(surface.value)

    // Listen before reading the durable restore state. Events that arrive
    // during the native read stay queued and are de-duplicated by sequence.
    const stopListening = await listenToActivityEvents(handleActivityEvent)
    if (disposed) {
      stopListening()
      return
    }
    unlistenEvents = stopListening
    window.addEventListener('focus', showCurrentTerminal)
    document.addEventListener('visibilitychange', showCurrentTerminal)
    await serializeTerminalAttachment(() => attachTerminalRun())
    initialAttachComplete = true
    await reconcileAttachedTerminalRun(props.activity.session?.runId)
    if (disposed || !surface.value) return
    if (entryFocusRequested && props.active) focusTerminal()
    else entryFocusRequested = false
    installWebglRenderer()
    dataDisposable = terminal.onData((value) => enqueueInput(
      terminalBytes(value),
      { type: 'feed', value },
    ))
    if (props.active) activateSurface()
    loading.value = false
    emit('ready', { activityId: activityId.value, snapshot: null })
    if (ended.value) {
      emit('restart-ready', {
        activityId: activityId.value,
        record: props.activity,
      })
    }
  } catch (cause) {
    terminalOutputFailed = true
    initialAttachComplete = true
    loading.value = false
    exposeSurfaceError(cause, 'Could not attach to this Activity.')
  }
}

async function attachTerminalRun() {
  hydrated = false
  const attachment = await attachTerminalActivity(activityId.value, ownerId)
  if (disposed) {
    await releaseTerminalActivity(
      activityId.value,
      ownerId,
      Number(attachment.leaseGeneration || 0),
    ).catch(() => {})
    return
  }
  runId = attachment.runId
  leaseGeneration = Number(attachment.leaseGeneration || 0)
  checkpointRevision = Number(attachment.revision || 0)
  checkpointThroughSequence = Number(attachment.checkpoint?.throughSequence || 0)
  appliedSequence = Number(attachment.baseSequence || 0)
  queuedSequence = appliedSequence
  outputBytesSinceCheckpoint = 0
  lastCheckpointAt = performance.now()

  const record = attachment.record
  status.value = record?.status || status.value
  hasExited.value = Boolean(record?.session?.exit)
  live.value = status.value !== 'interrupted' && (
    Boolean(attachment.live) || Boolean(record?.session && !record.session.exit)
  )

  const checkpoint = attachment.checkpoint
  if (checkpoint) {
    if (Number(checkpoint.formatVersion) !== CHECKPOINT_FORMAT_VERSION) {
      throw new Error(`Unsupported terminal checkpoint format ${checkpoint.formatVersion}.`)
    }
    terminal.resize(Number(checkpoint.cols || 80), Number(checkpoint.rows || 24))
    await terminalWrite(String(checkpoint.data || ''))
    appliedSequence = Number(checkpoint.throughSequence || 0)
    queuedSequence = appliedSequence
  } else {
    terminal.resize(Number(attachment.cols || 80), Number(attachment.rows || 24))
  }

  for (const event of attachment.events || []) queueTerminalEvent(event)
  await terminalEventQueue
  hydrated = true
  const queued = pendingEvents
  pendingEvents = []
  for (const event of queued) applyEvent(event)
}

function serializeTerminalAttachment(task) {
  const pending = terminalAttachmentQueue.then(task, task)
  terminalAttachmentQueue = pending.catch(() => {})
  return pending
}

function reconcileAttachedTerminalRun(expectedRunId) {
  if (!expectedRunId || disposed || !terminal || !initialAttachComplete) {
    return Promise.resolve()
  }
  return serializeTerminalAttachment(async () => {
    if (disposed || runId === expectedRunId) return
    await resetForTerminalRun()
    await attachTerminalRun()
  })
}

function activateSurface() {
  if (disposed) return
  showCurrentTerminal()
  installResizeObserver()
  installThemeObserver()
  nextTick().then(() => {
    scheduleFit()
    if (activityPaneOwnsFocus()) terminal?.focus()
  })
}

function showCurrentTerminal() {
  if (disposed || !props.active || document.hidden || !terminal) return
  if (appliedSequence >= queuedSequence && !catchingUp.value) return
  catchingUp.value = true
  if (revealFrame) cancelAnimationFrame(revealFrame)
  revealFrame = 0
  // A write can yield across several frames. Reveal only after the model has
  // consumed all queued output and xterm has had a frame to draw that state.
  void terminalEventQueue.then(() => {
    if (disposed || revealFrame) return
    terminal.refresh(0, terminal.rows - 1)
    revealFrame = requestAnimationFrame(() => {
      revealFrame = 0
      if (disposed) return
      if (drainingTerminalEvents) showCurrentTerminal()
      else catchingUp.value = false
    })
  })
}

function deactivateSurface() {
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
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
  if (event.type === 'output' || event.type === 'resize') {
    queueTerminalEvent(event)
    return
  }
  if (event.type === 'status') {
    status.value = event.status
    if (!hasExited.value) live.value = event.status !== 'interrupted'
    return
  }
  if (event.type === 'exit') {
    status.value = event.record?.status || statusFromExit(event.exit?.reason)
    hasExited.value = true
    live.value = false
    emit('exit', event)
    emit('restart-ready', {
      activityId: activityId.value,
      record: event.record || null,
    })
    void persistCheckpoint(true)
  }
}

function queueTerminalEvent(event) {
  if (terminalOutputFailed) return terminalEventQueue
  const sequence = Number(event?.sequence || 0)
  if (!sequence || sequence <= queuedSequence) return terminalEventQueue
  queuedSequence = sequence
  queuedTerminalEvents.push(event)
  if (drainingTerminalEvents) return terminalEventQueue
  drainingTerminalEvents = true
  terminalEventQueue = terminalEventQueue.then(async () => {
    try {
      while (queuedTerminalEvents.length) {
        const next = queuedTerminalEvents.shift()
        let throughSequence = Number(next.sequence)
        if (next.type === 'resize') {
          const cols = Number(next.cols || 0)
          const rows = Number(next.rows || 0)
          if (cols > 0 && rows > 0 && (terminal.cols !== cols || terminal.rows !== rows)) {
            terminal.resize(cols, rows)
          }
        } else {
          // One timer per event turns a background backlog into a visible replay.
          // Combine raw bytes, with a bounded write and a strict resize barrier.
          const chunks = [terminalBytes(next.bytes)]
          let length = chunks[0].byteLength
          while (queuedTerminalEvents[0]?.type === 'output') {
            const chunk = terminalBytes(queuedTerminalEvents[0].bytes)
            if (length + chunk.byteLength > OUTPUT_BATCH_BYTES) break
            throughSequence = Number(queuedTerminalEvents.shift().sequence)
            chunks.push(chunk)
            length += chunk.byteLength
          }
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          if (bytes.byteLength) {
            await terminalWrite(bytes)
            outputBytesSinceCheckpoint += bytes.byteLength
          }
        }
        // Advance only after the write callback: checkpoints must describe
        // parsed state, never data that is still waiting inside xterm.
        appliedSequence = throughSequence
        scheduleCheckpoint()
      }
    } catch (cause) {
      // A rejected write or resize can leave a partial model. Do not save it
      // or advance across the missing event; native retains the recovery tail.
      terminalOutputFailed = true
      queuedTerminalEvents = []
      exposeSurfaceError(cause, 'Could not apply terminal output.')
    } finally {
      drainingTerminalEvents = false
    }
  })
  return terminalEventQueue
}

function terminalWrite(value) {
  if (!value?.length) return Promise.resolve()
  return new Promise((resolve) => terminal.write(value, resolve))
}

function scheduleCheckpoint() {
  if (terminalOutputFailed || !serializeAddon || appliedSequence <= checkpointThroughSequence) return
  if (checkpointTimer) clearTimeout(checkpointTimer)
  const elapsed = performance.now() - lastCheckpointAt
  const immediate = outputBytesSinceCheckpoint >= CHECKPOINT_OUTPUT_BYTES
    || elapsed >= CHECKPOINT_MAX_MS
  checkpointTimer = window.setTimeout(() => {
    checkpointTimer = 0
    void persistCheckpoint()
  }, immediate ? 0 : Math.min(CHECKPOINT_QUIET_MS, CHECKPOINT_MAX_MS - elapsed))
}

async function persistCheckpoint(force = false) {
  if (terminalOutputFailed || !serializeAddon || !runId || !leaseGeneration) return null
  if (checkpointInFlight) {
    checkpointAgain = checkpointAgain || force || appliedSequence > checkpointThroughSequence
    return checkpointInFlight
  }
  await terminalEventQueue
  if (terminalOutputFailed) return null
  // Another caller can start while both calls wait for xterm to finish its
  // asynchronous write. Re-check here so only one request uses this revision.
  if (checkpointInFlight) {
    checkpointAgain = checkpointAgain || force || appliedSequence > checkpointThroughSequence
    return checkpointInFlight
  }
  if (!force && appliedSequence <= checkpointThroughSequence) return null
  if (appliedSequence < checkpointThroughSequence) return null

  const expectedRunId = runId
  const expectedLease = leaseGeneration
  const throughSequence = appliedSequence
  const baseRevision = checkpointRevision
  const request = {
    activityId: activityId.value,
    runId: expectedRunId,
    ownerId,
    leaseGeneration: expectedLease,
    baseRevision,
    throughSequence,
    cols: terminal.cols,
    rows: terminal.rows,
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    engineVersion: XTERM_VERSION,
    unicodeVersion: UNICODE_VERSION,
    data: serializeAddon.serialize({ scrollback: 10_000 }),
    searchText: terminalSearchText(),
  }
  const pending = checkpointTerminalActivity(request)
    .then((saved) => {
      if (runId !== expectedRunId || leaseGeneration !== expectedLease) return saved
      checkpointRevision = Number(saved.revision || baseRevision)
      checkpointThroughSequence = Number(saved.throughSequence || throughSequence)
      outputBytesSinceCheckpoint = 0
      lastCheckpointAt = performance.now()
      return saved
    })
    .catch((cause) => {
      // A new WebView or respawn intentionally invalidates the old owner.
      if (!disposed && runId === expectedRunId && leaseGeneration === expectedLease) {
        exposeSurfaceError(cause, 'Could not save terminal state.')
      }
      return null
    })
    .finally(() => {
      if (checkpointInFlight === pending) checkpointInFlight = null
      if (checkpointAgain) {
        checkpointAgain = false
        scheduleCheckpoint()
      }
    })
  checkpointInFlight = pending
  return pending
}

function terminalSearchText() {
  const buffer = terminal?.buffer?.active
  if (!buffer) return ''
  const encoder = new TextEncoder()
  const lines = []
  let bytes = 0
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const line = buffer.getLine(index)?.translateToString(true) || ''
    const lineBytes = encoder.encode(`${line}\n`).byteLength
    if (bytes + lineBytes > 4 * 1024 * 1024) break
    lines.push(line)
    bytes += lineBytes
  }
  return lines.reverse().join('\n').replace(/\n+$/, '')
}

function enqueueInput(bytes, promptInput = null) {
  if (!bytes.byteLength || !live.value || props.restoring) return inputQueue
  inputQueue = inputQueue
    .then(async () => {
      await writeActivity(activityId.value, bytes)
      if (submitsTerminalTurn(promptInput)) {
        emit('activity-input', { activityId: activityId.value })
      }
      capturePromptInput(promptInput)
      return true
    })
    .catch((cause) => {
      exposeSurfaceError(cause, 'Could not send terminal input.')
      return false
    })
  return inputQueue
}

function submitsTerminalTurn(input) {
  return Boolean(input) && String(input.value || '').includes('\r')
}

function capturePromptInput(input) {
  if (!input || mode.value !== 'agent') return
  if (props.activity.titleSource !== 'launcher') {
    promptTitleTracker.reset()
    return
  }

  let title = ''
  if (input.type === 'paste') promptTitleTracker.paste(input.value)
  else title = promptTitleTracker.feed(input.value)
  if (!title || titleProposalInFlight) return

  const pending = proposeActivityTitle(activityId.value, title)
    // A title is enhancement data. A failure must not affect the live session.
    .catch(() => null)
    .finally(() => {
      if (titleProposalInFlight === pending) titleProposalInFlight = null
    })
  titleProposalInFlight = pending
}

function handleCustomKey(event) {
  if (event.isComposing) return true
  if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    const input = {
      ArrowLeft: '\u0001',
      ArrowRight: '\u0005',
      // Move to the end first so Ctrl-U clears the complete current line.
      Backspace: '\u0005\u0015',
      Delete: '\u0005\u0015',
    }[event.key]
    const scroll = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (input || scroll) {
      event.preventDefault?.()
      event.stopPropagation?.()
      if (event.type === 'keydown') {
        if (event.key === 'ArrowUp') terminal.scrollToTop()
        else if (event.key === 'ArrowDown') terminal.scrollToBottom()
        else enqueueInput(terminalBytes(input), { type: 'feed', value: input })
      }
      return false
    }
  }
  // Shift+Enter sends LF (Ctrl-J), the multiline binding used by CLI agents.
  if (
    event.key !== 'Enter'
    || !event.shiftKey
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || event.isComposing
  ) return true
  if (event.type === 'keydown') {
    enqueueInput(terminalBytes('\n'), { type: 'feed', value: '\n' })
  }
  return false
}

// WebGL keeps sustained terminal and full-screen TUI output on the GPU. xterm
// starts with its DOM renderer, so initialization failure or context loss can
// fall back without losing the session.
function installWebglRenderer() {
  let addon = null
  let contextLossDisposable = null
  try {
    addon = new WebglAddon()
    contextLossDisposable = addon.onContextLoss(() => {
      if (webglAddon !== addon) return
      webglContextLossDisposable?.dispose()
      webglContextLossDisposable = null
      webglAddon.dispose()
      webglAddon = null
      renderer.value = 'dom'
    })
    terminal.loadAddon(addon)
    webglAddon = addon
    webglContextLossDisposable = contextLossDisposable
    renderer.value = 'webgl'
  } catch {
    contextLossDisposable?.dispose()
    addon?.dispose()
    webglAddon = null
    webglContextLossDisposable = null
    renderer.value = 'dom'
  }
}

async function interrupt() {
  const sent = await enqueueInput(Uint8Array.of(3), { type: 'feed', value: '\u0003' })
  if (sent) emit('interrupt', { activityId: activityId.value })
  terminal?.focus()
}

function requestRestart() {
  emit('restart', {
    activityId: activityId.value,
    activity: props.activity,
  })
}

async function pasteText(value = '') {
  const bytes = terminalBytes(value)
  if (!bytes.byteLength || !live.value) return false
  const sent = await enqueueInput(bytes, { type: 'paste', value })
  if (!sent) return false
  terminal?.focus()
  return true
}

function focusTerminal() {
  if (!props.active || props.restoring) {
    entryFocusRequested = false
    return false
  }
  if (!terminal) {
    entryFocusRequested = true
    return false
  }
  entryFocusRequested = false
  terminal?.focus()
  return true
}

function activityPaneOwnsFocus() {
  const pane = surface.value?.closest?.('[data-pane="activity"]')
  return !pane || pane.contains(document.activeElement)
}

function installResizeObserver() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(surface.value)
}

function scheduleFit() {
  if (disposed || !fitAddon || !terminal || resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    if (disposed || !surface.value) return
    // Measure with the previous snap offset cleared so it never compounds.
    surface.value.style.transform = ''
    const rect = surface.value.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    let proposed
    try {
      proposed = fitAddon.proposeDimensions()
    } catch {
      return
    }
    const renderRect = surface.value
      .querySelector('.xterm-screen canvas, .xterm-screen')
      ?.getBoundingClientRect() || rect
    snapToDeviceGrid(renderRect)
    const size = {
      cols: Number(proposed?.cols || 0),
      rows: Number(proposed?.rows || 0),
    }
    if (size.cols <= 0 || size.rows <= 0) return
    if (size.cols === lastSize.cols && size.rows === lastSize.rows) return
    lastSize = size
    resizeActivity(activityId.value, size.cols, size.rows).catch(() => {
      if (lastSize.cols === size.cols && lastSize.rows === size.rows) {
        lastSize = { cols: 0, rows: 0 }
      }
    })
  })
}

// WebGL glyphs are bitmap blits. Pane splits frequently place their canvas at
// fractional device pixels, so align the rendered screen—not merely its pane—
// to the physical grid and avoid compositor resampling.
function snapToDeviceGrid(rect) {
  const scale = window.devicePixelRatio || 1
  const x = snapDelta(rect.left, scale)
  const y = snapDelta(rect.top, scale)
  if (x || y) surface.value.style.transform = `translate(${x}px, ${y}px)`
}

function snapDelta(value, scale) {
  return Number((Math.round(value * scale) / scale - value).toFixed(3))
}

function installThemeObserver() {
  if (themeObserver || typeof MutationObserver === 'undefined') return
  themeObserver = new MutationObserver(() => {
    if (terminal) terminal.options.theme = readTerminalTheme()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class'],
  })
}

// A respawned session reuses this Activity identity. Native respawn has already
// replaced the old run by the time this prop changes, so the old checkpoint
// lease is stale. Serialize attachments, invalidate that lease without saving,
// and skip the reset when initial attachment already acquired the new run.
watch(
  () => props.activity.session?.runId,
  async (nextRunId, previousRunId) => {
    if (!nextRunId || !previousRunId || nextRunId === previousRunId || disposed) return
    if (!initialAttachComplete) return
    loading.value = true
    try {
      await reconcileAttachedTerminalRun(nextRunId)
    } catch (cause) {
      terminalOutputFailed = true
      exposeSurfaceError(cause, 'Could not attach to the resumed Activity.')
    }
    loading.value = false
    if (props.active) activateSurface()
  },
)

async function resetForTerminalRun() {
  hydrated = false
  pendingEvents = []
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = 0
  checkpointAgain = false
  await terminalEventQueue
  terminalEventQueue = Promise.resolve()
  queuedTerminalEvents = []
  terminalOutputFailed = false

  const previousRunId = runId
  const previousLeaseGeneration = leaseGeneration
  runId = ''
  leaseGeneration = 0
  if (previousRunId && previousLeaseGeneration) {
    await releaseTerminalActivity(
      activityId.value,
      ownerId,
      previousLeaseGeneration,
    ).catch(() => {})
  }

  hasExited.value = false
  live.value = true
  error.value = ''
  appliedSequence = 0
  queuedSequence = 0
  checkpointRevision = 0
  checkpointThroughSequence = 0
  outputBytesSinceCheckpoint = 0
  promptTitleTracker.reset()
  titleProposalInFlight = null
  lastSize = { cols: 0, rows: 0 }
  terminal?.reset()
}

watch(
  () => [props.activity.status, props.activity.session?.exit],
  ([nextStatus, sessionExit]) => {
    if (!nextStatus) return
    status.value = nextStatus
    if (nextStatus === 'interrupted') {
      live.value = false
    } else if (sessionExit) {
      hasExited.value = true
      live.value = false
    } else if (!hasExited.value) {
      live.value = true
    }
  },
)

watch(
  () => props.active,
  (active) => {
    if (disposed) return
    if (!active) {
      deactivateSurface()
      return
    }
    activateSurface()
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

watch(
  () => props.activity.error,
  (nextError) => {
    if (!nextError) dismissedActivityError.value = ''
  },
)

onBeforeUnmount(() => {
  const finalCheckpoint = persistCheckpoint(true)
  const finalRunId = runId
  const finalLeaseGeneration = leaseGeneration
  disposed = true
  hydrated = false
  pendingEvents = []
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = 0
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  if (revealFrame) cancelAnimationFrame(revealFrame)
  revealFrame = 0
  window.removeEventListener('focus', showCurrentTerminal)
  document.removeEventListener('visibilitychange', showCurrentTerminal)
  deactivateSurface()
  unlistenEvents?.()
  unlistenEvents = null
  dataDisposable?.dispose()
  dataDisposable = null
  terminalLinkDisposable?.dispose()
  terminalLinkDisposable = null
  webglContextLossDisposable?.dispose()
  webglContextLossDisposable = null
  void finalCheckpoint.finally(async () => {
    if (finalRunId && finalLeaseGeneration) {
      await releaseTerminalActivity(
        activityId.value,
        ownerId,
        finalLeaseGeneration,
      ).catch(() => {})
    }
    terminal?.dispose()
    terminal = null
    serializeAddon = null
  })
  webglAddon = null
  renderer.value = 'dom'
  // ActivitySupervisor owns the process. Detaching this renderer surface must
  // never stop, interrupt, or otherwise mutate the running Activity.
})

defineExpose({
  focusEntry: focusTerminal,
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

function openTerminalUrl(uri) {
  const id = graphLinkId(uri)
  if (id) {
    emit('open-graph-node', id)
    return
  }
  void openExternalUrl(uri).catch((cause) => {
    emit('diagnostic', `Could not open the link: ${errorMessage(cause, 'Unknown failure')}`)
  })
}

function exposeSurfaceError(cause, fallback) {
  dismissedActivityError.value = ''
  error.value = errorMessage(cause, fallback)
  emit('surface-error', {
    activityId: activityId.value,
    error: error.value,
  })
  return error.value
}

function dismissError() {
  const dismissed = displayError.value
  if (!dismissed) return
  if (error.value === dismissed) error.value = ''
  if (props.activity.error === dismissed) dismissedActivityError.value = dismissed
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
  inset: 8px 4px 6px 8px;
  contain: strict;
}

.terminal-canvas :deep(.xterm) {
  height: 100%;
}

.terminal-canvas :deep(.xterm-viewport) {
  overflow-y: auto;
  /* xterm 6 themes the scroll wrapper, not this element; stock CSS leaves it
     #000, which shows as a black strip below the last row. */
  background-color: transparent;
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

.terminal-loading-bar {
  animation: terminal-loading 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes terminal-loading {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(400%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .terminal-loading-bar {
    animation: none;
  }
}
</style>
