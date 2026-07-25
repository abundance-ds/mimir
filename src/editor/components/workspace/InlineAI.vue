<template>
  <div class="shrink-0 bg-chrome-mid border-b border-rule-light">
    <!-- Row 1: Input (always visible) -->
    <div class="flex items-center gap-1.5 min-h-[34px] px-[14px]">
      <form @submit.prevent="onSubmit" class="flex items-center gap-1.5 flex-1 min-w-0">
        <span class="shrink-0 font-mono text-[10px] text-ink-3 bg-chrome border border-rule rounded px-1 py-px leading-[14px]">⌘K</span>
        <span class="shrink-0 font-mono text-[9px] text-ink-3" data-inline-ai-scope>{{ selectionScope }}</span>
        <textarea
          ref="inputRef"
          v-model="input"
          class="flex-1 min-w-0 h-[24px] max-h-[72px] bg-surface border border-rule-light rounded px-2 py-1 font-sans text-[11px] text-ink leading-snug outline-none resize-none overflow-hidden focus:border-accent disabled:opacity-40"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          rows="1"
          aria-label="Inline AI instruction"
          aria-keyshortcuts="Enter Shift+Enter Meta+Enter Control+Enter"
          :disabled="isLoading"
          :placeholder="placeholder"
          @keydown="onInputKeydown"
          @input="autoResize"
        />
        <button
          type="submit"
          aria-label="Send inline AI instruction"
          class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10.5px] font-semibold text-accent-ink bg-accent hover:opacity-90 disabled:opacity-30"
          :disabled="!canSend"
        >Send</button>
      </form>
      <ModelPicker
        v-if="modelList.length"
        class="iai-model-picker"
        :modelId="currentModelId"
        :models="modelList"
        @update:modelId="onModelChange"
      />
      <button
        aria-label="Close inline AI"
        title="Close inline AI"
        class="w-[24px] h-[24px] flex items-center justify-center rounded text-ink-3 text-sm hover:text-ink-2 hover:bg-chrome-high shrink-0"
        @mousedown.prevent
        @click="onClose"
      >&times;</button>
    </div>

    <!-- Row 2: Status / Response / Error -->
    <div
      v-if="isLoading || responseText || pendingEdit || chatError || modelStateMessage"
      aria-live="polite"
      class="flex items-start gap-1.5 min-h-[34px] px-[14px] py-1.5 border-t border-rule-light"
    >
      <!-- Loading -->
      <template v-if="isLoading">
        <span class="inline-flex items-center min-w-[80px] font-sans text-[11px] text-accent leading-snug">
          {{ toolStatus || 'Thinking' }}<span class="iai-dots">...</span>
        </span>
        <div class="flex-1" />
        <button class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10px] font-medium text-ink-3 hover:text-ink hover:bg-chrome-high" @mousedown.prevent @click="onCancel">Cancel</button>
      </template>

      <!-- Error -->
      <template v-else-if="chatError">
        <span class="font-sans text-[11px] text-accent flex-1 leading-snug">{{ chatError }}</span>
        <button class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10px] font-medium text-ink-3 hover:text-ink hover:bg-chrome-high" @mousedown.prevent @click="onRetry">Retry</button>
      </template>

      <!-- Response -->
      <template v-else-if="responseText || pendingEdit">
        <p class="flex-1 min-w-0 font-sans text-[11px] leading-snug text-ink-2">{{ responseText || 'Review the proposed edit.' }}</p>
        <template v-if="pendingEdit">
          <button class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10.5px] font-medium text-ink-3 iai-reject-btn" @mousedown.prevent @click="onReject">Reject</button>
          <button
            aria-label="Accept AI edit"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10.5px] font-semibold text-accent-ink bg-accent hover:opacity-90"
            @mousedown.prevent
            @click="onAccept"
          >Accept</button>
        </template>
      </template>

      <template v-else>
        <span class="font-sans text-[11px] text-ink-2 flex-1 leading-snug">{{ modelStateMessage }}</span>
        <button
          v-if="modelsReady && !resolvedModel"
          type="button"
          class="shrink-0 h-[24px] px-2.5 rounded font-sans text-[10px] font-medium text-accent hover:bg-chrome-high"
          @click="$emit('configure-models')"
        >Configure AI</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { Chat } from '@ai-sdk/vue'
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import { useSettingsStore } from '../../../stores/settings.js'
import { getModelRegistry, getAiKeyStatus } from '../../../services/ai/client.js'
import { modelMenuItems, resolveConcreteModel } from '../../../services/ai/modelControls.js'
import { createInlineAITransport, buildInlineSystemPrompt } from '../../../services/ai/inlineTransport.js'
import ModelPicker from '../../../shared/ui/ModelPicker.vue'
import { inlineAIKeyAction } from './inlineAIKeys.js'

