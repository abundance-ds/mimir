<template>
  <div data-scratchpad-toolbar class="pane-bar flex items-center gap-1 px-2 text-xs text-ink-2 shrink-0" role="toolbar" aria-label="Scratchpad history">
    <button :disabled="busy || !previous" title="Previous saved text" aria-label="Previous saved text" @mousedown.prevent @click="$emit('browse', previous)"><IconChevronLeft :size="16" /></button>
    <button :disabled="busy || !selected" title="Next saved text" aria-label="Next saved text" @mousedown.prevent @click="$emit('browse', next)"><IconChevronRight :size="16" /></button>
    <span class="min-w-0 truncate" :title="selected ? new Date(selected.time).toLocaleString() : 'One shared document. Last 100 saved states.'">{{ selected ? new Date(selected.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Latest' }}</span>
    <button v-if="selected" :disabled="busy" @mousedown.prevent @click="$emit('browse', null)">Latest</button>
    <button v-if="selected" :disabled="busy" @mousedown.prevent @click="$emit('replace', selected.content)">Restore</button>
    <span class="flex-1" />
    <button :aria-pressed="changes" :disabled="!before" @mousedown.prevent @click="$emit('update:changes', !changes)">Changes</button>
    <button @mousedown.prevent @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
    <button v-if="!selected" :disabled="busy || !content" @mousedown.prevent @click="$emit('replace', '')">Clear</button>
  </div>
  <div v-if="conflict" class="px-3 py-2 border-b border-rule-light text-xs text-ink-2" role="status">
    Scratchpad changed elsewhere. Your text is still here.
    <button :disabled="busy" @mousedown.prevent @click="$emit('replace', content)">Keep my text</button>
    <button :disabled="busy" @mousedown.prevent @click="$emit('use-latest')">Use latest</button>
  </div>
  <div v-if="error" class="px-3 py-1 text-xs text-rem" role="status">{{ error }}</div>
</template>

<script setup>
import { computed, ref, onUnmounted } from 'vue'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-vue'
const props = defineProps({
  history: { type: Array, default: () => [] }, selected: { type: Object, default: null },
  content: { type: String, default: '' }, changes: Boolean, conflict: Boolean, busy: Boolean,
  error: { type: String, default: '' },
  getContent: { type: Function, default: null },
})
const emit = defineEmits(['browse', 'replace', 'use-latest', 'update:changes', 'error'])
const index = computed(() => props.selected ? props.history.findIndex(s => s.time === props.selected.time) : props.history.length - 1)
const previous = computed(() => props.history[index.value - 1] || null)
const next = computed(() => index.value < props.history.length - 2 ? props.history[index.value + 1] : null)
const before = computed(() => previous.value)
const copied = ref(false)
let timer
async function copy() {
  try {
    await navigator.clipboard.writeText(props.selected?.content ?? props.getContent?.() ?? props.content)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => { copied.value = false }, 1500)
  } catch (cause) { emit('error', cause) }
}
onUnmounted(() => clearTimeout(timer))
</script>

<style scoped>
button { padding: 4px 6px; flex-shrink: 0; }
button:hover:not(:disabled), button[aria-pressed="true"] { background: var(--color-accent-soft); color: var(--color-ink); }
button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
button:disabled { opacity: .4; }
</style>
