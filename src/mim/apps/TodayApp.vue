<template>
  <section
    data-today-app
    class="flex h-full min-h-0 w-full flex-col bg-surface text-ink"
    @keydown.meta.s.prevent="saveNow"
    @keydown.ctrl.s.prevent="saveNow"
  >
    <header class="flex h-10 shrink-0 items-center gap-4 border-b border-rule bg-chrome-high px-4">
      <span class="text-[10px] font-semibold text-ink-2">Top priority</span>
      <time
        :datetime="todayIso"
        class="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4"
      >
        {{ todayLabel }}
      </time>
      <span
        data-today-save-state
        aria-live="polite"
        class="ml-auto font-mono text-[8px] uppercase tracking-[0.1em]"
        :class="saveStateClass"
      >
        {{ saveStateLabel }}
      </span>
    </header>

    <textarea
      ref="editor"
      v-model="text"
      data-today-editor
      aria-label="Top priority for today"
      :aria-busy="loading"
      :readonly="loading"
      spellcheck="true"
      :placeholder="loading ? 'Restoring…' : 'What needs your attention today?'"
      class="min-h-0 w-full flex-1 resize-none bg-surface px-5 py-5 font-sans text-[15px] leading-7 text-ink outline-none placeholder:text-ink-4 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent sm:px-6 sm:py-6"
      @input="markDirty"
    />

    <div
      v-if="error"
      data-today-error
      role="alert"
      class="flex min-h-9 shrink-0 items-center gap-2 border-t border-rem/30 bg-surface px-4 py-1.5 text-[9px] text-rem"
    >
      <IconAlertTriangle :size="13" :stroke-width="1.7" class="shrink-0" />
      <span class="min-w-0 flex-1">{{ error }}</span>
      <button
        type="button"
        class="h-6 shrink-0 px-2 font-semibold hover:bg-rem/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem"
        @click="resolveError"
      >
        {{ errorAction ? 'Retry' : 'Dismiss' }}
      </button>
    </div>
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
import { IconAlertTriangle } from '@tabler/icons-vue'
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
const errorAction = ref('')
let saveTimer = null
let unlistenTools = null
let disposed = false
let lastUpdatedAt = null

const now = new Date()
const todayIso = now.toLocaleDateString('en-CA')
const todayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
}).format(now)
const lineCount = computed(() => text.value ? text.value.split(/\r?\n/).length : 1)
const saveStateLabel = computed(() => {
  if (loading.value) return 'Restoring'
  if (saving.value) return 'Saving'
  if (dirty.value) return 'Unsaved'
  return savedOnce.value ? 'Saved' : 'Ready'
})
const saveStateClass = computed(() => {
  if (error.value) return 'text-rem'
  if (dirty.value) return 'text-accent'
  return 'text-ink-4'
})

onMounted(async () => {
  const tools = installTools()
  await restore()
  await tools
})

watch(() => props.active, async (active) => {
  if (!active || loading.value) return
  await nextTick()
  editor.value?.focus()
}, { immediate: true })

async function restore() {
  loading.value = true
  try {
    const raw = await loadAppData(props.app.id, 'scratch')
    if (disposed || raw == null) return
    const saved = JSON.parse(raw)
    text.value = typeof saved === 'string' ? saved : String(saved?.text || '')
    lastUpdatedAt = typeof saved === 'object' ? saved?.updatedAt || null : null
  } catch (cause) {
    reportError(`Priority could not be restored: ${errorMessage(cause)}`, 'restore')
  } finally {
    loading.value = false
    if (props.active) await nextTick(() => editor.value?.focus())
  }
}

async function installTools() {
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
    await reconcileAppTools({
      appId: props.app.id,
      instanceId: props.instanceId,
      tools: props.app.tools || [],
    })
  } catch (cause) {
    emit('diagnostic', `Priority tool unavailable: ${errorMessage(cause)}`)
  }
}

function markDirty() {
  dirty.value = true
  savedOnce.value = false
  error.value = ''
  errorAction.value = ''
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
    error.value = ''
    errorAction.value = ''
    if (text.value === snapshot) {
      dirty.value = false
      savedOnce.value = true
    }
  } catch (cause) {
    reportError(`Priority could not be saved: ${errorMessage(cause)}`, 'save')
  } finally {
    saving.value = false
    if (dirty.value && text.value !== snapshot) {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void persist(), 350)
    }
  }
}

async function handleToolCall(request) {
  if (!request?.id) return
  if (request.tool !== `app.${props.app.id}.read`) {
    await rejectAppTool(request.id, `Today does not handle '${request.tool}'.`, 'not_found')
    return
  }
  try {
    await respondToAppTool(request.id, {
      value: {
        text: text.value,
        characters: text.value.length,
        lines: lineCount.value,
        updatedAt: lastUpdatedAt,
      },
      displayText: text.value || '(No priority is set.)',
    })
  } catch (cause) {
    reportError(`Priority tool response failed: ${errorMessage(cause)}`)
  }
}

function reportError(message, action = '') {
  error.value = message
  errorAction.value = action
  emit('diagnostic', message)
}

function resolveError() {
  const action = errorAction.value
  error.value = ''
  errorAction.value = ''
  if (action === 'restore') return restore()
  if (action === 'save') return saveNow()
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
