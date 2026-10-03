<template>
  <div data-scratchpad-history class="flex-1 overflow-auto bg-surface text-ink p-5 select-text" tabindex="0" :aria-label="changes ? 'Saved changes' : 'Saved text'">
    <div class="text-xs text-ink-3 mb-3">{{ changes ? 'Changes from the previous save. Added text is underlined; removed text is struck out.' : 'Saved text · Read only' }}</div>
    <pre class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed"><template v-for="(part, index) in parts" :key="index"><ins v-if="part.kind === 'add'" class="bg-add/10 text-add">{{ part.text }}</ins><del v-else-if="part.kind === 'remove'" class="bg-rem/10 text-rem">{{ part.text }}</del><template v-else>{{ part.text }}</template></template></pre>
    <ReviewComments :session="session" readonly />
  </div>
</template>
<script setup>
import { computed, reactive } from 'vue'
import { presentableDiff } from '@codemirror/merge'
import { createReviewSession } from '../../reviewSession.js'
import { reviewComments } from '../../reviewComments.js'
import ReviewComments from './ReviewComments.vue'
const props = defineProps({ content: { type: String, default: '' }, before: { type: String, default: '' }, changes: Boolean })
const session = computed(() => reactive(createReviewSession(props.changes ? props.before : props.content, props.content)))
const parts = computed(() => {
  const before = session.value.references.original
  const content = session.value.references.proposed
  if (!props.changes) return [{ text: content }]
  const result = []
  let end = 0
  for (const change of presentableDiff(before, content)) {
    result.push({ text: content.slice(end, change.fromB) })
    result.push({ kind: 'remove', text: before.slice(change.fromA, change.toA) })
    result.push({ kind: 'add', text: content.slice(change.fromB, change.toB) })
    end = change.toB
  }
  result.push({ text: content.slice(end) })
  return result
})
defineExpose({ getReviewState: () => ({ kind: 'history', reviewId: session.value.id, readOnly: true,
  mode: props.changes ? 'diff' : 'result', side: 'result', content: session.value.result, historyContent: props.content,
  selection: null, visibleRange: null, comments: reviewComments(session.value, session.value.result, { includeRemoved: true }) }) })
</script>
