<template>
  <div class="batch-file-section" :class="file.status">
    <div
      class="batch-file-header sticky top-0 z-10 h-[30px] shrink-0 flex items-center gap-2 px-[14px] bg-chrome-mid border-b border-rule-light"
    >
      <span class="font-mono text-[11px] text-ink-2 font-medium flex-1 min-w-0 truncate">{{ fileName }}</span>
      <span class="font-mono text-[10px] flex gap-1.5 shrink-0">
        <span class="text-add">+{{ addedLines }}</span>
        <span class="text-rem">-{{ removedLines }}</span>
      </span>
      <div class="flex gap-1 shrink-0">
        <button
          v-if="file.status === 'pending' && !file.applied"
          class="font-sans text-[10px] font-medium h-[22px] px-2 rounded-[3px] text-ink-3 hover:text-ink hover:bg-chrome-high border-0 bg-transparent"
          @mousedown.prevent
          @click="emit('reject', file.path)"
        >Reject</button>
        <button
          v-if="file.status === 'pending'"
          class="font-sans text-[10px] font-medium h-[22px] px-2 rounded-[3px] text-add hover:bg-add/10 border-0 bg-transparent"
          @mousedown.prevent
          @click="emit('accept', file.path)"
        >{{ file.applied ? 'Retry status' : 'Accept' }}</button>
        <template v-if="file.status === 'accepted'">
          <span class="font-sans text-[10px] font-medium text-add">{{ file.applied ? 'Applied' : 'Accepted' }}</span>
          <button v-if="!file.applied" class="font-sans text-[10px] font-medium h-[22px] px-2 rounded-[3px] text-ink-3 hover:text-ink hover:bg-chrome-high border-0 bg-transparent" @mousedown.prevent @click="emit('reset', file.path)">Undo</button>
        </template>
        <template v-if="file.status === 'rejected'">
          <span class="font-sans text-[10px] font-medium text-ink-3">Rejected</span>
          <button v-if="!file.lifecycleResolved" class="font-sans text-[10px] font-medium h-[22px] px-2 rounded-[3px] text-ink-3 hover:text-ink hover:bg-chrome-high border-0 bg-transparent" @mousedown.prevent @click="emit('reset', file.path)">Undo</button>
        </template>
      </div>
    </div>
    <div v-if="file.error" class="batch-file-error" role="alert">{{ file.error }}</div>
    <div
      v-if="file.status === 'pending' && !file.applied"
      ref="diffHost"
      class="batch-file-diff"
    ></div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { createUnifiedDiffView, resolvedDiffContent } from '../../codemirror/merge.js'
import { computeLineDelta } from '../../../shared/lineDelta.js'

const props = defineProps({
  file: { type: Object, required: true },
  displayName: { type: String, default: '' },
})

const emit = defineEmits(['accept', 'reject', 'reset', 'change', 'resolve'])

const diffHost = ref(null)
let editorView = null

const fileName = computed(() => props.displayName || props.file.path?.split('/').pop() || props.file.path)

const delta = computed(() => computeLineDelta(props.file.original || '', props.file.modified || ''))
const addedLines = computed(() => delta.value.added)
const removedLines = computed(() => delta.value.removed)

function buildEditor() {
  destroyEditor()
  if (!diffHost.value || props.file.status !== 'pending') return

  editorView = createUnifiedDiffView({
    parent: diffHost.value,
    originalContent: props.file.original,
    modifiedContent: props.file.modified,
    collapse: true,
    onChunkCountChange: () => {},
    onChange: content => emit('change', props.file.path, content),
    onAllResolved: () => {
      if (!editorView || props.file.status !== 'pending') return
      emit('resolve', props.file.path, resolvedDiffContent(editorView.state.doc, props.file.modified, props.file.original))
    },
  })
}

function destroyEditor() {
  if (editorView) {
    editorView.destroy()
    editorView = null
  }
  if (diffHost.value) diffHost.value.innerHTML = ''
}

watch(() => props.file.status, (status) => {
  if (status !== 'pending') destroyEditor()
  else buildEditor()
}, { flush: 'post' })

onMounted(() => {
  if (props.file.status === 'pending') buildEditor()
})

onUnmounted(() => {
  destroyEditor()
})
</script>

<style scoped>
.batch-file-section.rejected {
  opacity: 0.5;
}

.batch-file-error {
  padding: 6px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-rem) 28%, var(--color-rule-light));
  background: color-mix(in srgb, var(--color-rem) 7%, var(--color-surface));
  color: var(--color-rem);
  font-family: var(--font-sans);
  font-size: 10.5px;
}

.batch-file-diff {
  overflow: auto;
}
.batch-file-diff::-webkit-scrollbar { width: 4px; }
.batch-file-diff::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }

.batch-file-diff :deep(.cm-editor) {
  font-size: var(--editor-size, 12px);
}
.batch-file-diff :deep(.cm-content) {
  padding: 0 14px;
}
.batch-file-diff :deep(.cm-scroller) {
  font-family: var(--font-mono);
  line-height: var(--editor-line-height, 20px);
}
</style>
