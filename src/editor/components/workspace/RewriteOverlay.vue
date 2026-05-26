<template>
  <div
    ref="overlayRef"
    class="fixed z-40 w-[400px] bg-surface border border-rule rounded-lg"
    :style="positionStyle"
    @keydown.stop
  >
    <!-- Instruction phase -->
    <div v-if="phase === 'input'" class="p-3 flex flex-col gap-2">
      <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">{{ mode === 'question' ? 'Ask about selection' : 'Rewrite selection' }}</div>
      <div v-if="truncatedText" class="text-ink-3 text-xs font-mono line-clamp-2 leading-relaxed">{{ truncatedText }}</div>
      <form @submit.prevent="submitRequest" class="flex gap-2">
        <input
          ref="inputRef"
          v-model="instruction"
          type="text"
          class="flex-1 bg-chrome-mid border border-rule-light rounded px-3 py-2 text-xs font-sans text-ink outline-none focus:border-accent"
          :placeholder="mode === 'question' ? 'Ask a question...' : 'Improve this passage'"
          autocorrect="off"
          autocapitalize="off"
          @keydown.escape.prevent="$emit('reject')"
        />
        <button
          type="submit"
          class="bg-accent text-accent-ink px-3 py-1 rounded text-xs font-sans whitespace-nowrap"
        >{{ mode === 'question' ? 'Ask' : 'Rewrite' }}</button>
      </form>
    </div>

    <!-- Loading phase -->
    <div v-else-if="phase === 'loading'" class="p-3 flex flex-col gap-2">
      <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">{{ mode === 'question' ? 'Thinking' : 'Rewriting' }}</div>
      <div class="text-accent text-xs font-sans flex items-center gap-1">
        {{ mode === 'question' ? 'Thinking' : 'Rewriting' }}<span class="rewrite-dots">...</span>
      </div>
      <button class="font-sans text-[10px] text-ink-3 hover:text-ink hover:bg-chrome-mid rounded mt-1" @click="$emit('close')">Cancel</button>
    </div>

    <!-- Error phase -->
    <div v-else-if="phase === 'error'" class="p-3 flex flex-col gap-2">
      <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">{{ mode === 'question' ? 'Question failed' : 'Rewrite failed' }}</div>
      <div class="text-xs font-sans text-accent">{{ errorMessage }}</div>
      <div class="flex justify-end gap-2 mt-1">
        <button
          class="text-ink-3 hover:text-ink hover:bg-chrome-mid rounded px-3 py-1 text-xs font-sans"
          @click="phase = 'input'"
        >Try again</button>
        <button
          class="text-ink-3 hover:text-ink hover:bg-chrome-mid rounded px-3 py-1 text-xs font-sans"
          @click="$emit('reject')"
        >Dismiss</button>
      </div>
    </div>

    <!-- Question answer phase -->
    <div v-else-if="phase === 'result' && mode === 'question'" class="p-3 flex flex-col gap-2">
      <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">Answer</div>
      <div class="answer-text">{{ answer }}</div>
      <template v-if="suggestedEdit">
        <div class="border-t border-rule-light my-1"></div>
        <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">Suggested edit</div>
        <div class="flex flex-col gap-1 max-h-[120px] overflow-auto">
          <div class="text-ink-3 line-through text-xs font-mono leading-relaxed whitespace-pre-wrap">{{ suggestedEdit.oldText }}</div>
          <div class="text-accent text-xs font-mono leading-relaxed whitespace-pre-wrap">{{ suggestedEdit.newText }}</div>
        </div>
        <div class="flex justify-end gap-2 mt-1">
          <button
            class="text-ink-3 hover:text-ink hover:bg-chrome-mid rounded px-3 py-1 text-xs font-sans"
            @click="$emit('reject')"
          >Dismiss</button>
          <button
            class="bg-accent text-accent-ink px-3 py-1 rounded text-xs font-sans"
            @click="$emit('accept', suggestedEdit.newText, selection.from, selection.to)"
          >Apply edit</button>
        </div>
      </template>
      <div v-else class="flex justify-end mt-1">
        <button
          class="text-ink-3 hover:text-ink hover:bg-chrome-mid rounded px-3 py-1 text-xs font-sans"
          @click="$emit('close')"
        >Done</button>
      </div>
    </div>

    <!-- Rewrite result phase -->
    <div v-else-if="phase === 'result'" class="p-3 flex flex-col gap-2">
      <div class="text-ink-3 text-[10px] uppercase tracking-widest font-sans">Rewrite result</div>
      <div class="flex flex-col gap-1.5 max-h-[240px] overflow-auto">
        <div class="text-ink-3 line-through text-xs font-mono leading-relaxed whitespace-pre-wrap">{{ selection.text }}</div>
        <div class="text-accent text-xs font-mono leading-relaxed whitespace-pre-wrap">{{ replacement }}</div>
      </div>
      <div v-if="rationale" class="text-ink-3 text-[10px] italic font-sans leading-snug">{{ rationale }}</div>
      <div class="flex justify-end gap-2 mt-1">
        <button
          class="text-ink-3 hover:text-ink hover:bg-chrome-mid rounded px-3 py-1 text-xs font-sans"
          @click="$emit('reject')"
        >Discard</button>
        <button
          class="bg-accent text-accent-ink px-3 py-1 rounded text-xs font-sans"
          @click="$emit('accept', replacement, selection.from, selection.to)"
        >Accept</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { requestSelectionRewrite, requestInlineQuestion } from '../../../services/ai/rewrite.js'