const TOOL_LABELS = {
  read: 'Reading',
  search: 'Searching',
  suggest_edit: 'Preparing edit',
  list: 'Listing',
  edit: 'Editing',
}

const settings = useSettingsStore()

const props = defineProps({
  selection: { type: Object, required: true },
  documentId: { type: String, default: null },
  getDocument: { type: Function, default: null },
  projectPath: { type: String, default: null },
  escapeBlocked: { type: Boolean, default: false },
})

const emit = defineEmits(['apply', 'activate-diff', 'deactivate-diff', 'close', 'configure-models'])

const inputRef = ref(null)
const modelList = ref([])
const pendingEdit = ref(null)
const toolStatus = ref('')
let lastInstruction = ''
const registry = ref(null)
const keyStatuses = ref([])
const modelsReady = ref(false)
const modelLoadError = ref('')
const localError = ref('')

const input = ref('')

let chatInstance = null
const _chatVersion = ref(0)

const resolvedModel = computed(() => resolveConcreteModel(
  registry.value,
  keyStatuses.value,
  settings.aiInlineModel,
  'rewrite',
))

const currentModelId = computed(() => (
  resolvedModel.value?.id || settings.aiInlineModel || 'auto'
))

const modelStateMessage = computed(() => {
  if (!modelsReady.value) return modelLoadError.value || 'Loading configured AI models…'
  if (!resolvedModel.value) return 'Configure an AI provider key to use inline rewrite.'
  return ''
})

const canSend = computed(() => (
  Boolean(input.value.trim())
  && !isLoading.value
  && Boolean(resolvedModel.value)
))

const selectionScope = computed(() => {
  const text = props.selection.text || ''
  if (!text) return 'Cursor'
  const lines = text.split('\n').length
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return lines > 1 ? `${lines} lines` : `${words} ${words === 1 ? 'word' : 'words'}`
})

const placeholder = computed(() => {
  void _chatVersion.value
  if (!props.selection.text) return 'What should I add here?'
  return chatInstance ? 'Follow up…' : 'What should I do with this?'
})

function getConfig() {
  return {
    modelId: currentModelId.value,
    registry: registry.value,
    system: buildInlineSystemPrompt({
      text: props.selection.text,
      contextBefore: props.selection.contextBefore || '',
      contextAfter: props.selection.contextAfter || '',
    }),
    maxSteps: 4,
    maxOutputTokens: 2000,
    temperature: 0.3,
    controlId: '',
    onEdit: (edit) => {
      pendingEdit.value = edit
      emit('activate-diff', {
        from: props.selection.from,
        to: props.selection.to,
        replacement: edit.replacement,
      })
    },
    onUsage: () => {},
    toolContext: {
      sessionId: `inline-${Date.now()}`,
      projectPath: props.projectPath || null,
      getDocument: props.getDocument || null,
      _readHistory: new Set(),
    },
  }
}

function createChat() {
  chatInstance = new Chat({
    id: `inline-ai-${Date.now()}`,
    messages: [],
    transport: createInlineAITransport(() => getConfig()),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onError(error) {
      localError.value = error?.message || String(error)
    },
    onFinish() {
      toolStatus.value = ''
    },
  })
  _chatVersion.value++
}

const isLoading = computed(() => {
  void _chatVersion.value
  if (!chatInstance) return false
  const status = chatInstance.state.statusRef.value
  return status === 'submitted' || status === 'streaming'
})

const chatError = computed(() => {
  if (localError.value) return localError.value
  void _chatVersion.value
  if (!chatInstance) return null
  const err = chatInstance.state.errorRef.value
  return err ? (err.message || String(err)) : null
})

const responseText = computed(() => {
  void _chatVersion.value
  if (!chatInstance) return ''
  const msgs = chatInstance.state.messagesRef.value
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role !== 'assistant') continue
    const parts = msg.parts || []
    const textParts = parts.filter(p => p.type === 'text').map(p => p.text)
    if (textParts.length) return textParts.join('')
    if (typeof msg.content === 'string' && msg.content) return msg.content
  }
  return ''
})

