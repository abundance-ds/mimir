<template>
  <section
    data-today-app
    class="flex h-full min-h-0 w-full flex-col bg-surface text-ink"
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

    <div
      ref="editorHost"
      data-today-editor
      aria-label="Top priority for today"
      :aria-busy="loading"
      class="min-h-0 w-full flex-1 overflow-hidden bg-surface"
    ></div>

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
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, selectAll as selectAllCommand } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { Strikethrough } from '@lezer/markdown'
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
const editorHost = ref(null)
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
let editorView = null
let applyingExternalText = false
const readOnlyCompartment = new Compartment()
const todayHighlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: 'var(--color-ink)',
    fontWeight: '600',
  },
  { tag: tags.strong, color: 'var(--color-ink)', fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)' },
  { tag: tags.monospace, color: 'var(--color-ink-2)', fontFamily: 'var(--font-mono)' },
  { tag: tags.quote, color: 'var(--color-ink-3)' },
  { tag: tags.contentSeparator, color: 'var(--color-ink-4)' },
])
const todayEditorTheme = EditorView.theme({
  '&': {
    width: '100%',
    height: '100%',
    color: 'var(--color-ink)',
    backgroundColor: 'var(--color-surface)',
    fontSize: '15px',
  },
  '&.cm-focused': {
    outline: '1px solid var(--color-accent)',
    outlineOffset: '-1px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-sans)',
    lineHeight: '28px',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: '20px 24px',
    caretColor: 'var(--color-accent)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-accent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': {
    color: 'var(--color-ink-4)',
    fontStyle: 'normal',
  },
})

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
  createMarkdownEditor()
  const tools = installTools()
  await restore()
  await tools
})

watch(() => props.active, async (active) => {
  if (!active || loading.value) return
  await nextTick()
  editorView?.focus()
}, { immediate: true })

async function restore() {
  loading.value = true
  try {
    const raw = await loadAppData(props.app.id, 'scratch')
    if (disposed || raw == null) return
    const saved = JSON.parse(raw)
    text.value = typeof saved === 'string' ? saved : String(saved?.text || '')
    lastUpdatedAt = typeof saved === 'object' ? saved?.updatedAt || null : null
    syncEditorText()
  } catch (cause) {
    reportError(`Priority could not be restored: ${errorMessage(cause)}`, 'restore')
  } finally {
    loading.value = false
    setEditorReadOnly(false)
    if (props.active) await nextTick(() => editorView?.focus())
  }
}

function createMarkdownEditor() {
  if (!editorHost.value || editorView) return
  const state = EditorState.create({
    doc: text.value,
    extensions: [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': 'Top priority for today',
        spellcheck: 'true',
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
      readOnlyCompartment.of(readOnlyExtensions(true)),
      history(),
      drawSelection(),
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      syntaxHighlighting(todayHighlightStyle),
      todayEditorTheme,
      placeholder('What needs your attention today?'),
      keymap.of([
        { key: 'Meta-a', run: view => selectAllCommand(view) },
        { key: 'Ctrl-a', run: view => selectAllCommand(view) },
        {
          key: 'Meta-s',
          run() {
            void saveNow()
            return true
          },
        },
        {
          key: 'Ctrl-s',
          run() {
            void saveNow()
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternalText) return
        text.value = update.state.doc.toString()
        markDirty()
      }),
    ],
  })
  editorView = new EditorView({ state, parent: editorHost.value })
}

function readOnlyExtensions(readOnly) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ]
}

function setEditorReadOnly(readOnly) {
  editorView?.dispatch({
    effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)),
  })
}

function syncEditorText() {
  if (!editorView || editorView.state.doc.toString() === text.value) return
  applyingExternalText = true
  editorView.dispatch({
    changes: {
      from: 0,
      to: editorView.state.doc.length,
      insert: text.value,
    },
  })
  applyingExternalText = false
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

defineExpose({
  focus: () => editorView?.focus(),
  getContent: () => editorView?.state.doc.toString() || '',
  getEditorView: () => editorView,
})

onUnmounted(() => {
  disposed = true
  clearTimeout(saveTimer)
  if (dirty.value && !saving.value) void persist()
  editorView?.destroy()
  editorView = null
  unlistenTools?.()
  void unregisterAppTools(props.app.id, props.instanceId).catch(() => {})
})
</script>
