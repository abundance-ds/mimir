<template>
  <div class="diff-bar h-[30px] shrink-0 border-b border-rule-light flex items-center gap-3 px-[14px] whitespace-nowrap overflow-hidden">
    <!-- Batch mode -->
    <template v-if="diff.isBatch && !diff.isBatchFileFocused">
      <span class="font-sans text-[11px] font-semibold text-ink-2">
        {{ diff.files.length }} {{ diff.files.length === 1 ? 'file' : 'files' }}
      </span>

      <div class="flex items-center gap-[3px] mx-1">
        <button
          v-for="f in diff.files"
          :key="f.path"
          class="batch-dot"
          :class="'batch-dot-' + f.status"
          :title="f.path.split('/').pop()"
          @mousedown.prevent
          @click="emit('navigate-file', f.path)"
        ></button>
      </div>

      <div class="flex items-center gap-0.5">
        <button class="chunk-nav-btn" :disabled="diff.pendingFiles.length === 0" @mousedown.prevent @click="onPrevPending">&#8592;</button>
        <span class="font-mono text-[9px] text-ink-3 min-w-[28px] text-center">
          {{ diff.resolvedCount }}<span class="text-ink-3 mx-px">/</span>{{ diff.files.length }}
        </span>
        <button class="chunk-nav-btn" :disabled="diff.pendingFiles.length === 0" @mousedown.prevent @click="onNextPending">&#8594;</button>
      </div>
    </template>

    <!-- Single-file mode -->
    <template v-else>
      <!-- View mode toggle -->
      <div class="seg-ctrl">
        <button
          v-for="m in viewModes"
          :key="m.value"
          class="seg-btn"
          :class="{ active: diff.viewMode === m.value }"
          @mousedown.prevent
          @click="diff.setViewMode(m.value)"
        >{{ m.label }}</button>
      </div>

      <!-- Layout toggle (only in diff mode) -->
      <div v-if="diff.viewMode === 'diff'" class="seg-ctrl">
        <button
          class="seg-btn"
          :class="{ active: diff.layout === 'unified' }"
          @mousedown.prevent
          @click="diff.setLayout('unified')"
        >Unified</button>
        <button
          class="seg-btn"
          :class="{ active: diff.layout === 'split' }"
          @mousedown.prevent
          @click="diff.setLayout('split')"
        >Split</button>
      </div>

      <!-- Chunk navigation (only in diff mode with chunks) -->
      <div v-if="diff.viewMode === 'diff' && diff.chunkCount > 0" class="flex items-center gap-0.5">
        <button class="chunk-nav-btn" @mousedown.prevent @click="onPrevChunk">&#8592;</button>
        <span class="chunk-counter">{{ diff.currentChunk + 1 }}<span class="chunk-sep">/</span>{{ diff.chunkCount }}</span>
        <button class="chunk-nav-btn" @mousedown.prevent @click="onNextChunk">&#8594;</button>
      </div>
    </template>

    <div class="flex-1"></div>

    <!-- Actions (both modes) -->
    <template v-if="isHistory">
      <span class="history-label">{{ historyLabel }}</span>
      <button class="diff-action-btn cancel" @mousedown.prevent @click="emit('reject-all')">Cancel</button>
      <button class="diff-action-btn accept" @mousedown.prevent @click="emit('accept-all')">Restore</button>
    </template>
    <template v-else-if="isInlineAI">
      <span class="history-label">AI suggestion</span>
      <button class="diff-action-btn cancel" @mousedown.prevent @click="emit('reject-all')">Reject</button>
      <button class="diff-action-btn accept" @mousedown.prevent @click="emit('accept-all')">Accept</button>
    </template>
    <template v-else>
      <button class="diff-action-btn reject" @mousedown.prevent @click="emit('reject-all')">Reject All</button>
      <button class="diff-action-btn accept" @mousedown.prevent @click="emit('accept-all')">Accept All</button>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useDiffStore } from '../../../stores/diff.js'
import { relativeTime } from '../../../services/audit.js'