import { buildPrefixSuffix } from '../../../services/ai/context.js'

const props = defineProps({
  selection: { type: Object, required: true },
  documentId: { type: String, default: null },
  mode: { type: String, default: 'rewrite' },
})

const emit = defineEmits(['accept', 'reject', 'close'])

const overlayRef = ref(null)
const inputRef = ref(null)
const phase = ref('input')
const instruction = ref('')
const replacement = ref('')
const rationale = ref('')
const answer = ref('')
const suggestedEdit = ref(null)
const errorMessage = ref('')

const truncatedText = computed(() => {
  const text = props.selection.text || ''
  if (text.length <= 120) return text
  return text.slice(0, 117) + '...'
})

const positionStyle = computed(() => {
  const coords = props.selection.coords
  if (!coords) return { top: '100px', left: '100px' }

  const overlayWidth = 400
  const overlayHeightEstimate = 180
  const margin = 12

  let top = coords.bottom + margin
  let left = coords.left

  const vw = window.innerWidth
  const vh = window.innerHeight

  if (left + overlayWidth > vw - margin) {
    left = vw - overlayWidth - margin
  }
  if (left < margin) {
    left = margin
  }
  if (top + overlayHeightEstimate > vh - margin) {
    top = coords.top - overlayHeightEstimate - margin
    if (top < margin) top = margin
  }

  return {
    top: top + 'px',
    left: left + 'px',
  }
})

let rewriteTimeoutId = null

async function submitRequest() {
  phase.value = 'loading'

  rewriteTimeoutId = setTimeout(() => {
    phase.value = 'error'
    errorMessage.value = 'Request timed out. Try again.'
  }, 30000)

  try {
    if (props.mode === 'question') {
      const result = await requestInlineQuestion({
        text: props.selection.text,
        question: instruction.value || 'What can you tell me about this text?',
        contextBefore: '',
        contextAfter: '',
        documentId: props.documentId,
      })
      clearTimeout(rewriteTimeoutId)
      answer.value = result.answer
      suggestedEdit.value = result.suggestedEdit
      phase.value = 'result'
    } else {
      const result = await requestSelectionRewrite({
        text: props.selection.text,
        instruction: instruction.value || 'Improve this passage',
        contextBefore: '',
        contextAfter: '',
        documentId: props.documentId,
      })
      clearTimeout(rewriteTimeoutId)
      replacement.value = result.replacement
      rationale.value = result.rationale || ''
      phase.value = 'result'
    }
  } catch (err) {
    clearTimeout(rewriteTimeoutId)
    errorMessage.value = err?.message || 'Request failed'
    phase.value = 'error'
  }
}

function onClickOutside(e) {
  if (overlayRef.value && !overlayRef.value.contains(e.target)) {
    emit('close')
  }
}

function onKeydownGlobal(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('reject')
  }
}

onMounted(async () => {
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('keydown', onKeydownGlobal, true)
  await nextTick()
  inputRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('keydown', onKeydownGlobal, true)
  if (rewriteTimeoutId) clearTimeout(rewriteTimeoutId)
})
</script>

<style scoped>
.answer-text {
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.55;
  color: var(--color-ink);
}

.rewrite-dots {
  display: inline-block;
  animation: rewrite-dot-cycle 1.2s steps(4, end) infinite;
  width: 1.5em;
  overflow: hidden;
  vertical-align: bottom;
}

@keyframes rewrite-dot-cycle {
  0%   { width: 0; }
  25%  { width: 0.5em; }
  50%  { width: 1em; }
  75%  { width: 1.5em; }
  100% { width: 0; }
}
</style>
