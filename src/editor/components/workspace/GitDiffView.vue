<template>
  <div data-git-diff-view class="flex flex-col min-h-0 min-w-0 flex-1 bg-surface" :style="wrapperStyle">
    <div v-if="git.loading" class="grid flex-1 place-items-center text-center">
      <div>
        <IconLoader2 :size="19" :stroke-width="1.6" class="mx-auto motion-safe:animate-spin text-accent" />
        <p class="mt-2 text-[10px] text-ink-3">Loading Git diff</p>
      </div>
    </div>
    <div v-else-if="git.error" role="alert" class="grid flex-1 place-items-center px-8 text-center">
      <div class="max-w-sm">
        <IconAlertTriangle :size="21" :stroke-width="1.5" class="mx-auto text-rem" />
        <p class="mt-3 text-[12px] font-semibold">This change could not be reviewed</p>
        <p class="mt-1 break-words text-[10px] leading-relaxed text-ink-3">{{ git.error }}</p>
        <button
          type="button"
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="retry"
        >Refresh review</button>
      </div>
    </div>
    <div v-else-if="git.review?.binary" class="grid flex-1 place-items-center px-8 text-center">
      <div class="max-w-sm">
        <IconFileUnknown :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
        <p class="mt-3 text-[12px] font-semibold">Inline diff unavailable</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ git.review.unavailableReason }}</p>
      </div>
    </div>
    <div v-else ref="viewHost" class="git-diff-host min-h-0 min-w-0 flex-1 overflow-hidden" />
    <ReviewComments v-if="session && !git.loading && !git.error && !git.review?.binary" ref="discussions" :session="session" readonly />
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IconAlertTriangle, IconFileUnknown, IconLoader2 } from '@tabler/icons-vue'
import { createReviewView } from '../../codemirror/reviewView.js'
import { createReviewSession } from '../../reviewSession.js'
import ReviewComments from './ReviewComments.vue'
import { useGitReviewStore } from '../../../stores/gitReview.js'
import { useSettingsStore } from '../../../stores/settings.js'
import { useEditorUIStore } from '../../../stores/editorUI.js'
import { editorTypographyVars } from '../../../shared/fonts.js'

const git = useGitReviewStore()
const settings = useSettingsStore()
const editorUI = useEditorUIStore()
const viewHost = ref(null)
const discussions = ref(null)
const session = ref(null)
let editorView = null

const wrapperStyle = computed(() => editorTypographyVars({
  fontSize: settings.editorFontSize,
  zoom: editorUI.zoomLevel / 100,
  fontKey: settings.editorFontFamily,
  dark: settings.isDarkTheme,
}))

function buildView() {
  destroyView()
  const review = git.review
  if (!viewHost.value || !review || review.binary) return
  session.value = createReviewSession(review.original, review.modified)
  editorView = createReviewView({
    parent: viewHost.value,
    session: session.value,
    collapse: true,
    locked: true,
    onComment: id => discussions.value?.open(id),
  })
}

function destroyView() {
  editorView?.destroy()
  editorView = null
  session.value = null
  if (viewHost.value) viewHost.value.innerHTML = ''
}

function retry() {
  if (!git.requestedFile) return
  void git.reviewFile(git.requestedFile, { scope: git.scope })
}

watch(() => git.review?.snapshot, () => nextTick(buildView))
watch(() => session.value?.commentUI.showResolved, () => editorView?.refreshComments())
watch(() => git.active, active => {
  if (active) nextTick(buildView)
  else destroyView()
})
onMounted(() => nextTick(buildView))
onUnmounted(destroyView)
defineExpose({ getReviewState: () => editorView ? { ...editorView.getState(), kind: 'history', readOnly: true,
  historyContent: git.review.modified } : null })
</script>

<style scoped>
.git-diff-host :deep(.cm-editor),
.git-diff-host :deep(.cm-scroller) {
  height: 100%;
}

.git-diff-host :deep(.cm-scroller) {
  background: var(--editor-paper, var(--color-surface));
  font-family: var(--editor-font);
  line-height: var(--editor-line-height);
}

.git-diff-host :deep(.cm-content) {
  padding: 24px clamp(8px, 3vw, 24px) clamp(72px, 20vh, 100px);
}
</style>
