<template>
  <section data-embedded-app class="relative flex h-full min-h-0 flex-col bg-surface text-ink">
    <header data-embedded-app-toolbar class="pane-bar gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="frameReady ? 'bg-add' : error ? 'bg-rem' : 'bg-rule'"
        />
        <span class="truncate font-mono text-[8px] text-ink-3">{{ displayUrl }}</span>
      </div>
      <span
        v-if="app.tools?.length"
        class="font-mono text-[7px] uppercase tracking-[0.1em]"
        :class="toolsReady ? 'text-accent' : 'text-ink-4'"
      >
        {{ toolsReady ? `${app.tools.length} live` : 'tools…' }}
      </span>
      <button
        type="button"
        title="Reload app"
        aria-label="Reload app"
        class="grid size-7 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="reload"
      >
        <IconRefresh :size="13" :stroke-width="1.7" />
      </button>
    </header>

    <div v-if="!frameUrl" class="grid min-h-0 flex-1 place-items-center px-8 text-center">
      <div>
        <IconAlertTriangle :size="21" :stroke-width="1.5" class="mx-auto text-rem" />
        <p class="mt-3 text-[11px] font-semibold">App entry unavailable</p>
        <p class="mt-1 text-[10px] text-ink-3">Reload the app catalog and try again.</p>
      </div>
    </div>

    <div v-else class="relative min-h-0 flex-1 bg-surface">
      <iframe
        :key="reloadToken"
        ref="frame"
        data-app-frame
        :src="frameUrl"
        :title="app.title"
        class="absolute inset-0 size-full border-0 bg-surface"
        @load="onFrameLoad"
        @error="onFrameError"
      />
      <div
        v-if="!frameReady && !error"
        class="pointer-events-none absolute inset-0 grid place-items-center bg-surface/90"
      >
        <div class="text-center">
          <span class="mx-auto block h-px w-16 overflow-hidden bg-rule">
            <span class="block h-full w-1/2 bg-accent motion-safe:animate-pulse" />
          </span>
          <p class="mt-3 font-mono text-[8px] uppercase tracking-[0.14em] text-ink-3">
            Loading {{ app.title }}
          </p>
        </div>
      </div>
    </div>

    <div
      v-if="error"
      data-embedded-error
      role="alert"
      class="flex shrink-0 items-center gap-2 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      <IconAlertTriangle :size="14" :stroke-width="1.6" class="shrink-0" />
      <span class="min-w-0 flex-1">{{ error }}</span>
      <button
        type="button"
        class="h-6 px-2 text-[9px] font-semibold hover:bg-rem/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        @click="reload"
      >
        Reload
      </button>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-vue'
import {
  embeddedAppUrl,
  invokeAppCommand,
  listenForAppTools,
  reconcileAppTools,
  rejectAppTool,
  respondToAppTool,
  unregisterAppTools,
} from '../../services/appsCatalog.js'

