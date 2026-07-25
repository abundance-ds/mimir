<template>
  <section
    data-scratch-app
    class="flex h-full min-h-0 flex-col bg-surface text-ink"
    @keydown.meta.s.prevent="saveNow"
    @keydown.ctrl.s.prevent="saveNow"
  >
    <header class="flex h-10 shrink-0 items-center gap-3 border-b border-rule bg-chrome-high px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <IconNote :size="14" :stroke-width="1.7" class="shrink-0 text-ink-3" />
        <span class="text-[11px] font-semibold">Scratch</span>
        <span class="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-4">
          durable
        </span>
      </div>
      <span
        data-scratch-save-state
        class="font-mono text-[8px] uppercase tracking-[0.1em]"
        :class="saveStateClass"
      >
        {{ saveStateLabel }}
      </span>
      <button
        type="button"
        data-scratch-save
        :disabled="loading || saving || !dirty"
        class="h-7 border border-rule px-2.5 text-[9px] font-semibold text-ink-2 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="saveNow"
      >
        Save
      </button>
    </header>

    <div v-if="loading" class="grid min-h-0 flex-1 place-items-center bg-surface">
      <div class="text-center">
        <span class="mx-auto block h-px w-14 bg-accent motion-safe:animate-pulse" />
        <p class="mt-3 font-mono text-[8px] uppercase tracking-[0.14em] text-ink-3">
          Restoring scratch
        </p>
      </div>
    </div>

    <div v-else class="relative min-h-0 flex-1 bg-surface">
      <div
        aria-hidden="true"
        class="absolute inset-y-0 left-0 w-9 border-r border-rule-light bg-chrome-high"
      />
      <textarea
        ref="editor"
        v-model="text"
        data-scratch-editor
        aria-label="Scratch text"
        spellcheck="true"
        placeholder="Think here. Agents can read this through app.scratch.read."
        class="absolute inset-0 resize-none bg-transparent py-4 pl-12 pr-5 font-mono text-[12px] leading-[1.8] text-ink outline-none placeholder:text-ink-4 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        @input="markDirty"
      />
    </div>

    <div
      v-if="error"
      data-scratch-error
      role="alert"
      class="flex shrink-0 items-start gap-2 border-t border-rem/30 bg-rem/5 px-3 py-2 text-[10px] text-rem"
    >
      <IconAlertTriangle :size="14" :stroke-width="1.6" class="mt-px shrink-0" />
      <span class="min-w-0 flex-1">{{ error }}</span>
      <button
        type="button"
        class="h-6 shrink-0 px-2 text-[9px] font-semibold hover:bg-rem/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        @click="error = ''"
      >
        Dismiss
      </button>
    </div>

    <footer class="flex h-8 shrink-0 items-center border-t border-rule bg-chrome-high px-3">
      <div
        data-scratch-tool
        class="flex min-w-0 items-center gap-2 font-mono text-[8px]"
        :class="toolReady ? 'text-ink-3' : 'text-ink-4'"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="toolReady ? 'bg-add' : toolError ? 'bg-rem' : 'bg-rule'"
        />
        <span class="truncate">
          {{ toolReady ? 'app.scratch.read live' : toolError || 'Connecting app tool' }}
        </span>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-3 font-mono text-[8px] tabular-nums text-ink-4">
        <span>{{ lineCount }} ln</span>
        <span>{{ text.length }} ch</span>
      </div>
    </footer>
  </section>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { IconAlertTriangle, IconNote } from '@tabler/icons-vue'
import {
  listenForAppTools,
  loadAppData,
  reconcileAppTools,
  rejectAppTool,
  respondToAppTool,
  saveAppData,
  unregisterAppTools,
} from '../../services/appsCatalog.js'