const diff = useDiffStore()
const emit = defineEmits(['accept-all', 'reject-all', 'navigate-chunk', 'navigate-file'])

const isHistory = computed(() => diff.reviewMeta?.type === 'history')
const isInlineAI = computed(() => diff.reviewMeta?.type === 'inline-ai')
const historyLabel = computed(() => {
  const meta = diff.reviewMeta
  if (!meta) return ''
  const time = meta.timestamp ? relativeTime(meta.timestamp) : ''
  return time ? `${meta.hash} · ${time}` : meta.hash || ''
})

const viewModes = [
  { value: 'original', label: 'Original' },
  { value: 'diff', label: 'Diff' },
  { value: 'result', label: 'Result' },
]

let currentPendingIdx = 0

function onPrevPending() {
  const pending = diff.pendingFiles
  if (pending.length === 0) return
  currentPendingIdx = (currentPendingIdx - 1 + pending.length) % pending.length
  emit('navigate-file', pending[currentPendingIdx].path)
}

function onNextPending() {
  const pending = diff.pendingFiles
  if (pending.length === 0) return
  currentPendingIdx = (currentPendingIdx + 1) % pending.length
  emit('navigate-file', pending[currentPendingIdx].path)
}

function onPrevChunk() {
  diff.prevChunk()
  emit('navigate-chunk', diff.currentChunk)
}

function onNextChunk() {
  diff.nextChunk()
  emit('navigate-chunk', diff.currentChunk)
}
</script>

<style scoped>
.diff-bar {
  background: var(--color-chrome-mid);
}

/* ── Batch dots ── */
.batch-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  border: none;
  padding: 0;
}
.batch-dot:hover {
  transform: scale(1.5);
}
.batch-dot-pending {
  background: var(--color-ink-3);
}
.batch-dot-accepted {
  background: var(--color-add);
}
.batch-dot-rejected {
  background: var(--color-rule);
}

/* ── Segmented control ── */
.seg-ctrl {
  display: flex;
  height: 20px;
  background: var(--color-chrome);
  border: 1px solid var(--color-rule);
  border-radius: 100px;
  padding: 1px;
  gap: 0;
}

.seg-btn {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-3);
  background: none;
  border: none;
  border-radius: 100px;
  padding: 0 9px;
  height: 16px;
  white-space: nowrap;
  line-height: 16px;
}
.seg-btn:hover:not(.active) {
  color: var(--color-ink-2);
  background: var(--color-chrome-mid);
}
.seg-btn.active {
  background: var(--color-surface);
  color: var(--color-ink);
  font-weight: 600;
}

/* ── Chunk navigation ── */
.chunk-nav-btn {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--color-ink-3);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chunk-nav-btn:hover:not(:disabled) {
  color: var(--color-ink);
  background: var(--color-chrome-high);
}
.chunk-nav-btn:disabled {
  color: var(--color-ink-3);
  cursor: default;
}

.chunk-counter {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-3);
  min-width: 28px;
  text-align: center;
}
.chunk-sep {
  color: var(--color-ink-3);
  margin: 0 1px;
}

/* ── History label ── */
.history-label {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-ink-3);
}

/* ── Action buttons ── */
.diff-action-btn {
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 500;
  height: 22px;
  padding: 0 10px;
  border: none;
  border-radius: 3px;
  background: none;
}

.diff-action-btn.reject {
  color: var(--color-ink-3);
}
.diff-action-btn.reject:hover {
  color: var(--color-rem);
  background: color-mix(in srgb, var(--color-rem) 15%, transparent);
}

.diff-action-btn.cancel {
  color: var(--color-ink-2);
  border: 1px solid var(--color-rule);
}
.diff-action-btn.cancel:hover {
  color: var(--color-ink);
  background: var(--color-chrome-high);
}

.diff-action-btn.accept {
  color: var(--color-accent-ink);
  background: var(--color-accent);
  font-weight: 600;
}
.diff-action-btn.accept:hover {
  opacity: 0.9;
}
</style>