const props = defineProps({
  app: { type: Object, required: true },
  launch: { type: Object, required: true },
  workspacePath: { type: String, default: '' },
  instanceId: { type: String, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['openFile', 'diagnostic'])
const frame = ref(null)
const frameReady = ref(false)
const toolsReady = ref(false)
const error = ref('')
const reloadToken = ref(0)
const pendingToolCalls = new Set()
let unlistenTools = null
let disposed = false
let mounted = false
let toolSetupGeneration = 0
let registeredTools = null

const baseUrl = computed(() => embeddedAppUrl(props.app, props.launch))
const frameUrl = computed(() => withContext(baseUrl.value, {
  appId: props.app.id,
  instanceId: props.instanceId,
  workspacePath: props.workspacePath,
}))
const displayUrl = computed(() => {
  try {
    const parsed = new URL(frameUrl.value)
    return parsed.protocol === 'app:'
      ? `${props.app.id}/${parsed.pathname.split('/').filter(Boolean).slice(1).join('/')}`
      : parsed.host || parsed.protocol
  } catch {
    return frameUrl.value || 'No entry'
  }
})
const toolSignature = computed(() => JSON.stringify({
  appId: props.app.id,
  instanceId: props.instanceId,
  tools: props.app.tools || [],
}))
const manifestSignature = computed(() => JSON.stringify({
  app: props.app,
  launch: props.launch,
}))

onMounted(async () => {
  mounted = true
  window.addEventListener('message', onMessage)
  await configureTools()
})

watch(toolSignature, () => {
  if (mounted && !disposed) void configureTools()
})

watch(manifestSignature, (_next, previous) => {
  if (mounted && !disposed && previous !== undefined) reload()
})

async function configureTools() {
  const generation = ++toolSetupGeneration
  toolsReady.value = false
  try {
    await teardownTools()
  } catch (cause) {
    if (!disposed && generation === toolSetupGeneration) {
      reportError(`Previous app tools could not stop cleanly: ${errorMessage(cause)}`)
    }
  }
  if (disposed || generation !== toolSetupGeneration) return

  const tools = Array.isArray(props.app.tools) ? props.app.tools : []
  if (!tools.length) {
    toolsReady.value = true
    return
  }

  const target = {
    appId: props.app.id,
    instanceId: props.instanceId,
  }
  try {
    const unlisten = await listenForAppTools({
      ...target,
      onCall: forwardToolCall,
      onCancel: forwardToolCancellation,
    })
    if (disposed || generation !== toolSetupGeneration) {
      unlisten()
      return
    }
    unlistenTools = unlisten
    registeredTools = target
    await reconcileAppTools({
      ...target,
      tools,
    })
    if (!disposed && generation === toolSetupGeneration) toolsReady.value = true
  } catch (cause) {
    if (!disposed && generation === toolSetupGeneration) {
      reportError(`App tools could not start: ${errorMessage(cause)}`)
    }
  }
}

async function teardownTools() {
  const target = registeredTools
  registeredTools = null
  unlistenTools?.()
  unlistenTools = null
  pendingToolCalls.clear()
  if (target) {
    await unregisterAppTools(target.appId, target.instanceId)
  }
}

function onFrameLoad() {
  frameReady.value = true
  error.value = ''
  postToFrame({
    type: 'mimir:host-ready',
    appId: props.app.id,
    instanceId: props.instanceId,
    workspacePath: props.workspacePath,
  })
}

function onFrameError() {
  reportError(`${props.app.title} could not load its entry.`)
}

function reload() {
  frameReady.value = false
  error.value = ''
  pendingToolCalls.clear()
  reloadToken.value += 1
}

function forwardToolCall(request) {
  if (!request?.id) return
  if (!frameReady.value || !frame.value?.contentWindow) {
    void rejectAppTool(request.id, `${props.app.title} is not ready.`, 'unavailable')
    return
  }
  pendingToolCalls.add(request.id)
  postToFrame({
    type: 'mimir:tool-call',
    id: request.id,
    tool: request.tool,
    input: request.input || {},
    context: request.context || {},
  })
}

function forwardToolCancellation(cancellation) {
  if (!cancellation?.id || !pendingToolCalls.delete(cancellation.id)) return
  postToFrame({
    type: 'mimir:tool-cancel',
    id: cancellation.id,
    reason: cancellation.reason || 'cancelled',
  })
}

async function onMessage(event) {
  if (event.source !== frame.value?.contentWindow) return
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'mimir:ready') {
    frameReady.value = true
    return
  }
  if (message.type === 'mimir:open-file' && message.path) {
    emit('openFile', String(message.path))
    return
  }
  if (message.type === 'mimir:diagnostic' && message.message) {
    emit('diagnostic', String(message.message))
    return
  }
  if (message.type === 'mimir:invoke') {
    await handleInvoke(message)
    return
  }
  if (message.type === 'mimir:tool-response') {
    await handleToolResponse(message)
  }
}

async function handleInvoke(message) {
  if (!message.id || !message.command) return
  try {
    const result = await invokeAppCommand(props.app.id, message.command, message.args)
    postToFrame({ type: 'mimir:result', id: message.id, result, error: null })
  } catch (cause) {
    postToFrame({
      type: 'mimir:result',
      id: message.id,
      result: null,
      error: errorMessage(cause),
    })
  }
}

async function handleToolResponse(message) {
  if (!message.id || !pendingToolCalls.delete(message.id)) return
  try {
    if (message.error) {
      const toolError = typeof message.error === 'object'
        ? message.error
        : { message: String(message.error) }
      await rejectAppTool(
        message.id,
        toolError.message || 'App tool failed.',
        toolError.code || 'handler',
        toolError.data || null,
      )
      return
    }
    await respondToAppTool(message.id, {
      value: message.result?.value ?? message.result ?? null,
      displayText: message.result?.displayText ?? null,
      metadata: message.result?.metadata || {},
    })
  } catch (cause) {
    reportError(`Tool response failed: ${errorMessage(cause)}`)
  }
}

function postToFrame(message) {
  frame.value?.contentWindow?.postMessage(message, '*')
}

function reportError(message) {
  error.value = message
  emit('diagnostic', message)
}

function withContext(url, values) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(values)) {
      if (value) parsed.searchParams.set(key, value)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Unknown app failure')
}

onUnmounted(() => {
  disposed = true
  mounted = false
  toolSetupGeneration += 1
  window.removeEventListener('message', onMessage)
  unlistenTools?.()
  unlistenTools = null
  pendingToolCalls.clear()
  if (registeredTools) {
    const target = registeredTools
    registeredTools = null
    void unregisterAppTools(target.appId, target.instanceId).catch(() => {})
  }
})
</script>
