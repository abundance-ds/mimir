<template>
  <div
    class="diff-view flex-1 min-w-0 flex bg-surface relative overflow-hidden"
    :style="wrapperStyle"
    @keydown.capture="onKeydown"
  >
    <div ref="viewHost" class="flex-1 min-w-0 h-full" :class="hostClass"></div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useDiffStore } from '../../../stores/diff.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { editorTypographyVars } from '../../../shared/fonts.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { createReviewView } from '../../codemirror/reviewView.js'

const diff = useDiffStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()
const viewHost = ref(null)
let projection = null

const wrapperStyle = computed(() => editorTypographyVars({
  fontSize: settings.editorFontSize,
  zoom: editorUI.zoomLevel / 100,
  fontKey: settings.editorFontFamily,
  dark: settings.isDarkTheme,
}))
const hostClass = computed(() => diff.viewMode !== 'diff' ? 'diff-readonly'
  : diff.layout === 'split' ? 'side-by-side-merge' : '')

function destroyCurrent(save = true) {
  projection?.destroy(save)
  projection = null
}

function buildView() {
  destroyCurrent(false)
  const session = diff.currentReview
  if (!viewHost.value || !diff.active || !session) return
  projection = createReviewView({
    parent: viewHost.value,
    session,
    layout: diff.layout,
    mode: diff.viewMode,
    locked: Boolean(diff.decision || diff.finishing || diff.reviewMeta?.type === 'history'),
    content: diff.decision?.content,
    collapse: diff.reviewMeta?.type === 'inline-ai',
    onChange: (base, result, action) => diff.recordReviewChange(session, base, result, action),
  })
  diff.setChunkCount(session.pending)
}

function onKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.isComposing) {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey) diff.redoReview()
    else diff.undoReview()
  }
}

function scrollToChunk(index) { projection?.scrollToChunk(index) }
function getResolvedContent() { return diff.decision?.content ?? diff.currentReview?.result ?? diff.modifiedContent }
defineExpose({ scrollToChunk, getResolvedContent })

const viewInputs = () => [diff.active, diff.currentReview, diff.currentReview?.revision, diff.viewMode, diff.layout, diff.decision, diff.finishing]
// Capture before Vue changes the host's layout class and its scroll geometry.
watch(viewInputs, () => projection?.savePosition(), { flush: 'pre' })
watch(viewInputs, buildView, { flush: 'post' })
onMounted(buildView)
onBeforeUnmount(() => destroyCurrent())
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
