<template>
  <div
    class="diff-view flex-1 min-w-0 flex bg-surface relative overflow-hidden"
    :style="wrapperStyle"
  >
    <div ref="viewHost" class="flex-1 min-w-0 h-full" :class="hostClass"></div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { useDiffStore } from '../../../stores/diff.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { fontFamilyForKey } from '../../../shared/fonts.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import {
  createUnifiedDiffView,
  createSplitDiffView,
  createReadOnlyView,
  getUnifiedChunks,
  getSplitChunks,
} from '../../codemirror/merge.js'

const diff = useDiffStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()

const emit = defineEmits(['accept', 'reject'])

const viewHost = ref(null)
let currentView = null
let currentType = null // 'unified' | 'split' | 'readonly'

const wrapperStyle = computed(() => {
  const baseFontSize = settings.editorFontSize
  const zoom = editorUI.zoomLevel / 100
  return {
    '--editor-size': (baseFontSize * zoom) + 'px',
    '--editor-line-height': ((23 * baseFontSize / 12) * zoom) + 'px',
    '--font-mono': fontFamilyForKey(settings.editorFontFamily),
  }
})

const hostClass = computed(() => {
  if (diff.viewMode === 'diff' && diff.layout === 'split') return 'side-by-side-merge'
  if (diff.viewMode !== 'diff') return 'diff-readonly'
  return ''
})

function destroyCurrent() {
  if (!currentView) return
  currentView.destroy()
  currentView = null
  currentType = null
  if (viewHost.value) viewHost.value.innerHTML = ''
}

function buildView() {
  destroyCurrent()
  if (!viewHost.value || !diff.active) return

  const { viewMode, layout, originalContent, modifiedContent } = diff

  if (viewMode === 'original') {
    currentView = createReadOnlyView({
      parent: viewHost.value,
      content: originalContent,
    })
    currentType = 'readonly'
  } else if (viewMode === 'result') {
    currentView = createReadOnlyView({
      parent: viewHost.value,
      content: modifiedContent,
    })
    currentType = 'readonly'
  } else if (layout === 'unified') {
    const collapse = diff.reviewMeta?.type === 'inline-ai'
    currentView = createUnifiedDiffView({
      parent: viewHost.value,
      originalContent,
      modifiedContent,
      collapse,
      onChunkCountChange: (count) => diff.setChunkCount(count),
      onAllResolved: () => {
        const content = currentView.state.doc.toString()
        emit('accept', content)
      },
    })
    currentType = 'unified'
    if (collapse) {
      nextTick(() => {
        const chunks = getUnifiedChunks(currentView)
        if (chunks.length > 0) {
          currentView.dispatch({
            effects: EditorView.scrollIntoView(chunks[0].fromA, { y: 'center' }),
          })
        }
      })
    }
  } else {
    const collapse = diff.reviewMeta?.type === 'inline-ai'
    currentView = createSplitDiffView({
      parent: viewHost.value,
      originalContent,
      modifiedContent,
      collapse,
      onChunkCountChange: (count) => diff.setChunkCount(count),
      onAllResolved: () => {
        const content = currentView.b.state.doc.toString()
        emit('accept', content)
      },
    })
    currentType = 'split'
  }
}

function scrollToChunk(index) {
  if (!currentView) return

  if (currentType === 'unified') {
    const chunks = getUnifiedChunks(currentView)
    if (!chunks[index]) return
    const chunk = chunks[index]
    currentView.dispatch({
      effects: EditorView.scrollIntoView(chunk.fromA, { y: 'center' }),
    })
  } else if (currentType === 'split') {
    const chunks = getSplitChunks(currentView)
    if (!chunks[index]) return
    const chunk = chunks[index]
    currentView.b.dispatch({
      effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }),
    })
    currentView.a.dispatch({
      effects: EditorView.scrollIntoView(chunk.fromA, { y: 'center' }),
    })
  }
}

function getResolvedContent() {
  if (!currentView) return diff.modifiedContent
  if (currentType === 'unified') return currentView.state.doc.toString()
  if (currentType === 'split') return currentView.b.state.doc.toString()
  return diff.modifiedContent
}

defineExpose({ scrollToChunk, getResolvedContent })

watch(() => [diff.viewMode, diff.layout, diff.originalContent, diff.modifiedContent], () => {
  if (diff.active) nextTick(buildView)
})

watch(() => diff.active, (active) => {
  if (active) nextTick(buildView)
  else destroyCurrent()
})

onMounted(() => {
  if (diff.active) buildView()
})

onUnmounted(() => {
  destroyCurrent()
})
</script>

<style scoped>
.diff-view {
  position: relative;
}

.diff-view :deep(.cm-editor) {
  height: 100%;
}

.diff-view :deep(.cm-scroller) {
  font-family: var(--font-mono);
  line-height: var(--editor-line-height);
  background-color: var(--editor-paper, var(--color-surface));
}

.diff-view :deep(.cm-content) {
  padding: 24px clamp(8px, 3vw, 24px) clamp(72px, 20vh, 100px);
}

/* Side-by-side: both panes fill height */
.side-by-side-merge :deep(.cm-mergeView) {
  height: 100%;
}
.side-by-side-merge :deep(.cm-mergeViewEditor) {
  height: 100%;
  overflow: hidden;
}
.side-by-side-merge :deep(.cm-mergeViewEditor .cm-editor) {
  height: 100%;
}
</style>
