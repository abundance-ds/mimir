<template>
  <article class="chat-msg group" :class="message.role === 'user' ? 'flex flex-col items-end gap-1.5' : 'flex flex-col gap-2.5'">
    <div v-if="message.role === 'user'" class="flex flex-col max-w-[70%]">
      <div class="bg-chrome-mid text-ink rounded-lg px-3.5 py-2 font-sans text-[13px] leading-normal border border-rule-light">
        <div v-if="userFileParts.length || attachedFileNames.length" class="flex flex-wrap gap-1.5 mb-1.5">
          <template v-for="(part, i) in userFileParts" :key="'file-' + i">
            <img v-if="isLiveImage(part)"
                 :src="part.url"
                 :alt="part.filename || 'Attached image'"
                 class="max-w-[300px] max-h-[200px] rounded-1.5 object-contain" />
            <span v-else-if="isAttachmentPlaceholder(part)" class="font-sans text-[11px] text-ink-3 italic">
              [Attached: {{ part.filename || 'file' }}]
            </span>
            <span v-else class="inline-flex items-center gap-1 font-sans text-[11px] text-ink-3 bg-chrome px-2 py-0.75 rounded">
              <IconFileText :size="12" />
              {{ part.filename || 'Document' }}
            </span>
          </template>
          <span v-for="(name, i) in attachedFileNames" :key="'tfile-' + i" class="inline-flex items-center gap-1 font-sans text-[11px] text-ink-3 bg-chrome px-2 py-0.75 rounded">
            <IconFileText :size="12" />
            {{ name }}
          </span>
        </div>
        <span v-if="messageText">{{ messageText }}</span>
      </div>
      <div class="flex items-center gap-0.5 self-start -ml-0.5 -mt-0.5 opacity-0 group-hover:opacity-100">
        <button v-if="messageText" class="flex items-center justify-center size-5.5 rounded text-ink-3 bg-transparent border-none hover:bg-chrome-mid hover:text-ink-2" @click.stop="copyContent" :title="copied ? 'Copied!' : 'Copy'">
          <IconCopy v-if="!copied" :size="12" />
          <IconCheck v-else :size="12" class="text-add" />
        </button>
        <button v-if="isSettled" class="flex items-center justify-center size-5.5 rounded text-ink-3 bg-transparent border-none hover:bg-chrome-mid hover:text-ink-2" @click.stop="forkConversation" :title="forked ? 'Forked!' : 'New chat from here'">
          <IconArrowFork v-if="!forked" :size="12" />
          <IconCheck v-else :size="12" class="text-add" />
        </button>
      </div>
    </div>

    <template v-else>
      <template v-for="(part, i) in message.parts || []" :key="`${message.id}-${i}`">
        <div v-if="part.type === 'text'" class="asst-text md-content font-sans text-[16px] leading-[1.55] text-ink m-0" v-html="revealedHtml(part, i)" />

        <div v-else-if="part.type === 'reasoning'" class="my-1">
          <button class="reasoning-toggle flex items-center gap-1 font-sans text-xs text-ink-3 bg-transparent border-none py-0.5 hover:text-ink-2" @click="toggleReasoning(i)">
            <IconChevronRight :size="10"
              :style="{ transform: expandedReasoning[i] ? 'rotate(90deg)' : '', transition: 'transform 0.15s' }" />
            <span class="inline-flex items-center" v-if="isReasoningActive(i)">
              Thinking<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
            </span>
            <span v-else class="inline-flex items-center">Thought process</span>
          </button>
          <div v-if="expandedReasoning[i]" class="reasoning-content md-content mt-1 pl-2 border-l-2 border-rule font-sans text-sm leading-normal text-ink-3" v-html="renderMarkdown(part.text)" />
        </div>

        <ToolCallBlock v-else-if="isToolPart(part)" :part="part" :key="`tool-${part.toolCallId || i}-${part.state}`" />

      </template>

      <span v-if="isWaitingForContent" class="streaming-dots inline-flex items-center gap-0.75 py-1">
        <span /><span /><span />
      </span>

      <div class="flex items-center gap-0.5 self-start -ml-0.5 -mt-1 opacity-0 group-hover:opacity-100">
        <button v-if="copyableText" class="flex items-center justify-center size-5.5 rounded text-ink-3 bg-transparent border-none hover:bg-chrome-mid hover:text-ink-2" @click.stop="copyContent" :title="copied ? 'Copied!' : 'Copy'">
          <IconCopy v-if="!copied" :size="12" />
          <IconCheck v-else :size="12" class="text-add" />
        </button>
        <button v-if="isSettled" class="flex items-center justify-center size-5.5 rounded text-ink-3 bg-transparent border-none hover:bg-chrome-mid hover:text-ink-2" @click.stop="forkConversation" :title="forked ? 'Forked!' : 'New chat from here'">
          <IconArrowFork v-if="!forked" :size="12" />
          <IconCheck v-else :size="12" class="text-add" />
        </button>
      </div>
    </template>
  </article>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { marked } from 'marked'
