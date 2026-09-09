<template>
  <div data-scratchpad-history class="flex-1 overflow-auto bg-surface text-ink p-5 select-text" tabindex="0" :aria-label="changes ? 'Saved changes' : 'Saved text'">
    <div class="text-xs text-ink-3 mb-3">{{ changes ? 'Changes from the previous save. Added text is underlined; removed text is struck out.' : 'Saved text · Read only' }}</div>
    <pre class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed"><template v-for="(part, index) in parts" :key="index"><ins v-if="part.kind === 'add'" class="bg-add/10 text-add">{{ part.text }}</ins><del v-else-if="part.kind === 'remove'" class="bg-rem/10 text-rem">{{ part.text }}</del><template v-else>{{ part.text }}</template></template></pre>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { presentableDiff } from '@codemirror/merge'
const props = defineProps({ content: { type: String, default: '' }, before: { type: String, default: '' }, changes: Boolean })
const parts = computed(() => {
  if (!props.changes) return [{ text: props.content }]
  const result = []
  let end = 0
  for (const change of presentableDiff(props.before, props.content)) {
    result.push({ text: props.content.slice(end, change.fromB) })
    result.push({ kind: 'remove', text: props.before.slice(change.fromA, change.toA) })
    result.push({ kind: 'add', text: props.content.slice(change.fromB, change.toB) })
    end = change.toB
  }
  result.push({ text: props.content.slice(end) })
  return result
})
</script>
