<template>
  <div
    class="diff-view flex-1 min-w-0 flex bg-surface relative overflow-hidden"
    :style="wrapperStyle"
    @keydown.capture="onKeydown"
  >
    <div ref="viewHost" class="flex-1 min-w-0 min-h-0" :class="hostClass"></div>
    <ReviewComments v-if="diff.currentReview" ref="discussions" :session="diff.currentReview" :readonly="locked" :selection="selection"
      :action="(action, input, selected) => diff.comment(diff.currentReview, action, input, selected)"
      :decide="(id, action) => diff.decideComment(diff.currentReview, id, action)" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useDiffStore } from '../../../stores/diff.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { editorTypographyVars } from '../../../shared/fonts.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { createReviewView } from '../../codemirror/reviewView.js'
import { reviewContent } from '../../reviewComments.js'
import ReviewComments from './ReviewComments.vue'

const diff = useDiffStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()
const viewHost = ref(null)
const discussions = ref(null)
const selection = ref(null)
const locked = computed(() => Boolean(diff.decision || diff.finishing || diff.reviewMeta?.type === 'history'))
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
    locked: locked.value,
    content: diff.decision?.content,
    collapse: diff.reviewMeta?.type === 'inline-ai',
    onChange: (base, result, action) => diff.recordReviewChange(session, base, result, action),
    onComment: id => discussions.value?.open(id),
    onAddComment: selected => discussions.value?.start(selected),
    onSelection: selected => { selection.value = selected },
  })
  diff.setChunkCount(session.pending)
}

function onKeydown(event) {
  if (event.target?.closest?.('input, textarea, [contenteditable="true"]:not(.cm-content)')) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.isComposing) {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey) diff.redoReview()
    else diff.undoReview()
  }
}

function scrollToChunk(index) {
  const annotation = diff.currentReview?.comments.filter(record => diff.currentReview.commentDecisions[record.id] === 'pending')[index - (diff.currentReview.pending - Object.values(diff.currentReview.commentDecisions).filter(value => value === 'pending').length)]
  if (annotation) discussions.value?.open(annotation.id)
  else projection?.scrollToChunk(index)
}
function getResolvedContent() { return diff.decision?.content ?? (diff.currentReview ? reviewContent(diff.currentReview) : diff.modifiedContent) }
function getReviewState() { return projection?.getState() || null }
function editCommand(command) { if (command === 'undo') diff.undoReview(); else if (command === 'redo') diff.redoReview() }
defineExpose({ scrollToChunk, getResolvedContent, getReviewState, editCommand })

const viewInputs = () => [diff.active, diff.currentReview, diff.currentReview?.revision, diff.viewMode, diff.layout, diff.decision, diff.finishing]
// Capture before Vue changes the host's layout class and its scroll geometry.
watch(viewInputs, () => projection?.savePosition(), { flush: 'pre' })
watch(viewInputs, buildView, { flush: 'post' })
watch(() => [diff.currentReview?.result, diff.currentReview?.base, diff.currentReview?.commentRevision, diff.currentReview?.commentUI?.showResolved], () => projection?.refreshComments(), { flush: 'post' })
onMounted(buildView)
onBeforeUnmount(() => destroyCurrent())
</script>

<style scoped>
.diff-view {
  position: relative;
  flex-direction: column;
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