const props = defineProps({
  app: { type: Object, required: true },
  instanceId: { type: String, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['diagnostic'])
const editor = ref(null)
const text = ref('')
const loading = ref(true)
const saving = ref(false)
const dirty = ref(false)
const savedOnce = ref(false)
const error = ref('')
const toolReady = ref(false)
const toolError = ref('')
let saveTimer = null
let unlistenTools = null
let disposed = false
let lastUpdatedAt = null

const lineCount = computed(() => text.value ? text.value.split(/\r?\n/).length : 1)
const saveStateLabel = computed(() => {
  if (loading.value) return 'Loading'
  if (saving.value) return 'Saving'
  if (dirty.value) return 'Unsaved'
  return savedOnce.value ? 'Saved' : 'Ready'
})
const saveStateClass = computed(() => {
  if (error.value) return 'text-rem'
  if (dirty.value) return 'text-accent'
  if (saving.value) return 'text-ink-2'
  return 'text-ink-4'
})

onMounted(async () => {
  try {
    unlistenTools = await listenForAppTools({
      appId: props.app.id,
      instanceId: props.instanceId,
      onCall: handleToolCall,
      onCancel: () => {},
    })
    if (disposed) {
      unlistenTools()
      return
    }
    await Promise.all([restore(), registerTools()])
  } catch (cause) {
    reportError(`Scratch could not start: ${errorMessage(cause)}`)
    loading.value = false
  }
})

watch(() => props.active, async (active) => {
  if (!active) return
  await nextTick()
  editor.value?.focus()
}, { immediate: true })

async function restore() {
  try {
    const raw = await loadAppData(props.app.id, 'scratch')
    if (disposed) return
    if (raw != null) {
      const saved = JSON.parse(raw)
      text.value = typeof saved === 'string' ? saved : String(saved?.text || '')
      lastUpdatedAt = typeof saved === 'object' ? saved?.updatedAt || null : null
    }
  } catch (cause) {
    reportError(`Scratch text could not be restored: ${errorMessage(cause)}`)
  } finally {
    loading.value = false
    if (props.active) await nextTick(() => editor.value?.focus())
  }
}

async function registerTools() {
  try {
    await reconcileAppTools({
      appId: props.app.id,
      instanceId: props.instanceId,
      tools: props.app.tools || [],
    })
    if (!disposed) toolReady.value = true
  } catch (cause) {
    toolError.value = `Tool unavailable: ${errorMessage(cause)}`
    emit('diagnostic', toolError.value)
  }
}

function markDirty() {
  dirty.value = true
  savedOnce.value = false
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persist(), 350)
}

function saveNow() {
  clearTimeout(saveTimer)
  return persist()
}

async function persist() {
  if (!dirty.value || saving.value) return
  const snapshot = text.value
  saving.value = true
  try {
    const updatedAt = new Date().toISOString()
    await saveAppData(props.app.id, 'scratch', JSON.stringify({
      version: 1,
      text: snapshot,
      updatedAt,
    }))
    lastUpdatedAt = updatedAt
    if (text.value === snapshot) {
      dirty.value = false
      savedOnce.value = true
    } else {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void persist(), 350)
    }
  } catch (cause) {
    reportError(`Scratch could not save: ${errorMessage(cause)}`)
  } finally {
    saving.value = false
  }
}

async function handleToolCall(request) {
  if (!request?.id) return
  if (request.tool !== `app.${props.app.id}.read`) {
    await rejectAppTool(request.id, `Scratch does not handle '${request.tool}'.`, 'not_found')
    return
  }
  try {
    const value = {
      text: text.value,
      characters: text.value.length,
      lines: lineCount.value,
      updatedAt: lastUpdatedAt,
    }
    await respondToAppTool(request.id, {
      value,
      displayText: text.value || '(Scratch is empty.)',
    })
  } catch (cause) {
    reportError(`Scratch tool response failed: ${errorMessage(cause)}`)
  }
}

function reportError(message) {
  error.value = message
  emit('diagnostic', message)
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause || 'Unknown failure')
}

onUnmounted(() => {
  disposed = true
  clearTimeout(saveTimer)
  if (dirty.value && !saving.value) void persist()
  unlistenTools?.()
  void unregisterAppTools(props.app.id, props.instanceId).catch(() => {})
})
</script>