import { IconFileText, IconChevronRight, IconCopy, IconCheck, IconArrowFork } from '@tabler/icons-vue'
import { isToolPart } from '../../stores/panel/helpers.js'
import { stripHfu } from '../../shared/hfu.js'
import { useChatStore } from '../../stores/panel/chat.js'
import { isImageType, isAttachmentPlaceholder } from '../../services/attachments.js'
import { useStreamReveal } from '../composables/useStreamReveal'
import ToolCallBlock from './ToolCallBlock.vue'

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(text) {
  if (!text) return ''
  return marked.parse(text)
}

const props = defineProps({
  message: { type: Object, required: true },
  isLastAssistant: { type: Boolean, default: false },
})

const emit = defineEmits(['fork'])

const chat = useChatStore()

const messageText = computed(() => {
  const raw = props.message.content || (props.message.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n') || ''
  return props.message.role === 'user' ? stripHfu(raw) : raw
})

const userFileParts = computed(() => {
  if (props.message.role !== 'user' || !props.message.parts) return []
  return props.message.parts.filter(p => p.type === 'file')
})

const attachedFileNames = computed(() => {
  if (props.message.role !== 'user') return []
  const raw = props.message.content || (props.message.parts || [])
    .filter(p => p.type === 'text').map(p => p.text).join('\n') || ''
  const names = []
  const re = /<attached-file name="([^"]+)">/g
  let m
  while ((m = re.exec(raw))) names.push(m[1])
  return names
})

function isLiveImage(part) {
  return isImageType(part.mediaType) && !isAttachmentPlaceholder(part) && part.url
}

function getLastTextPart() {
  if (!props.isLastAssistant) return null
  const parts = props.message.parts
  if (!parts) return null
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') return parts[i]
  }
  return null
}

const { revealedLength } = useStreamReveal(
  () => getLastTextPart()?.text || '',
  () => {
    if (!props.isLastAssistant) return false
    return ['submitted', 'streaming'].includes(chat.activeStatus)
  },
)

function isStreamingTextPart(idx) {
  if (!props.isLastAssistant) return false
  if (!['submitted', 'streaming'].includes(chat.activeStatus)) return false
  const parts = props.message.parts
  if (!parts) return false
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') return i === idx
  }
  return false
}

function revealedHtml(part, idx) {
  if (!isStreamingTextPart(idx)) return renderMarkdown(part.text)
  const len = revealedLength.value
  if (len >= part.text.length) return renderMarkdown(part.text)
  return renderMarkdown(part.text.slice(0, len))
}

// --- Reasoning/Thinking display ---

const expandedReasoning = reactive({})

function toggleReasoning(idx) {
  expandedReasoning[idx] = !expandedReasoning[idx]
}

function isReasoningActive(partIdx) {
  if (!props.isLastAssistant) return false
  const parts = props.message.parts || []
  const partsAfter = parts.slice(partIdx + 1)
  if (partsAfter.length > 0) return false
  return ['submitted', 'streaming'].includes(chat.activeStatus)
}

// --- Streaming wait dots + Copy button ---

const isWaitingForContent = computed(() => {
  if (!props.isLastAssistant) return false
  if (!['submitted', 'streaming'].includes(chat.activeStatus)) return false
  const parts = props.message.parts
  if (!parts || parts.length === 0) return true
  if (parts.some(p => p.type === 'text' && p.text)) return false
  if (parts.some(p => isToolPart(p))) return false
  return true
})