watch(() => { void _chatVersion.value; return chatInstance?.state.messagesRef.value }, (msgs) => {
  if (!msgs) return
  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue
    for (const part of (msg.parts || [])) {
      const activeTool = activeToolName(part)
      if (activeTool) toolStatus.value = TOOL_LABELS[activeTool] || 'Working'
    }
  }
}, { deep: true })

function activeToolName(part) {
  if (part?.type === 'tool-invocation' && part.toolInvocation?.state === 'call') {
    return part.toolInvocation.toolName
  }
  const activeStates = new Set(['call', 'input-streaming', 'input-available'])
  if (!activeStates.has(part?.state)) return ''
  if (part.type === 'dynamic-tool') return part.toolName || ''
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return part.toolName || part.type.slice(5)
  }
  return ''
}

function onModelChange(id) {
  settings.set('aiInlineModel', id)
  localError.value = ''
}

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 72) + 'px'
  el.style.overflowY = el.scrollHeight > 72 ? 'auto' : 'hidden'
}

function resetInput() {
  input.value = ''
  nextTick(() => {
    if (inputRef.value) {
      inputRef.value.style.height = '24px'
      inputRef.value.style.overflowY = 'hidden'
    }
  })
}

function onInputKeydown(e) {
  const action = inlineAIKeyAction(e, { hasPendingEdit: Boolean(pendingEdit.value) })
  if (action === 'escape') {
    e.preventDefault()
    onClose()
  } else if (action === 'accept') {
    e.preventDefault()
    onAccept()
  } else if (action === 'submit') {
    e.preventDefault()
    onSubmit()
  }
}

function onSubmit() {
  const instruction = input.value.trim()
  if (!instruction || isLoading.value || !resolvedModel.value) return

  lastInstruction = instruction
  resetInput()
  pendingEdit.value = null
  toolStatus.value = ''
  localError.value = ''

  emit('deactivate-diff')

  if (!chatInstance) createChat()
  try {
    const sending = chatInstance.sendMessage({ text: instruction })
    if (sending?.catch) {
      void sending.catch((error) => {
        localError.value = error?.message || String(error)
      })
    }
  } catch (error) {
    localError.value = error?.message || String(error)
  }
}

function onCancel() {
  if (chatInstance) chatInstance.stop()
  toolStatus.value = ''
}

function onRetry() {
  if (!lastInstruction) return
  input.value = lastInstruction
  nextTick(() => onSubmit())
}

function onAccept() {
  if (!pendingEdit.value) return
  emit('apply', pendingEdit.value.replacement, props.selection.from, props.selection.to)
}

function onReject() {
  emit('deactivate-diff')
  pendingEdit.value = null
  nextTick(() => inputRef.value?.focus())
}

function onClose() {
  if (chatInstance) try { chatInstance.stop() } catch {}
  emit('close')
}

function onGlobalKeydown(e) {
  if (props.escapeBlocked) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (isLoading.value) onCancel()
    else onClose()
  }
}

async function loadModels() {
  try {
    const [reg, statuses] = await Promise.all([getModelRegistry(), getAiKeyStatus()])
    registry.value = reg
    keyStatuses.value = statuses
    modelList.value = modelMenuItems(reg, statuses)
  } catch (error) {
    modelLoadError.value = `AI models could not be loaded: ${error?.message || error}`
  } finally {
    modelsReady.value = true
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onGlobalKeydown, true)
  await nextTick()
  inputRef.value?.focus()
  loadModels()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown, true)
  if (chatInstance) try { chatInstance.stop() } catch {}
})
</script>

<style scoped>
.iai-dots {
  display: inline-block;
  animation: iai-dots 1.2s steps(4, end) infinite;
  width: 1.5em;
  overflow: hidden;
  vertical-align: bottom;
}

@keyframes iai-dots {
  0% { width: 0; }
  25% { width: 0.5em; }
  50% { width: 1em; }
  75% { width: 1.5em; }
  100% { width: 0; }
}

.iai-reject-btn:hover {
  color: var(--color-rem);
  background: color-mix(in srgb, var(--color-rem) 15%, transparent);
}

.iai-model-picker :deep(.picker-trigger) {
  height: 20px;
  padding: 0 6px;
  font-size: 9px;
  gap: 3px;
  border-radius: 3px;
  border: none;
  background: none;
  color: var(--color-ink-3);
}
.iai-model-picker :deep(.picker-trigger:hover) {
  background: var(--color-chrome-high);
  color: var(--color-ink-3);
}
.iai-model-picker :deep(.picker-label) {
  font-size: 9px;
}
.iai-model-picker :deep(.picker-provider-icon) {
  width: 10px;
  height: 10px;
}
</style>
