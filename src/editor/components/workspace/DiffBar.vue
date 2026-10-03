<template>
  <div class="diff-bar">
    <div v-if="!batchOverview" class="diff-views">
      <div class="view-switch" role="group" aria-label="Review view">
        <button v-for="view in views" :key="view.value" type="button" :aria-pressed="diff.viewMode === view.value"
          @mousedown.prevent @click="diff.setViewMode(view.value)">{{ view.label }}</button>
      </div>
      <div v-if="diff.viewMode === 'diff'" class="view-switch" role="group" aria-label="Diff layout">
        <button v-for="layout in layouts" :key="layout.value" type="button" :aria-pressed="diff.layout === layout.value"
          @mousedown.prevent @click="diff.setLayout(layout.value)">{{ layout.label }}</button>
      </div>
    </div>
    <span v-else class="review-status">{{ diff.files.length }} {{ diff.files.length === 1 ? 'file' : 'files' }}</span>
    <div class="diff-actions">
      <div class="review-navigation" role="group" :aria-label="batchOverview ? 'Pending files' : 'Pending changes'">
        <button type="button" class="review-icon" :aria-label="previousLabel" :title="previousLabel" :disabled="!pendingCount"
          @mousedown.prevent @click="batchOverview ? navigateFile(-1) : navigate(-1)"><IconArrowUp :size="13" aria-hidden="true" /></button>
        <span class="review-count" role="status" :aria-label="pendingLabel" :title="pendingLabel">{{ positionLabel }}</span>
        <button type="button" class="review-icon" :aria-label="nextLabel" :title="nextLabel" :disabled="!pendingCount"
          @mousedown.prevent @click="batchOverview ? navigateFile(1) : navigate(1)"><IconArrowDown :size="13" aria-hidden="true" /></button>
      </div>
      <template v-if="diff.decision || diff.finishing">
        <span v-if="diff.finishing || diff.decision?.pending" class="review-status" role="status">Applying…</span>
        <button v-else type="button" class="review-text" @click="emit('finish')">Retry</button>
      </template>
      <template v-else-if="isHistory">
        <span class="review-status history-label" :title="historyLabel">{{ historyLabel }}</span>
        <button type="button" class="review-text" @mousedown.prevent @click="emit('reject-all')">Cancel</button>
        <button type="button" class="review-text review-restore" @mousedown.prevent @click="emit('accept-all')">Restore</button>
      </template>
      <template v-else>
        <div class="review-history" role="group" aria-label="Review history">
          <button type="button" class="review-icon" :disabled="!diff.canUndo" aria-label="Undo review decision" title="Undo review decision (⌘Z)" @mousedown.prevent @click="diff.undoReview()"><IconArrowBackUp :size="14" aria-hidden="true" /></button>
          <button type="button" class="review-icon" :disabled="!diff.canRedo" aria-label="Redo review decision" title="Redo review decision (⇧⌘Z)" @mousedown.prevent @click="diff.redoReview()"><IconArrowForwardUp :size="14" aria-hidden="true" /></button>
        </div>
        <ReviewActions :scope="batchOverview ? 'in all files' : 'in this file'" :pending="diff.pendingChanges > 0"
          @accept="emit('accept-all')" @reject="emit('reject-all')" />
        <button v-if="diff.reviewError && diff.canFinish" type="button" class="review-text" @click="emit('finish')">Retry</button>
      </template>
    </div>
    <div v-if="diff.reviewError" role="alert" class="review-error">{{ diff.reviewError }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import { IconArrowUp, IconArrowDown, IconArrowBackUp, IconArrowForwardUp } from '@tabler/icons-vue'
import { useDiffStore } from '../../../stores/diff.js'
import { relativeTime } from '../../../shared/time.js'
import ReviewActions from './ReviewActions.vue'

const diff = useDiffStore()
const emit = defineEmits(['accept-all', 'reject-all', 'finish', 'navigate-chunk', 'navigate-file'])
const batchOverview = computed(() => diff.isBatch && !diff.isBatchFileFocused)
const isHistory = computed(() => diff.reviewMeta?.type === 'history')
const historyLabel = computed(() => {
  const meta = diff.reviewMeta
  return meta ? `${meta.hash || ''} ${meta.timestamp ? relativeTime(meta.timestamp) : ''}`.trim() : ''
})
const views = [{ value: 'original', label: 'Original' }, { value: 'diff', label: 'Diff' }, { value: 'result', label: 'Result' }]
const layouts = [{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]
const fileIndex = ref(-1)
const pendingCount = computed(() => batchOverview.value ? diff.pendingFiles.length : diff.pendingChanges)
const pendingLabel = computed(() => `${pendingCount.value} ${batchOverview.value ? (pendingCount.value === 1 ? 'file' : 'files') : (pendingCount.value === 1 ? 'change' : 'changes')} left`)
const positionLabel = computed(() => pendingCount.value
  ? `${Math.min(pendingCount.value, (batchOverview.value ? Math.max(0, fileIndex.value) : diff.currentChunk) + 1)}/${pendingCount.value}` : '0')
const previousLabel = computed(() => batchOverview.value ? 'Previous pending file' : 'Previous change')
const nextLabel = computed(() => batchOverview.value ? 'Next pending file' : 'Next change')
async function navigate(direction) {
  diff.setViewMode('diff')
  if (direction < 0) diff.prevChunk(); else diff.nextChunk()
  await nextTick()
  emit('navigate-chunk', diff.currentChunk)
}
function navigateFile(direction) {
  const files = diff.pendingFiles
  if (!files.length) return
  fileIndex.value = fileIndex.value < 0 ? (direction < 0 ? files.length - 1 : 0)
    : (fileIndex.value + direction + files.length) % files.length
  emit('navigate-file', files[fileIndex.value].path)
}
</script>

<style scoped>
.diff-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; min-height: 32px; padding: 2px 8px; flex-shrink: 0; border-bottom: 1px solid var(--color-rule-light); background: var(--color-chrome-high); font: 11px var(--font-sans); }
.diff-views, .diff-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 27px; }
.diff-actions { margin-left: auto; gap: 4px; }
.view-switch { display: flex; padding: 2px; border-radius: 5px; background: var(--color-chrome); }
.view-switch button { height: 20px; padding: 0 7px; border-radius: 3px; color: var(--color-ink-3); font-size: 10px; white-space: nowrap; }
.view-switch button:hover { color: var(--color-ink); }
.view-switch button[aria-pressed="true"] { background: var(--color-surface); color: var(--color-ink); box-shadow: 0 0 0 1px var(--color-rule-light); }
.review-navigation, .review-history { display: flex; align-items: center; }
.review-history { padding-inline: 4px; border-inline: 1px solid var(--color-rule-light); }
.review-status { color: var(--color-ink-3); padding: 0 4px; white-space: nowrap; }
.history-label { max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.review-count { min-width: 25px; color: var(--color-ink-3); font-size: 10px; font-variant-numeric: tabular-nums; text-align: center; }
.review-icon, .review-text { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 5px; border-radius: 3px; color: var(--color-ink-2); white-space: nowrap; }
.review-icon { width: 24px; padding: 0; }
.review-icon:hover:not(:disabled), .review-text:hover:not(:disabled) { background: var(--color-chrome); color: var(--color-ink); }
.review-restore { color: var(--color-accent); }
button:disabled { opacity: .35; cursor: default; }
button:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 1px; }
.review-error { flex-basis: 100%; padding: 4px; color: var(--color-rem); overflow-wrap: anywhere; }
</style>