const copied = ref(false)
const forked = ref(false)

const isSettled = computed(() => {
  if (props.message.role === 'user') return true
  if (!props.isLastAssistant) return true
  return !['submitted', 'streaming'].includes(chat.activeStatus)
})

const copyableText = computed(() => {
  if (props.message.role !== 'assistant') return ''
  return (props.message.parts || [])
    .filter(p => p.type === 'text')
    .map(p => p.text || '')
    .join('\n\n')
    .trim()
})

function copyContent() {
  const text = props.message.role === 'user' ? messageText.value : copyableText.value
  navigator.clipboard.writeText(text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function forkConversation() {
  forked.value = true
  emit('fork')
  setTimeout(() => { forked.value = false }, 2000)
}
</script>

<style scoped>
/* :deep() markdown content — cannot be expressed in Tailwind */
.asst-text.md-content :deep(p) { margin: 0 0 8px; }
.asst-text.md-content :deep(p:last-child) { margin-bottom: 0; }
.asst-text.md-content :deep(ul), .asst-text.md-content :deep(ol) {
  margin: 4px 0 8px; padding-left: 20px;
}
.asst-text.md-content :deep(li) { margin: 2px 0; }
.asst-text.md-content :deep(code) {
  font-family: var(--font-mono); font-size: 11.5px;
  background: var(--color-chrome); padding: 1px 4px; border-radius: 3px;
  color: var(--color-ink);
}
.asst-text.md-content :deep(pre) {
  background: var(--color-chrome); border: 1px solid var(--color-rule-light);
  border-radius: 4px; padding: 10px 12px; margin: 8px 0;
  overflow-x: auto; font-family: var(--font-mono); font-size: 11px;
  line-height: 1.5; color: var(--color-ink);
}
.asst-text.md-content :deep(pre code) { background: none; padding: 0; border-radius: 0; }
.asst-text.md-content :deep(strong) { font-weight: 600; color: var(--color-ink); }
.asst-text.md-content :deep(em) { font-style: italic; }
.asst-text.md-content :deep(h1), .asst-text.md-content :deep(h2), .asst-text.md-content :deep(h3) {
  font-family: var(--font-sans); color: var(--color-ink); margin: 12px 0 6px;
}
.asst-text.md-content :deep(h1) { font-size: 16px; font-weight: 600; }
.asst-text.md-content :deep(h2) { font-size: 14px; font-weight: 600; }
.asst-text.md-content :deep(h3) { font-size: 13px; font-weight: 500; }
.asst-text.md-content :deep(blockquote) {
  border-left: 2px solid var(--color-rule); padding-left: 12px;
  color: var(--color-ink-3); font-style: italic; margin: 8px 0;
}
.asst-text.md-content :deep(a) { color: var(--color-accent); text-decoration: none; }
.asst-text.md-content :deep(a:hover) { text-decoration: underline; }
.asst-text.md-content :deep(hr) { border: none; border-top: 1px solid var(--color-rule-light); margin: 12px 0; }
.asst-text.md-content :deep(table) { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
.asst-text.md-content :deep(th), .asst-text.md-content :deep(td) {
  border: 1px solid var(--color-rule-light); padding: 4px 8px; text-align: left;
}
.asst-text.md-content :deep(th) { background: var(--color-surface); font-weight: 600; }

.reasoning-content :deep(p) { margin: 0 0 6px; }
.reasoning-content :deep(p:last-child) { margin-bottom: 0; }
.reasoning-content :deep(code) {
  font-family: var(--font-mono); font-size: 11px;
  background: var(--color-chrome); padding: 1px 3px; border-radius: 2px;
}

/* Animations — @keyframes + nth-child */
.thinking-dots span { animation: thinking-dot-fade 1.4s ease-in-out infinite; opacity: 0.2; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes thinking-dot-fade {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}

.streaming-dots > span {
  width: 4px; height: 4px; border-radius: 50%;
  background: var(--color-accent);
  animation: stream-dot-pulse 1s ease-in-out infinite;
}
.streaming-dots > span:nth-child(2) { animation-delay: 0.15s; }
.streaming-dots > span:nth-child(3) { animation-delay: 0.3s; }
@keyframes stream-dot-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
</style>
