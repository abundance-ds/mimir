<template>
  <section class="batch-file-section" :aria-label="fileName">
    <div class="batch-file-header">
      <span class="batch-file-name" :title="file.path">{{ fileName }}</span>
      <span class="batch-file-status" role="status">{{ file.applied ? 'Applied' : file.lifecycleResolved ? 'Done' : file.review.pending ? `${file.review.pending} ${file.review.pending === 1 ? 'change' : 'changes'}` : 'Reviewed' }}</span>
      <ReviewActions v-if="!file.applied && !file.lifecycleResolved" compact :pending="file.review.pending > 0" :disabled="diff.finishing"
        @accept="diff.decideRemainingChanges('accept', file.path)" @reject="diff.decideRemainingChanges('reject', file.path)" />
    </div>
    <div v-if="file.error" class="batch-file-error" role="alert">{{ file.error }}</div>
    <div ref="diffHost" class="batch-file-diff"></div>
    <ReviewComments ref="discussions" :session="file.review" :readonly="locked" :selection="selection"
      :action="(action, input, selected) => diff.comment(file.review, action, input, selected)"
      :decide="(id, action) => diff.decideComment(file.review, id, action)" />
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useDiffStore } from '../../../stores/diff.js'
import { createReviewView } from '../../codemirror/reviewView.js'
import ReviewActions from './ReviewActions.vue'
import ReviewComments from './ReviewComments.vue'

const props = defineProps({ file: { type: Object, required: true }, displayName: { type: String, default: '' } })
const diff = useDiffStore()
const diffHost = ref(null)
const discussions = ref(null)
const selection = ref(null)
const locked = computed(() => Boolean(props.file.applied || props.file.lifecycleResolved || diff.finishing))
let projection = null
const fileName = computed(() => props.displayName || props.file.path?.split('/').pop() || props.file.path)
function buildEditor() {
  projection?.destroy()
  projection = null
  if (!diffHost.value) return
  const session = props.file.review
  projection = createReviewView({
    parent: diffHost.value, session, collapse: true,
    locked: locked.value,
    onChange: (base, result, action) => diff.recordReviewChange(session, base, result, action),
    onComment: id => discussions.value?.open(id),
    onAddComment: selected => discussions.value?.start(selected),
    onSelection: selected => { selection.value = selected },
  })
}
watch(() => [props.file.review, props.file.review.revision, props.file.applied, props.file.lifecycleResolved, diff.finishing], buildEditor, { flush: 'post' })
watch(() => [props.file.review.result, props.file.review.base, props.file.review.commentRevision, props.file.review.commentUI?.showResolved], () => projection?.refreshComments(), { flush: 'post' })
onMounted(buildEditor)
onBeforeUnmount(() => projection?.destroy())
</script>

<style scoped>
.batch-file-header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 12px; background: var(--color-chrome-high); border-bottom: 1px solid var(--color-rule-light); font: 11px var(--font-sans); }
.batch-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink-2); }
.batch-file-status { color: var(--color-ink-3); white-space: nowrap; }
.batch-file-error { padding: 6px 14px; color: var(--color-rem); font: 11px var(--font-sans); }
.batch-file-diff { overflow: auto; }
.batch-file-diff :deep(.cm-editor) { font-size: var(--editor-size, 12px); }
.batch-file-diff :deep(.cm-content) { padding: 0 14px; }
.batch-file-diff :deep(.cm-scroller) { font-family: var(--font-mono); line-height: var(--editor-line-height, 20px); }
</style>
