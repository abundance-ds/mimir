<template>
  <div
    ref="editorShellRef"
    class="editor-shell h-full w-full flex flex-col bg-surface overflow-hidden"
  >
    <AppHeader
      :embedded="embedded"
      :showAppMenus="showAppMenus"
      :recentFiles="fileManager.visibleRecentFiles"
      :canSave="Boolean(currentFile) && currentFile?.kind !== 'pdf' && currentFile?.kind !== 'external'"
      :hasSelection="!isGraphDetails && Boolean(selectionText)"
      :tabs="displayTabs"
      :activeTab="displayActiveTab"
      :arrivedTabIndex="arrivedTabIndex"
      :hideSidebar="hideSidebar"
      :can-open-in-browser="canOpenInBrowser"
      :browser-opening="browserOpening"
      :browser-open-error="browserOpenError"
      @new-file="createBlankFile"
      @open-file="onOpenDialog"
      @save="onSave"
      @save-as="onSaveAs"
      @close-file="closeActiveEditorTab"
      @open-recent="onOpenRecent"
      @clear-recent="onClearRecent"
      @edit-command="onEditCommand"
      @rewrite-selection="onRewriteSelection"
      @select-tab="selectEditorTab"
      @close-tab="closeEditorTab"
      @discard-tab="requestDiscardTab"
      @add-tab="openNewTabPage"
      @reorder-tab="onReorderTab"
      @open-in-browser="onOpenInBrowser"
    />

    <div v-if="scratchpadPending" class="pane-subbar flex items-center gap-2 px-3 text-xs text-ink-2" role="status">
      Scratchpad updated
      <button class="text-accent focus-visible:outline" @mousedown.prevent @click="scratchpadEditor.show()">Open</button>
    </div>
    <div v-if="graph.lastDeletion" class="graph-delete-notice" role="status">
      <span>{{ graph.lastDeletion.title }} moved to Trash.</span>
      <button type="button" @click="undoGraphDelete">Undo</button>
    </div>
    <div class="editor-body flex-1 flex min-h-0 bg-chrome">
      <div class="editor-workspace flex-1 flex flex-col min-w-0">
        <ScratchpadBar v-if="scratchpadActive"
          :history="scratchpadEditor.store.history" :content="currentFile?.content || ''"
          :selected="scratchpadSelected" :changes="scratchpadChanges" :get-content="flushEditorContent"
          @update:changes="scratchpadEditor.toggleChanges"
          :conflict="scratchpadConflict" :busy="scratchpadBusy" :error="scratchpadEditor.store.error"
          @browse="scratchpadEditor.browse" @replace="scratchpadEditor.replace"
          @use-latest="scratchpadEditor.replace(scratchpadEditor.store.content, { useLatest: true })"
          @error="showDiagnosticError"
        />
        <InlineAI
          v-if="inlineAIState && !isResourcePreview && !isGraphDetails"
          :key="inlineAIKey"
          :selection="inlineAIState"
          :documentId="documentIdFromPath(currentFile?.path)"
          :getDocument="getDocumentForInlineAI"
          :projectPath="inlineAIProjectPath"
          :escapeBlocked="editorModalOpen"
          @apply="onInlineAIApply"
          @activate-diff="onInlineAIActivateDiff"
          @deactivate-diff="onInlineAIDeactivateDiff"
          @close="closeInlineAI"
          @configure-models="openSettings('models')"
        />
        <DiffBar
          v-else-if="!gitReviewVisible && visibleDiffActive && (!diffStore.isBatch || reviewTabActive || diffStore.isBatchFileFocused)"
          @accept-all="acceptDiffAndFocus"
          @reject-all="rejectDiffAndFocus"
          @navigate-chunk="onDiffNavigateChunk"
          @navigate-file="onDiffNavigateFile"
        />
        <GitReviewBar
          v-else-if="gitReviewVisible"
          :dirty="gitReviewDirty"
          :managed="gitReviewManaged"
          @open-file="onGitReviewOpenFile"
          @ask-agent="onGitReviewAskAgent"
          @close="closeGitReview"
        />
        <PendingProposalBar
          v-else-if="pendingReviewBarVisible"
          :count="currentFile?.reviews?.length || 0"
          :busy="pendingReviewBusy"
          :error="pendingReviewError"
          @recheck="onRecheckPendingReviews"
          @discard="onDiscardPendingReviews"
        />
        <div v-if="currentFile?.graph && !isGraphDetails && !gitReviewVisible" class="graph-source-header focus-header">
          <div class="graph-document-views" aria-label="Entry view">
            <button type="button" :disabled="graphViewBusy || visibleDiffActive || !currentFile.graph.node || currentFile.graph.unavailable" @click="setGraphView('details')">Details</button>
            <button type="button" class="is-active" aria-pressed="true">Source</button>
          </div>
          <span class="graph-source-kind">{{ currentFile.graph.node?.kind || 'Graph entry' }}</span>
        </div>
        <div v-if="currentFile?.graph && (graphViewError || (!isGraphDetails && currentFile.saveError))" class="object-conflict" role="alert">{{ graphViewError || currentFile.saveError }}</div>
        <div v-if="currentFile?.graph && !isGraphDetails && !currentFile.graph.node" class="graph-source-help" role="status">Fix the entry’s metadata in Source to use Details.</div>
        <EditorToolbar
          v-if="editorToolbarVisible && !gitReviewVisible && !scratchpadActive"
          :active-formats="activeFormats"
          :has-selection="Boolean(selectionText)"
          :comment-count="commentManager.visibleComments.length"
          :lifecycle-action="discardModeForFile(currentFile)"
          @format="onFormat"
          @comment="onComment"
          @navigate-comment="commentPresentation.navigateComment"
          @discard-file="requestDiscardFile(currentFile)"
        />
        <div class="editor-panes flex-1 flex min-h-0 overflow-hidden" :class="{ 'flex-col': isSvgFile }">
          <GraphEditorTab
            v-if="isGraphDetails && !gitReviewVisible"
            :key="`${currentFile.id}:${currentFile.path}`"
            ref="graphEditorTabRef"
            :file="currentFile"
            @source="setGraphView('source')"
            @close-request="closeGraphDetails"
            @open-graph="mimirOpenGraph"
            @open-file="$emit('openGraphFile', $event)"
            @open-url="openMarkdownUrlLink"
            @open-activity="$emit('openGraphActivity', $event)"
            @start-work="$emit('startGraphWork', $event)"
            @open-meeting="$emit('openGraphMeeting', $event)"
            @diagnostic="showDiagnosticError"
          />
          <ScratchpadHistory v-if="scratchpadHistoryVisible"
            :content="scratchpadSelected?.content ?? currentFile?.content ?? ''"
            :before="scratchpadBefore" :changes="scratchpadChanges"
          />
          <GitDiffView v-if="gitReviewVisible" />
          <BatchDiffView
            v-else-if="visibleDiffActive && diffStore.isBatch && reviewTabActive"
            ref="batchDiffViewRef"
            @all-resolved="onBatchAllResolved"
          />
          <DiffView
            v-else-if="visibleDiffActive && (!diffStore.isBatch || diffStore.isBatchFileFocused)"
            ref="diffViewRef"
            @accept="onDiffChunksResolved"
          />
          <FilePreviewPage
            v-if="(isResourcePreview || isSvgFile) && !visibleDiffActive && !gitReviewVisible"
            :key="`${currentFile.id}:${currentFile.path}`"
            :file="currentFile"
            :source-mode="svgSourceMode"
            :prepare-open="preparePreviewOpen"
            @source-mode="setSvgSourceMode"
            @refresh="externalFileSync.refreshChangedPaths({ paths: [currentFile.path] })"
            @view-change="currentFile.previewView = { ...currentFile.previewView, ...$event }"
          />
          <NewTabPage
            v-else-if="isNewTabPage && !visibleDiffActive && !gitReviewVisible"
            @activated="restoreEditorFocus"
          />
          <EditorSurface
            ref="textSurfaceRef"
            :style="{ display: textSurfaceVisible ? undefined : 'none' }"
            :content="textSurfaceDocument.content"
            :path="textSurfaceDocument.path"
            :file-id="textSurfaceDocument.fileId"
            :open-file-ids="openFileIds"
            :zoomLevel="state.zoomLevel"
            :maxWidth="editorContentMaxWidth"
            :showBorder="false"
            :extensions="textSurfaceDocument.extensions"
            :inlineAIEnabled="editorSettings.aiInlineRewrite"
            @change="onContentChange"
            @cursor="info => cursorLine = info.line"
            @selection-change="selectionText = $event"
            @selection-command="onSelectionCommand"
            @format="onFormat"
            @comment="onComment"
            @ask-agent="onAskAgent"
            @active-formats="activeFormats = $event"
          />
        </div>

        <AppFooter
          v-if="!isGraphDetails && !scratchpadHistoryVisible && !isResourcePreview && !gitReviewVisible"
          :zoomLevel="state.zoomLevel"
          :selectionText="selectionText"
          :stats="documentStats"
          :saveStatus="footerSave"
          :resolved-comment-count="commentManager.resolvedCommentCount"
          :resolved-comments-visible="commentManager.resolvedCommentsVisible"
          @zoom-in="zoomIn"
          @zoom-out="zoomOut"
          @set-zoom="setZoomLevel"
          @save-status-click="onSaveStatusClick"
          @toggle-resolved-comments="commentPresentation.toggleResolvedComments"
        />
      </div>

    </div>

    <SettingsDialog
      :open="state.settingsOpen"
      :initial-section="settingsInitialSection"
      @close="closeSettings"
    />


    <Teleport to="body">
      <Transition name="settings-fade">
        <div
          v-if="closeConfirmFile"
          ref="closeOverlayRef"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onCloseConfirm('cancel')"
        >
          <div
            class="close-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-confirm-title"
            aria-describedby="close-confirm-description"
            @keydown="onModalKeydown($event, () => onCloseConfirm('cancel'))"
          >
            <p id="close-confirm-title" class="close-confirm-title">Save changes?</p>
            <p id="close-confirm-description" class="close-confirm-body">
              "{{ closeConfirmFileName }}" has unsaved changes that will be lost if you close without saving.
            </p>
            <div class="close-confirm-actions">
              <button type="button" data-modal-initial class="close-confirm-btn btn-cancel" @click="onCloseConfirm('cancel')">Cancel</button>
              <button type="button" class="close-confirm-btn btn-discard" @click="onCloseConfirm('discard')">Don't Save</button>
              <button type="button" class="close-confirm-btn btn-save" @click="onCloseConfirm('save')">Save</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="settings-fade">
        <div
          v-if="discardConfirm"
          ref="discardOverlayRef"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="cancelDiscard"
        >
          <div
            class="close-confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-confirm-title"
            aria-describedby="discard-confirm-description"
            @keydown="onModalKeydown($event, cancelDiscard)"
          >
            <p id="discard-confirm-title" class="close-confirm-title">
              {{ discardConfirmMode === 'trash' ? `Move ${discardConfirmFileName} to Trash?` : 'Discard this draft?' }}
            </p>
            <p id="discard-confirm-description" class="close-confirm-body">
              <template v-if="discardConfirmMode === 'trash'">
                The file moves to the system Trash and can be restored there.
                <span v-if="discardConfirm.file.dirty"> Unsaved changes will be discarded.</span>
              </template>
              <template v-else>
                This draft{{ discardConfirm.file.dirty ? ' and its unsaved changes' : '' }} will be discarded. This action cannot be undone.
              </template>
            </p>
            <p v-if="discardError" class="discard-confirm-error" role="alert">{{ discardError }}</p>
            <div class="close-confirm-actions">
              <button
                type="button"
                class="close-confirm-btn btn-cancel"
                :disabled="discardPending"
                @click="cancelDiscard"
              >Cancel</button>
              <button
                type="button"
                data-modal-initial
                data-discard-confirm
                class="close-confirm-btn btn-remove"
                :disabled="discardPending"
                @click="confirmDiscard"
              >{{ discardPending ? 'Working…' : (discardConfirmMode === 'trash' ? 'Move to Trash' : 'Discard Draft') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="settings-fade">
        <div
          v-if="restoreConfirmMeta"
          ref="restoreOverlayRef"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onRestoreConfirm('cancel')"
        >
          <div
            class="close-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-confirm-title"
            aria-describedby="restore-confirm-description"
            @keydown="onModalKeydown($event, () => onRestoreConfirm('cancel'))"
          >
            <p id="restore-confirm-title" class="close-confirm-title">Restore this version?</p>
            <p id="restore-confirm-description" class="close-confirm-body">
              Your document will revert to how it was {{ restoreTimeLabel }}. Use {{ modKey }}Z to undo.
            </p>
            <div class="close-confirm-actions">
              <button type="button" data-modal-initial class="close-confirm-btn btn-cancel" @click="onRestoreConfirm('cancel')">Cancel</button>
              <button type="button" class="close-confirm-btn btn-save" @click="onRestoreConfirm('restore')">Restore</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="settings-fade">
        <div
          v-if="commentGateVisible"
          ref="commentGateOverlayRef"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onCommentGateConfirm(false)"
        >
          <div
            class="close-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="comment-gate-title"
            aria-describedby="comment-gate-description"
            @keydown="onModalKeydown($event, () => onCommentGateConfirm(false))"
          >
            <p id="comment-gate-title" class="close-confirm-title">Comments modify your file</p>
            <p id="comment-gate-description" class="close-confirm-body">
              This will modify your document file. Comments may not display correctly in other applications. You can remove all comments at any time.
            </p>
            <label class="flex items-center gap-2 mb-4 font-sans text-[12px] text-ink-2">
              <input type="checkbox" v-model="commentGateDontAsk" class="accent-accent" />
              Don't show again
            </label>
            <div class="close-confirm-actions">
              <button type="button" data-modal-initial class="close-confirm-btn btn-cancel" @click="onCommentGateConfirm(false)">Cancel</button>
              <button type="button" class="close-confirm-btn btn-save" @click="onCommentGateConfirm(true)">Add comment</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted, provide } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorUIStore } from '../stores/editorUI.js'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts.js'
import { pathIsInsideWorkspace, useFileStore } from '../stores/files.js'
import GraphEditorTab from './components/workspace/GraphEditorTab.vue'
import { useBusinessGraphStore } from '../stores/businessGraph.js'
import { graphSourceBodyStart } from '../stores/graphDocuments.js'
import { getGraphNode, graphSource, lookupGraph, graphLinkTargets } from '../services/businessGraph.js'
import { graphLinks } from './codemirror/graphLinks.js'
import { referenceSelection } from './codemirror/graphLinkSyntax.js'
import { useSettingsStore } from '../stores/settings.js'
import { useDocumentBridge } from './composables/useDocumentBridge.js'
import { isTauriRuntime, platformKind } from '../shared/platform.js'
import { relativeTime } from '../shared/time.js'
import { basename, parentPath } from '../shared/utils/path.js'
import { openHtmlInBrowser, readFile } from '../services/fileSystem.js'
import { trashWorkspaceEntries } from '../services/workspaceFileOperations.js'
import { absoluteWorkspacePath } from '../services/gitChanges.js'
import { createWindowCloseGuard } from './windowCloseGuard.js'
import { ghostExtension } from './codemirror/ghost.js'
import { livePreviewExtension } from './codemirror/livePreview.js'
import { markdownLinkOpen, resolveMarkdownFileTarget } from './codemirror/markdownLinks.js'
import { taskCheckboxExtension } from './codemirror/taskCheckboxes.js'
import { commentsExtension, getCommentsFromState, commentMutation } from './codemirror/comments.js'
import { escapeAttr } from '../services/comments/parser.js'
import { snapCommentAnchor } from '../services/comments/anchor.js'
import { buildCommentsPrompt } from '../services/comments/prompt.js'
import { EditorView } from '@codemirror/view'
import { useCommentsStore } from '../stores/comments.js'
import { useEditorProposalLifecycle } from './composables/useEditorProposalLifecycle.js'
import { useEditorNativeLifecycle } from './composables/useEditorNativeLifecycle.js'
import { useEditorSessionLifecycle } from './composables/useEditorSessionLifecycle.js'
import { useEditorCommandApi } from './composables/useEditorCommandApi.js'
import { useScratchpadEditor } from './composables/useScratchpadEditor.js'
import ScratchpadBar from './components/workspace/ScratchpadBar.vue'
import ScratchpadHistory from './components/workspace/ScratchpadHistory.vue'
import { useFileOpen } from './composables/useFileOpen.js'
import { useContentSync } from './composables/useContentSync.js'
import { useExternalFileSync } from './composables/useExternalFileSync.js'
import { useCommentMutations } from './composables/useCommentMutations.js'
import { useCommentPresentation } from './composables/useCommentPresentation.js'
import { useDiffReview } from './composables/useDiffReview.js'
import { useTabManagement } from './composables/useTabManagement.js'
import { requestGhostSuggestions } from '../services/ai/ghost.js'
import { documentIdFromPath } from '../services/ai/context.js'
import { createAutoSaveController } from './autoSaveController.js'
import { fileDisplayName, footerSaveStatus, tabFromFile } from './saveStatus.js'
import { useSaveFeedbackStore } from '../stores/saveFeedback.js'
import { useAppUpdateStore } from '../stores/appUpdate.js'
import { diffIsVisibleForFile, singleDiffTargetsFile } from './workspaceDiffProjection.js'
import { openExternalUrl } from '../services/externalLinks.js'

import AppFooter from './components/shell/AppFooter.vue'
import AppHeader from './components/shell/AppHeader.vue'
import SettingsDialog from '../shared/ui/SettingsDialog.vue'
import EditorSurface from './components/workspace/EditorSurface.vue'
import EditorToolbar from './components/workspace/EditorToolbar.vue'
import InlineAI from './components/workspace/InlineAI.vue'
import DiffBar from './components/workspace/DiffBar.vue'
import DiffView from './components/workspace/DiffView.vue'
import BatchDiffView from './components/workspace/BatchDiffView.vue'
import NewTabPage from './components/workspace/NewTabPage.vue'
import FilePreviewPage from './components/workspace/FilePreviewPage.vue'
import { isSvgPath } from '../shared/utils/filePreview.js'
import GitDiffView from './components/workspace/GitDiffView.vue'
import GitReviewBar from './components/workspace/GitReviewBar.vue'
import PendingProposalBar from './components/workspace/PendingProposalBar.vue'
import { useDiffStore } from '../stores/diff.js'
import { useGitReviewStore } from '../stores/gitReview.js'

const props = defineProps({
  hideSidebar: { type: Boolean, default: false },
  embedded: { type: Boolean, default: false },
  workspacePath: { type: String, default: '' },
  workspacePaths: { type: Array, default: () => [] },
})
const emit = defineEmits([
  'closeRequest',
  'empty',
  'navigateEditor',
  'newRequest',
  'quickOpenRequest',
  'reviewGitWithAgent',
  'diagnostic',
  'scratchpadReveal',
  'openGraphNode',
  'openGraphFile',
  'openGraphActivity',
  'startGraphWork',
  'openGraphMeeting',
  'focusGraph',
])
const editorShellRef = ref(null)

const editorUI = useEditorUIStore()
const state = editorUI
const { zoomIn, zoomOut, setZoomLevel } = editorUI
const showAppMenus = platformKind() !== 'macos'

const editorSettings = useSettingsStore()
const appUpdates = useAppUpdateStore()
const releaseEditorSettingsSync = props.embedded
  ? null
  : editorSettings.startSync()

const fileManager = useFileStore()
const graph = useBusinessGraphStore()
const {
  activeFileIndex,
  activeVisibleFileIndex,
  currentFile,
  openFiles,
  visibleOpenFiles,
} = storeToRefs(fileManager)

const commentManager = useCommentsStore()
const diffStore = useDiffStore()
const gitReview = useGitReviewStore()
const diffViewRef = ref(null)
const batchDiffViewRef = ref(null)

const visibleDiffActive = computed(() => {
  return diffIsVisibleForFile(
    diffStore,
    currentFile.value,
    path => fileManager.pathIsVisible(path),
  )
})

const selectionText = ref('')
const cursorLine = ref(0)
const inlineAIState = ref(null)
const inlineAIKey = ref(0)
const textSurfaceRef = ref(null)
const graphEditorTabRef = ref(null)
const isGraphDetails = computed(() => currentFile.value?.kind === 'graph')
const isGraphSource = computed(() => currentFile.value?.kind === 'text' && Boolean(currentFile.value?.graph) && !currentFile.value.graph.unavailable)
const editorSurfaceRef = computed(() => isGraphDetails.value ? null : textSurfaceRef.value)
const graphViewError = ref('')
const graphViewBusy = ref(false)
let graphOpenGeneration = 0
let graphClosePending = false
const editorScrollInfo = ref({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
const editorGeometryVersion = ref(0)
const activeFormats = ref([])
const browserOpening = ref(false)
const browserOpenError = ref('')
watch(() => props.workspacePath, (path, previous) => {
  if (path === previous) return
  graphOpenGeneration += 1
  inlineAIState.value = null
  selectionText.value = ''
})
const openFileIds = computed(() => openFiles.value.map(file => file.id))
const isNewTabPage = computed(() => currentFile.value?.newTab === true)
const isSvgFile = computed(() => currentFile.value?.kind === 'text' && isSvgPath(currentFile.value?.path))
const svgSourceMode = computed(() => isSvgFile.value && currentFile.value?.previewView?.sourceMode === true)
const isResourcePreview = computed(() => (
  ['pdf', 'external'].includes(currentFile.value?.kind) || (isSvgFile.value && !svgSourceMode.value)
))

function setSvgSourceMode(sourceMode) {
  flushEditorContent({ bridge: 'flush' })
  currentFile.value.previewView = { ...currentFile.value.previewView, sourceMode }
  if (sourceMode) void nextTick(restoreEditorFocus)
}

async function preparePreviewOpen(file) {
  if (file.kind !== 'text') return
  flushEditorContent({ bridge: 'flush' })
  if (file.dirty && !await saveCurrentFile({ source: 'manual', file })) {
    throw new Error('Save the file before opening it in the default app.')
  }
}
const editorToolbarVisible = computed(() => (
  editorSettings.editorToolbarMode !== 'none'
  && !isNewTabPage.value
  && !isGraphDetails.value
  && !isResourcePreview.value
  && !visibleDiffActive.value
  && isMarkdownPath(currentFile.value?.path)
))
const inlineAIProjectPath = computed(() => parentPath(currentFile.value?.path))
const closeOverlayRef = ref(null)
const discardOverlayRef = ref(null)
const restoreConfirmMeta = ref(null)
const restoreOverlayRef = ref(null)
const commentGateVisible = ref(false)
const commentGateDontAsk = ref(false)
const commentGateOverlayRef = ref(null)
const editorModalOpen = computed(() => Boolean(
  state.settingsOpen
  || closeConfirmFile?.value
  || discardConfirm?.value
  || restoreConfirmMeta.value
  || commentGateVisible.value
))
let commentGateResolve = null
let modalReturnFocus = null

let editorDisposed = false

function isMarkdownPath(path) {
  if (!path) return true
  return /\.(?:md|markdown|mdown|mkd)$/i.test(String(path))
}

function isHtmlPath(path) {
  return /\.html?$/i.test(String(path || ''))
}

const canOpenInBrowser = computed(() => (
  currentFile.value?.kind === 'text'
  && Boolean(currentFile.value?.path)
  && isHtmlPath(currentFile.value.path)
  && !isNewTabPage.value
  && !isResourcePreview.value
  && !visibleDiffActive.value
  && !gitReviewVisible.value
))

watch(() => currentFile.value?.path, () => {
  graphViewError.value = ''
  browserOpenError.value = ''
})

function discardModeForFile(file) {
  if (file?.meta?.scratchpad) return ''
  if (!file || file.newTab || file.kind !== 'text' || file.reviews?.length) return ''
  if (diffStore.active) {
    if (!diffStore.isBatch && singleDiffTargetsFile(diffStore, file)) return ''
    if (diffStore.isBatch && (diffStore.files || []).some(item => item.path === file.path)) return ''
  }
  if (!file.path) return 'draft'
  if (!props.embedded || !props.workspacePath) return ''
  return pathIsInsideWorkspace(file.path, props.workspacePath) ? 'trash' : ''
}

function reportSessionError(error) {
  console.error('[session] persistence failed', error)
}

const documentBridge = useDocumentBridge()
const nativeFileOpen = useFileOpen({
  autoStart: false,
  onOpened: (path) => {
    emit('navigateEditor', { path })
    restoreEditorFocus()
  },
  onError: error => console.error('[file-open]', error),
})

const editorLineWidthMap = {
  normal: '100ch',
  wide: '120ch',
  off: '',
}

// Footer word/line counts. Computed lazily on a debounce instead of a
// computed over the reactive content string: the O(n) scans below would
// otherwise re-run on every content sync (~150ms) while typing.
const DOCUMENT_STATS_DELAY = 500
const documentStats = ref(computeDocumentStats(''))
let documentStatsTimer = null

function computeDocumentStats(text) {
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  const characters = text.length
  const spaces = (text.match(/ /g) || []).length
  const lines = text ? text.split('\n').length : 0
  const readingMinutes = Math.max(1, Math.round(words / 230))
  return { words, characters, spaces, lines, readingMinutes }
}

watch(
  () => [currentFile.value?.id ?? null, currentFile.value?.content ?? ''],
  ([fileId, text], previous) => {
    clearTimeout(documentStatsTimer)
    if (!previous || previous[0] !== fileId) {
      // File switch (or first run): update the footer immediately.
      documentStats.value = computeDocumentStats(text)
      return
    }
    documentStatsTimer = setTimeout(() => {
      documentStats.value = computeDocumentStats(text)
    }, DOCUMENT_STATS_DELAY)
  },
  { immediate: true },
)

const editorContentMaxWidth = computed(() => (
  editorLineWidthMap[editorSettings.editorLineWidth] ?? editorLineWidthMap.normal
))

const editorTabs = computed(() => {
  let untitledCount = 0
  return visibleOpenFiles.value.map(file => ({
    ...tabFromFile(file, {
      autoSaveEnabled: editorSettings.editorAutoSave || file.meta?.scratchpad === true,
      untitledIndex: file.path ? 0 : ++untitledCount,
    }),
    lifecycleAction: discardModeForFile(file),
    fileIndex: openFiles.value.indexOf(file),
  }))
})

const reviewTabActive = ref(false)
const gitReviewTabActive = ref(false)
const gitReviewManaged = ref(false)
const gitReviewVisible = computed(() => gitReview.active && gitReviewTabActive.value)
const gitReviewPath = computed(() => {
  const relativePath = gitReview.review?.path || gitReview.requestedFile
  return relativePath
    ? absoluteWorkspacePath(gitReview.workspacePath, relativePath)
    : ''
})
const gitReviewDirty = computed(() => {
  const path = normalizeComparablePath(gitReviewPath.value)
  if (!path) return false
  return openFiles.value.some(file => normalizeComparablePath(file.path) === path && file.dirty)
})

const displayTabs = computed(() => {
  const fileTabs = editorTabs.value.map(t => ({ ...t, type: 'file' }))
  const tabs = [...fileTabs]
  if (diffStore.isBatch && visibleDiffActive.value) {
    const pending = diffStore.pendingFiles.length
    const total = diffStore.files.length
    tabs.push({
      id: '__review__',
      name: `Review · ${pending > 0 ? pending : total}`,
      type: 'review',
      dirty: pending > 0,
      saveTone: 'clean',
    })
  }
  if (gitReview.active) {
    tabs.push({
      id: '__git_review__',
      name: `Changes · ${basename(gitReview.review?.path || gitReview.requestedFile || 'Review')}`,
      type: 'git-review',
      dirty: false,
      saveTone: 'clean',
    })
  }
  return tabs
})

const displayActiveTab = computed(() => {
  if (gitReviewVisible.value) {
    return displayTabs.value.findIndex(tab => tab.type === 'git-review')
  }
  if (reviewTabActive.value && diffStore.isBatch && visibleDiffActive.value) {
    return displayTabs.value.findIndex(tab => tab.type === 'review')
  }
  return activeVisibleFileIndex.value
})

const saveFeedback = useSaveFeedbackStore()
const feedbackMatchesCurrentFile = computed(() => (
  Boolean(currentFile.value?.id)
  && saveFeedback.fileId === currentFile.value.id
))
const footerSave = computed(() => footerSaveStatus({
  file: currentFile.value,
  autoSaveEnabled: editorSettings.editorAutoSave || currentFile.value?.meta?.scratchpad === true,
  savingVisible: feedbackMatchesCurrentFile.value && saveFeedback.savingVisible,
  savedVisible: feedbackMatchesCurrentFile.value && saveFeedback.savedVisible,
  savedLabel: saveFeedback.savedLabel,
}))
const settingsInitialSection = ref('appearance')

provide('editorSurfaceRef', editorSurfaceRef)
provide('editorScrollInfo', editorScrollInfo)
provide('editorGeometryVersion', editorGeometryVersion)
provide('activateDiff', (...args) => activateDiffForCurrentFile(...args))
provide('hasEditorSelection', computed(() => Boolean(selectionText.value)))
provide('onAddComment', () => onComment())
provide('currentFilePath', computed(() => currentFile.value?.path || ''))
const commentMutations = useCommentMutations(editorSurfaceRef)
const commentPresentation = useCommentPresentation(editorSurfaceRef, commentManager)
provide('commentMutations', commentMutations)

// --- Proposal bridge (cross-window) ---

const proposalLifecycle = useEditorProposalLifecycle({
  fileManager,
  diffStore,
  openFiles,
  activeFileIndex,
  currentEditorContent: () => currentEditorContent(),
  flushEditorContent: (...args) => flushEditorContent(...args),
  editorSurfaceRef,
  activateDiff: (...args) => {
    gitReviewTabActive.value = false
    return activateDiffForCurrentFile(...args)
  },
  activateBatchDiff: (...args) => {
    gitReviewTabActive.value = false
    return activateBatchDiff(...args)
  },
})

// A proposal whose target text cannot be matched to the current buffer stays
// pending in the native coordinator. This bar keeps it visible and offers the
// only two honest actions: recompute against the current text, or discard it
// through the shared lifecycle.
const pendingReviewBusy = ref(false)
const pendingReviewError = ref('')
const pendingReviewBarVisible = computed(() => (
  Boolean(currentFile.value?.reviews?.length) && !visibleDiffActive.value
))

function onRecheckPendingReviews() {
  pendingReviewError.value = ''
  const shown = proposalLifecycle.activateDiffFromReviews(currentFile.value)
  if (!shown) {
    pendingReviewError.value = 'The target text still does not match.'
  }
}

async function onDiscardPendingReviews() {
  const file = currentFile.value
  const reviews = file?.reviews || []
  if (!reviews.length || pendingReviewBusy.value) return
  pendingReviewBusy.value = true
  pendingReviewError.value = ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // allSettled: one failed report must not strand the other proposals
    // un-rejected. Failed reviews stay stashed so Discard can retry them.
    const results = await Promise.allSettled(reviews.map(review => invoke('proposal_respond', {
      result: {
        id: review.proposalId,
        sessionId: review.sessionId,
        status: 'rejected',
        detail: 'User discarded the pending proposal',
      },
    })))
    const failed = reviews.filter((review, index) => results[index].status === 'rejected')
    if (failed.length === 0) {
      fileManager.clearFileReviews(file)
    } else {
      fileManager.setFileReviews(file, failed)
      const reason = results.find(result => result.status === 'rejected')?.reason
      pendingReviewError.value = `Could not discard ${failed.length} of ${reviews.length}: ${reason?.message || reason}`
    }
  } catch (cause) {
    pendingReviewError.value = `Could not discard: ${cause?.message || cause}`
  } finally {
    pendingReviewBusy.value = false
  }
}

function openMarkdownFileLink(target) {
  const path = resolveMarkdownFileTarget(target, {
    sourcePath: currentFile.value?.path,
    fallbackDirectory: props.workspacePath,
    homeDirectory: typeof window !== 'undefined' ? window.__MIMIR_HOME__ : '',
  })
  if (!path) return
  void mimirOpen(path, { preview: false }).catch(error => {
    console.error('[markdown-link] file open failed', error)
  })
}

function openMarkdownUrlLink(target) {
  void openExternalUrl(target).catch(error => {
    console.error('[markdown-link] URL open failed', error)
  })
}

const sourceGraphLinks = computed(() => {
  const file = currentFile.value
  if (!isGraphSource.value || !file) return null
  return graphLinks({
    lookup: lookupGraph,
    resolve: graphLinkTargets,
    scopeIds: () => graph.activeScopeIds,
    bodyStart: graphSourceBodyStart,
    open: id => { void mimirOpenGraph(id).catch(showDiagnosticError) },
    onError: message => { graphViewError.value = message },
  })
})
watch(() => [graph.status?.graphRevision, graph.activeScopeIds.join('\0')], () => sourceGraphLinks.value?.refresh())

const editorExtensions = computed(() => [
  ...(sourceGraphLinks.value ? [sourceGraphLinks.value.extension] : []),
  commentsExtension({
    onCommentClick: (id) => {
      commentManager.setActiveComment(id)
    },
    onCommentAction: (action) => onInlineCommentAction(action),
    onCommentCreate: () => onComment(),
    onScroll: (info) => {
      editorScrollInfo.value = info
    },
    onGeometryChange: () => {
      editorGeometryVersion.value++
    },
  }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged || update.startState.field !== update.state.field) {
      const parsed = getCommentsFromState(update.state)
      commentManager.updateCommentsFromState(parsed)
    }
  }),
  ...(editorSettings.aiGhostSuggestions ? [ghostExtension({
    getSuggestions: async ({ before, after, fallback }) => {
      const docId = documentIdFromPath(currentFile.value?.path)
      const result = await requestGhostSuggestions({ before, after, documentId: docId, fallback })
      if (typeof result.error === 'string') return { suggestions: [], error: result.error }
      return result.suggestions
    },
  })] : []),
  ...livePreviewExtension(
    () => editorSettings.editorLivePreview,
    () => currentFile.value?.path,
    state => sourceGraphLinks.value?.references(state) || [],
  ),
  markdownLinkOpen({
    enabled: (view, event) => {
      if (!editorSettings.editorLivePreview || !isMarkdownPath(currentFile.value?.path)) return false
      if (!isGraphSource.value) return true
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, true)
      return position != null && position >= graphSourceBodyStart(view.state)
    },
    selector: '.cm-lp-link',
    preserveRenderedLink: true,
    onOpenFile: openMarkdownFileLink,
    onOpenUrl: openMarkdownUrlLink,
    onOpenGraph: id => {
      if (isGraphSource.value) sourceGraphLinks.value?.openTarget(id)
    },
  }),
  ...taskCheckboxExtension(() => editorSettings.editorLivePreview && isMarkdownPath(currentFile.value?.path)),
])

// Patch visibility with the DOM so Source can read scroll after the update.
const textSurfaceVisible = computed(() => (
  !isGraphDetails.value && !scratchpadHistoryVisible.value && !gitReviewVisible.value
  && !isResourcePreview.value && !isNewTabPage.value
  && (!visibleDiffActive.value || (diffStore.isBatch && !reviewTabActive.value && !diffStore.isBatchFileFocused))
))

// Details owns its draft. Retain the last Source projection and undo state
// without parsing or updating an unseen document on each Graph selection.
const textSurfaceDocument = computed(previous => {
  if (isGraphDetails.value) return previous || { content: '', path: '', fileId: '', extensions: [] }
  return {
    content: currentFile.value?.content ?? '',
    path: currentFile.value?.path ?? '',
    fileId: currentFile.value?.id ?? '',
    extensions: editorExtensions.value,
  }
})

// --- Content sync + save ---

const contentSync = useContentSync({
  editorSurfaceRef,
  currentFile,
  fileManager,
  documentBridge,
})
const { currentEditorContent, flushEditorContent, scheduleContentSync, syncOpenFileSnapshot } = contentSync

watch(
  () => [props.embedded, props.workspacePath, props.workspacePaths],
  ([embedded, workspacePath, workspacePaths]) => {
    prepareWorkspaceSwitch()
    if (embedded) fileManager.setWorkspaceScope(workspacePath, workspacePaths)
    else fileManager.clearWorkspaceScope()
  },
  { immediate: true, deep: true },
)

const externalFileSync = useExternalFileSync({
  fileManager,
  readFile,
  ignorePath: path => path === scratchpadEditor.store.path,
  onReloaded: (file) => {
    if (fileManager.currentFile !== file) return
    if (visibleDiffActive.value) diffStore.deactivate()
    syncOpenFileSnapshot()
  },
})

const editorSession = useEditorSessionLifecycle({
  fileManager,
  openFiles,
  activeFileIndex,
  readFile,
  getZoomLevel: () => state.zoomLevel,
  setZoomLevel: value => {
    state.zoomLevel = value
  },
  flushEditorContent,
  onError: reportSessionError,
})

async function saveCurrentFile({ source = 'manual', mode = 'save', file = null } = {}) {
  const targetFile = file || currentFile.value
  if (!targetFile) return false
  const feedbackMode = mode === 'saveAs' || !targetFile.path ? 'saveAs' : 'save'
  const feedbackToken = saveFeedback.begin(source, targetFile.id)
  saveFeedback.setMode(feedbackMode, feedbackToken)
  try {
    const didSave = mode === 'saveAs'
      ? await fileManager.saveAs(targetFile)
      : await fileManager.save(targetFile)
    saveFeedback.finish(
      didSave,
      targetFile.path ? fileDisplayName(targetFile) : 'Saved',
      feedbackToken,
    )
    return didSave
  } catch (error) {
    saveFeedback.finish(false, 'Saved', feedbackToken)
    throw error
  }
}

const autoSave = createAutoSaveController({
  flush: flushEditorContent,
  save: saveCurrentFile,
  getFile: () => currentFile.value,
  isAutoSaveEnabled: file => file?.kind !== 'graph' && !(file?.graph && closeConfirmFile.value === file) && (editorSettings.editorAutoSave || file?.meta?.scratchpad === true),
  onError: () => {},
})

function onContentChange() {
  if (isGraphDetails.value) return
  fileManager.markDirty()
  scheduleContentSync()
  autoSave.schedule()
}

// Sync derived surfaces on tab switch
watch(() => fileManager.activeFileIndex, () => {
  syncOpenFileSnapshot()
})

// --- Tab management ---

const tabMgmt = useTabManagement({
  fileManager,
  diffStore,
  diffActive: visibleDiffActive,
  displayTabs,
  reviewTabActive,
  gitReviewStore: gitReview,
  gitReviewTabActive,
  inlineAIState,
  activeFileIndex,
  flushEditorContent,
  saveCurrentFile,
  trashWorkspaceEntries,
  discardModeForFile,
  cancelAutoSave: file => autoSave.clear(file),
  resumeAutoSave: file => autoSave.schedule(file),
  flushSession: () => editorSession.flush().catch(reportSessionError),
  requestWindowClose: requestEditorWindowClose,
  embedded: props.embedded,
  onEmpty: () => emit('empty'),
})
const {
  closeConfirmFile,
  closeConfirmFileName,
  discardConfirm,
  discardConfirmFileName,
  discardConfirmMode,
  discardError,
  discardPending,
  arrivedTabIndex,
  onSelectTab,
  onCloseTab,
  onCloseConfirm,
  onNewFile,
  onReorderTab,
  confirmFileClose,
  requestDiscardTab,
  requestDiscardFile,
  cancelDiscard,
  confirmDiscard,
} = tabMgmt

const windowCloseGuard = createWindowCloseGuard({
  getWindow: async () => {
    if (!isTauriRuntime()) return null
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow()
  },
  flushContent: () => flushEditorContent({ bridge: 'flush' }),
  getDirtyFiles: () => openFiles.value.filter(file => file.dirty),
  confirmFile: file => confirmFileClose(file),
  awaitReady: editorSession.awaitReady,
  onError: reportSessionError,
  beforeNativeClose: () => editorSettings.flush(),
  beforeNativeHide: () => editorSettings.flush(),
  flushSession: editorSession.flush,
  hideOnClose: isTauriRuntime() && platformKind() === 'macos',
})

async function requestEditorWindowClose(options) {
  const guarded = await windowCloseGuard.requestClose(options)
  if (guarded !== null) return guarded
  window.close()
  return true
}

async function closeEditorTab(index) {
  graphOpenGeneration += 1
  const tab = displayTabs.value[index]
  const file = tab?.type === 'file' ? openFiles.value[tab.fileIndex] : null
  if (file?.meta?.scratchpad) {
    flushEditorContent({ bridge: 'flush' })
    if (file.dirty) {
      try { if (!await saveCurrentFile({ file })) return false }
      catch (cause) { showDiagnosticError(cause); return false }
    }
  }
  if (await dismissEditorSurface()) return false
  const closed = await onCloseTab(index)
  if (closed) {
    await editorSession.flush().catch(reportSessionError)
  }
  if (visibleOpenFiles.value.length) restoreEditorFocus()
  return closed
}

function closeActiveEditorTab() {
  return closeEditorTab(displayActiveTab.value)
}

function prepareWorkspaceSwitch() {
  graphOpenGeneration += 1
  flushEditorContent({ bridge: 'flush' })
  if (gitReview.workspacePath && gitReview.workspacePath !== props.workspacePath) {
    gitReview.clearWorkspace()
    gitReviewTabActive.value = false
  }
}

function restoreEditorFocus() {
  void nextTick(() => {
    if (isGraphDetails.value && !gitReviewVisible.value) {
      graphEditorTabRef.value?.focus()
    } else if (scratchpadHistoryVisible.value) {
      editorShellRef.value?.querySelector('[data-scratchpad-history]')?.focus({ preventScroll: true })
    } else if (isResourcePreview.value && !visibleDiffActive.value && !gitReviewVisible.value) {
      editorShellRef.value?.querySelector('.image-viewport, [data-pdf-preview-viewport]')?.focus({ preventScroll: true })
    } else editorSurfaceRef.value?.focus?.()
  })
}

function selectEditorTab(index) {
  graphOpenGeneration += 1
  const tab = displayTabs.value[index]
  onSelectTab(index)
  if (tab?.type === 'file') restoreEditorFocus()
}

function createBlankFile() {
  graphOpenGeneration += 1
  onNewFile()
  restoreEditorFocus()
}

function openNewTabPage() {
  graphOpenGeneration += 1
  gitReviewTabActive.value = false
  flushEditorContent({ bridge: 'flush' })
  fileManager.newTab()
}

async function dismissEditorSurface() {
  if (state.settingsOpen) {
    closeSettings()
    return true
  }
  if (closeConfirmFile.value) {
    onCloseConfirm('cancel')
    return true
  }
  if (discardConfirm.value) {
    cancelDiscard()
    return true
  }
  if (restoreConfirmMeta.value) {
    onRestoreConfirm('cancel')
    return true
  }
  if (commentGateVisible.value) {
    onCommentGateConfirm(false)
    return true
  }
  if (inlineAIState.value) {
    closeInlineAI()
    restoreEditorFocus()
    return true
  }
  if (gitReviewVisible.value) {
    closeGitReview()
    return true
  }
  if (visibleDiffActive.value) {
    await onDiffRejectAll()
    restoreEditorFocus()
    return true
  }
  return false
}

async function requestEmbeddedClose() {
  if (await dismissEditorSurface()) return true
  emit('closeRequest')
  return false
}

function requestEmbeddedNew() {
  emit('newRequest')
}

function requestEmbeddedQuickOpen() {
  emit('quickOpenRequest')
}

function focusModal(container) {
  if (!container) return
  if (!modalReturnFocus || !modalReturnFocus.isConnected) {
    modalReturnFocus = document.activeElement
  }
  nextTick(() => {
    const target = container.querySelector('[data-modal-initial]')
      || container.querySelector('button:not(:disabled), input:not(:disabled)')
    target?.focus()
  })
}

function restoreModalReturnFocus() {
  const target = modalReturnFocus
  modalReturnFocus = null
  nextTick(() => {
    if (target?.isConnected && typeof target.focus === 'function') target.focus()
    else restoreEditorFocus()
  })
}

function onModalKeydown(event, onCancel) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    onCancel()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget
  const focusable = [...dialog.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden)
  if (!focusable.length) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(closeConfirmFile, (value, previous) => {
  if (value) nextTick(() => focusModal(closeOverlayRef.value))
  else if (previous) restoreModalReturnFocus()
})
watch(discardConfirm, (value, previous) => {
  if (value) nextTick(() => focusModal(discardOverlayRef.value))
  else if (previous) restoreModalReturnFocus()
})
watch(restoreConfirmMeta, (value, previous) => {
  if (value) nextTick(() => focusModal(restoreOverlayRef.value))
  else if (previous) restoreModalReturnFocus()
})
watch(commentGateVisible, (value, previous) => {
  if (value) nextTick(() => focusModal(commentGateOverlayRef.value))
  else if (previous) restoreModalReturnFocus()
})

const restoreTimeLabel = computed(() => {
  const meta = restoreConfirmMeta.value
  if (!meta?.timestamp) return 'an earlier point'
  return relativeTime(meta.timestamp)
})

const modKey = computed(() => platformKind() === 'macos' ? '⌘' : 'Ctrl+')

async function onOpenDialog() {
  flushEditorContent({ bridge: 'flush' })
  await fileManager.openDialog()
}

async function onOpenRecent(path) {
  flushEditorContent({ bridge: 'flush' })
  try {
    await mimirOpen(path)
  } catch {
    fileManager.removeRecentFile(path)
  }
}

function onClearRecent() {
  fileManager.clearVisibleRecentFiles()
}

async function onSave() {
  flushEditorContent({ bridge: 'flush' })
  try {
    await saveCurrentFile({ source: 'manual' })
  } catch { /* save state is already reflected in the footer */ }
}

async function onSaveAs() {
  flushEditorContent({ bridge: 'flush' })
  try {
    await saveCurrentFile({ source: 'manual', mode: 'saveAs' })
  } catch { /* save state is already reflected in the footer */ }
}

async function onOpenInBrowser() {
  const file = currentFile.value
  if (!file?.path || !isHtmlPath(file.path) || browserOpening.value) return

  browserOpening.value = true
  browserOpenError.value = ''
  try {
    flushEditorContent({ bridge: 'flush' })
    if (file.dirty) {
      const saved = await saveCurrentFile({ source: 'manual', file })
      if (!saved) throw new Error('Save the file before opening it in the browser.')
    }
    await openHtmlInBrowser(file.path)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause || 'Unknown error')
    browserOpenError.value = detail
    emit('diagnostic', `${basename(file.path)} could not open in the browser: ${detail}`)
  } finally {
    browserOpening.value = false
  }
}

function openSettings(section = 'appearance') {
  settingsInitialSection.value = section
  state.settingsOpen = true
}

function closeSettings() {
  state.settingsOpen = false
  settingsInitialSection.value = 'appearance'
}

async function onSaveStatusClick(status) {
  if (status.action === 'settings') {
    openSettings('writing')
    return
  }
  if (status.action === 'saveAs') {
    await onSaveAs()
    return
  }
  if (status.action === 'retry') {
    if (currentFile.value?.path) await onSave()
    else await onSaveAs()
    return
  }
  if (status.action === 'save') {
    await onSave()
  }
}

watch(() => editorSettings.editorAutoSave, (enabled) => {
  if (enabled) autoSave.schedule()
  else autoSave.clear()
})

watch(() => editorSettings.editorLivePreview, () => {
  editorSurfaceRef.value?.poke()
})

watch(() => state.settingsOpen, (open) => {
  if (!open) settingsInitialSection.value = 'appearance'
})

const nativeLifecycle = useEditorNativeLifecycle({
  fileManager,
  editorSettings,
  windowCloseGuard,
  getActions: nativeMenuActions,
  onError: reportSessionError,
})
const { requestAppQuit } = nativeLifecycle
const releaseUpdateRestartGuard = appUpdates.setRestartGuard(
  () => nativeLifecycle.prepareAppRelaunch(),
)

function nativeMenuActions() {
  return {
    openQuickOpen: props.embedded ? requestEmbeddedQuickOpen : undefined,
    newFile: props.embedded ? requestEmbeddedNew : createBlankFile,
    openFile: onOpenDialog,
    openRecent: onOpenRecent,
    clearRecent: onClearRecent,
    save: onSave,
    saveAs: onSaveAs,
    closeTab: props.embedded
      ? requestEmbeddedClose
      : closeActiveEditorTab,
    quit: requestAppQuit,
    editCommand: onEditCommand,
    rewriteSelection: onRewriteSelection,
    openSettings,
    openUpdates: () => openSettings('updates'),
  }
}

watch(() => currentFile.value?.id, () => {
  commentPresentation.reset()
})

watch(() => editorSettings.aiInlineRewrite, (enabled) => {
  if (!enabled && inlineAIState.value) closeInlineAI()
})

// --- Toolbar actions ---

function onFormat(action) {
  if (scratchpadHistoryVisible.value) return
  editorSurfaceRef.value?.format(action)
}

function onEditCommand(action) {
  if (scratchpadHistoryVisible.value) return
  editorSurfaceRef.value?.edit(action)
}

function showCommentGate() {
  commentGateDontAsk.value = false
  return new Promise(resolve => {
    commentGateVisible.value = true
    commentGateResolve = resolve
  })
}

function onCommentGateConfirm(confirmed) {
  commentGateVisible.value = false
  if (commentGateResolve) {
    commentGateResolve({ confirmed, skipFuture: commentGateDontAsk.value })
    commentGateResolve = null
  }
}

async function onComment() {
  const view = editorSurfaceRef.value?.getView()
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return

  // Snap the anchor away from heading/list/quote markers: a tag inserted
  // before a block marker removes the line's block role and its formatting.
  const snapped = snapCommentAnchor(view.state.doc.toString(), sel.from, sel.to)
  if (!snapped) return
  const { from, to } = snapped

  const existing = commentManager.findActiveByRange(from, to)
  if (existing) {
    commentManager.setActiveComment(existing.id)
    return
  }

  const currentComments = getCommentsFromState(view.state)
  for (const c of currentComments) {
    if (Math.max(from, c.contentFrom) < Math.min(to, c.contentTo)) return
  }

  if (!editorSettings.commentGateSkip && currentComments.length === 0) {
    const result = await showCommentGate()
    if (!result.confirmed) return
    if (result.skipFuture) editorSettings.set('commentGateSkip', true)
  }

  const id = Math.random().toString(36).slice(2, 6)
  const now = new Date().toISOString()
  const openTag = `<comment id="${escapeAttr(id)}" author="user" text="" status="active" created="${escapeAttr(now)}">`

  view.dispatch({
    changes: [
      { from, insert: openTag },
      { from: to, insert: '</comment>' },
    ],
    annotations: commentMutation.of(true),
  })

  commentManager.setActiveComment(id)
}

function commentPrompt(commentId) {
  const view = editorSurfaceRef.value?.getView()
  const comments = view ? getCommentsFromState(view.state) : commentManager.comments
  const active = comments.find(c => c.id === commentId) || comments[0]
  const path = currentFile.value?.path || ''
  const line = view && active ? view.state.doc.lineAt(Math.min(active.contentFrom, view.state.doc.length)).number : null
  return buildCommentsPrompt({ comments, filePath: path, focusId: commentId, focusLine: line })
}

async function onInlineCommentAction({ type, id, text, replyId }) {
  if (!type || !id) return { ok: false, error: 'Missing comment action.' }
  const trimmed = (text || '').trim()

  if (type === 'save-text') {
    if (!trimmed) return { ok: false, error: 'Write a comment before saving.' }
    return commentMutations.updateText?.(id, trimmed) || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'reply') {
    if (!trimmed) return { ok: false, error: 'Write a reply before saving.' }
    return commentMutations.addReply?.(id, trimmed) || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'update-reply') {
    if (!replyId) return { ok: false, error: 'Missing reply id.' }
    if (!trimmed) return { ok: false, error: 'A reply cannot be empty.' }
    return commentMutations.updateReply?.(id, replyId, trimmed)
      || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'delete-reply') {
    if (!replyId) return { ok: false, error: 'Missing reply id.' }
    return commentMutations.deleteReply?.(id, replyId)
      || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'delete') {
    return commentMutations.delete?.(id) || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'resolve') {
    const result = commentMutations.resolve?.(id) || { ok: false, error: 'Comment mutation unavailable.' }
    if (result.ok !== false) commentPresentation.hideResolvedComments()
    return result
  }

  if (type === 'reopen') {
    return commentMutations.reopen?.(id) || { ok: false, error: 'Comment mutation unavailable.' }
  }

  if (type === 'strip-all') {
    if (window.confirm('Remove all inline comments from this file?')) {
      return commentMutations.clearAll?.() || { ok: false, error: 'Comment mutation unavailable.' }
    }
    return { ok: true, cancelled: true }
  }

  if (type === 'copy-prompt') {
    try {
      if (!navigator.clipboard?.writeText) {
        return { ok: false, error: 'Clipboard access is unavailable.' }
      }
      await navigator.clipboard.writeText(commentPrompt(id))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not copy prompt.' }
    }
  }

  if (type === 'terminal-prompt') {
    if (!window.__mimir_activityPaste) return { ok: false, error: 'Terminal Activity not available.' }
    const ok = await window.__mimir_activityPaste(commentPrompt(id))
    if (!ok) return { ok: false, error: 'No active terminal. Open a terminal tab first.' }
    return { ok: true }
  }

  return { ok: false, error: `Unknown comment action: ${type}` }
}

function onScrollToLine(lineNumber) {
  if (!editorSurfaceRef.value) return
  const content = currentEditorContent()
  const lines = content.split('\n')
  let pos = 0
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    pos += lines[i].length + 1
  }
  editorSurfaceRef.value.scrollToPos(pos)
}

function buildSelectionContext(sel) {
  const doc = editorSurfaceRef.value?.getContent?.() || ''
  return {
    ...sel,
    coords: sel.coords || editorSurfaceRef.value?.coordsAtPos(sel.to) || null,
    contextBefore: doc.slice(Math.max(0, sel.from - 3000), sel.from),
    contextAfter: doc.slice(sel.to, Math.min(doc.length, sel.to + 1000)),
  }
}

function getDocumentForInlineAI() {
  const content = editorSurfaceRef.value?.getContent?.() || ''
  const path = currentFile.value?.path || null
  const title = path ? basename(path) : 'Untitled'
  return { content, path, title, documentId: documentIdFromPath(path) }
}

function openInlineAI(sel) {
  if (diffStore.active && diffStore.reviewMeta?.type === 'inline-ai') {
    diffStore.deactivate()
  }
  inlineAIState.value = buildSelectionContext(sel)
  inlineAIKey.value++
}

function onAskAgent() {
  const sel = editorSurfaceRef.value?.getSelection()
  if (!sel) return
  openInlineAI(sel)
}

function onSelectionCommand(sel) {
  if (sel.force) {
    openInlineAI(sel)
  }
}

function onRewriteSelection() {
  const sel = editorSurfaceRef.value?.getSelection()
  if (!sel) return
  openInlineAI(sel)
}

function onInlineAIApply(replacement, from, to) {
  if (diffStore.active) diffStore.deactivate()
  editorSurfaceRef.value?.replaceRange(from, to, replacement)
  inlineAIState.value = null
}

function onInlineAIActivateDiff({ replacement, from, to }) {
  const content = editorSurfaceRef.value?.getContent?.() || ''
  const modified = content.slice(0, from) + replacement + content.slice(to)
  activateDiffForCurrentFile(content, modified, { review: { type: 'inline-ai' } })
}

function onInlineAIDeactivateDiff() {
  if (diffStore.active && diffStore.reviewMeta?.type === 'inline-ai') {
    diffStore.deactivate()
  }
}

function closeInlineAI() {
  if (diffStore.active && diffStore.reviewMeta?.type === 'inline-ai') {
    diffStore.deactivate()
  }
  inlineAIState.value = null
}

async function acceptDiffAndFocus() {
  await onDiffAcceptAll()
  restoreEditorFocus()
}

async function rejectDiffAndFocus() {
  await onDiffRejectAll()
  restoreEditorFocus()
}

const editorCommands = useEditorCommandApi({
  fileManager,
  currentFile,
  openFiles,
  visibleOpenFiles,
  activeFileIndex,
  activeVisibleFileIndex,
  editorTabs,
  editorSurfaceRef,
  editorShellRef,
  commentMutations,
  flushEditorContent,
  emitNavigate: payload => emit('navigateEditor', payload),
  restoreEditorFocus,
  activateDiff: (...args) => activateDiffForCurrentFile(...args),
  saveCurrentFile,
  dismissEditorSurface,
  closeEditorTab,
  openSettings,
  commentPrompt,
  onNavigateIntent: () => { graphOpenGeneration += 1 },
})
const {
  mimirActive,
  mimirCloseActiveTab,
  mimirCommentAction,
  mimirComments,
  mimirCycleTab,
  mimirOpen: mimirOpenCommand,
  mimirOpenSettings,
  mimirOwnsFocus,
  mimirReplaceSelection,
  mimirReveal,
  mimirReviewProposal,
  mimirSave,
  mimirSelection,
  mimirSetContent,
  mimirState,
  mimirTabs,
} = editorCommands

async function setGraphView(view) {
  const file = currentFile.value
  if (!file?.graph || graphViewBusy.value) return
  if (visibleDiffActive.value || file.reviewPending) { graphViewError.value = 'Finish the review before changing the entry view.'; return }
  graphViewBusy.value = true
  autoSave.clear(file)
  graphViewError.value = ''
  try {
    flushEditorContent({ bridge: 'flush' })
    await fileManager.setGraphView(file, view)
    inlineAIState.value = null
    selectionText.value = ''
    await nextTick()
    restoreEditorFocus()
  } catch (cause) { graphViewError.value = String(cause?.message || cause) }
  finally { graphViewBusy.value = false }
}

async function mimirOpenGraph(request) {
  const generation = ++graphOpenGeneration
  const isCurrent = () => generation === graphOpenGeneration && !editorDisposed
  const target = typeof request === 'string' ? { id: request } : request
  if (!target?.id) throw new Error('An entry id is required.')
  flushEditorContent({ bridge: 'flush' })
  // Native summaries identify their mounted scope. Graph sources are flat
  // graph/{id}.md files; this is only a hint until graph_source validates it.
  const summary = graph.nodes.find(node => node.id === target.id)
    || graph.searchResults.find(node => node.id === target.id)
  const scope = graph.scopes.find(scope => scope.id === (summary?.scopeId || summary?.provenance?.scopeId))
  const scopedPath = scope?.root ? `${scope.root.replace(/\/$/, '')}/graph/${target.id}.md` : null
  const sourcePath = summary?.sourcePath || summary?.provenance?.sourcePath
  const hintedPath = sourcePath ? (sourcePath === scopedPath ? sourcePath : null) : scopedPath
  const options = { preview: target.preview !== false, isCurrent }
  const openPath = async path => {
    // Open tabs already own their exact source snapshot and draft. Reopening
    // one must neither read the source again nor wait for a pending save.
    const existing = openFiles.value.find(file => file.path === path && file.graph?.node?.id === target.id && !file.graph.unavailable)
    const document = existing
      ? { node: existing.graph.node, content: existing.content, sourceRevision: existing.graph.sourceRevision, bodyFrom: existing.graph.bodyFrom }
      : await graphSource(path)
    if (!isCurrent() || !document?.node || document.node.id !== target.id) return null
    return fileManager.openGraphDocument(document, options)
  }
  let hintError = null
  let file = hintedPath ? await openPath(hintedPath).catch(error => { hintError = error; return null }) : null
  if (!isCurrent()) return null
  try {
    if (!file) {
      const node = await getGraphNode(target.id)
      if (!isCurrent()) return null
      const path = node?.provenance?.sourcePath
      if (!path || path === hintedPath) throw hintError || new Error('This entry is unavailable.')
      file = await openPath(path)
      if (isCurrent() && !file) throw new Error('This entry is unavailable.')
    }
  } catch (error) {
    if (!isCurrent()) return null
    throw error
  }
  if (!file || !isCurrent()) return null
  gitReviewTabActive.value = false
  reviewTabActive.value = false
  inlineAIState.value = null
  selectionText.value = ''
  graphViewError.value = ''
  emit('navigateEditor', { path: file.path })
  await nextTick()
  if (!isCurrent() || currentFile.value !== file) return null
  if (target.targetId) {
    if (file.kind === 'graph') graphEditorTabRef.value?.revealReference(target)
    else {
      const view = editorSurfaceRef.value?.getView?.()
      if (view) {
        const bodyFrom = graphSourceBodyStart(view.state)
        const selection = referenceSelection(view.state, target, file.dirty ? '' : file.graph.sourceRevision, { bodyFrom, sourceBody: file.content.slice(file.graph.bodyFrom) })
        view.dispatch({ selection, scrollIntoView: true })
      }
    }
  } else restoreEditorFocus()
  return file
}

async function closeGraphDetails() {
  const file = currentFile.value
  if (file?.kind !== 'graph' || graphClosePending) return false
  graphClosePending = true
  try {
    const closed = await closeEditorTab(displayActiveTab.value)
    if (!closed || openFiles.value.includes(file)) return false
    await nextTick()
    emit('focusGraph', { id: file.graph?.node?.id || file.graph?.nodeId })
    return true
  } finally {
    graphClosePending = false
  }
}

async function undoGraphDelete() {
  try {
    const restored = await graph.undoDelete()
    if (restored) await mimirOpenGraph({ id: restored.id, preview: false })
  } catch (cause) { showDiagnosticError(cause) }
}

async function mimirOpen(...args) {
  gitReviewTabActive.value = false
  return mimirOpenCommand(...args)
}

function showDiagnosticError(cause) { emit('diagnostic', String(cause)) }
const scratchpadEditor = useScratchpadEditor({
  fileManager, currentFile, flush: flushEditorContent, sync: syncOpenFileSnapshot,
  open: mimirOpen, save: saveCurrentFile, ownsFocus: mimirOwnsFocus,
  reviewing: () => visibleDiffActive.value || gitReviewVisible.value,
  reveal: payload => emit('scratchpadReveal', payload), reportError: showDiagnosticError,
})
const { active: scratchpadActive, selected: scratchpadSelected, changes: scratchpadChanges,
  pending: scratchpadPending, conflict: scratchpadConflict, busy: scratchpadBusy } = scratchpadEditor
const scratchpadHistoryVisible = computed(() => scratchpadActive.value && Boolean(scratchpadSelected.value || scratchpadChanges.value))
const scratchpadBefore = computed(() => {
  const history = scratchpadEditor.store.history
  const index = scratchpadSelected.value ? history.findIndex(s => s.time === scratchpadSelected.value.time) : history.length - 1
  return history[index - 1]?.content || ''
})

async function mimirReviewGit(request = {}) {
  flushEditorContent({ bridge: 'flush' })
  inlineAIState.value = null
  reviewTabActive.value = false
  gitReviewTabActive.value = true
  gitReviewManaged.value = Boolean(request.managed)
  return gitReview.reviewFile(request.file, {
    workspacePath: request.workspacePath || props.workspacePath,
    scope: request.scope || gitReview.scope,
  })
}

async function mimirReviewHistory(request = {}) {
  const path = String(request.path || '').trim()
  const hash = String(request.hash || '').trim()
  if (!path || !hash) throw new Error('A file and history version are required.')
  await mimirOpen(path, { preview: false, source: true })
  flushEditorContent({ bridge: 'flush' })
  if (currentFile.value?.dirty) {
    throw new Error('Save or discard the current edits before opening History.')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const version = await invoke('git_file_version', { path, hash })
  if (version?.binary || typeof version?.content !== 'string') {
    throw new Error('This file version does not have a text diff.')
  }
  const current = currentFile.value?.content || ''
  activateDiffForCurrentFile(version.content, current, {
    review: {
      type: 'history',
      label: request.label || 'Saved version',
      hash: request.shortHash || hash.slice(0, 8),
      timestamp: request.timestamp || '',
      path,
    },
  })
}

async function onGitReviewOpenFile() {
  const path = gitReviewPath.value
  if (!path || gitReview.review?.status === 'deleted') return
  gitReviewTabActive.value = false
  await mimirOpen(path, { preview: false })
  emit('navigateEditor', { path })
}

function onGitReviewAskAgent(presetId) {
  const review = gitReview.review
  if (!review?.path || !presetId) return
  emit('reviewGitWithAgent', {
    workspacePath: gitReview.workspacePath,
    path: review.path,
    status: review.status,
    scope: review.scope,
    presetId,
  })
}

function closeGitReview() {
  gitReview.deactivate()
  gitReviewTabActive.value = false
  gitReviewManaged.value = false
  restoreEditorFocus()
}

watch(() => gitReview.active, (active) => {
  if (!active) gitReviewTabActive.value = false
})

const navigationTabs = computed(() => displayTabs.value.map(tab => ({
  id: tab.id, name: tab.name, type: tab.type,
  path: visibleOpenFiles.value.find(file => file.id === tab.id)?.path || null,
})))
const activeNavigationTab = computed(() => displayTabs.value[displayActiveTab.value]?.id || '')
function selectNavigationTab(id) {
  const index = displayTabs.value.findIndex(tab => tab.id === id)
  if (index < 0) return false
  selectEditorTab(index)
  emit('navigateEditor')
  // Review and New Tab surfaces may have no document input to focus.
  void nextTick(() => {
    const shell = editorShellRef.value
    if (!shell?.contains(document.activeElement)) {
      shell?.querySelector('[data-editor-tabs-region] [role="tab"][aria-selected="true"]')?.focus()
    }
  })
  return true
}

function focusEditorPane() {
  editorShellRef.value?.querySelector('[data-editor-tabs-region] [role="tab"][aria-selected="true"]')?.focus()
  restoreEditorFocus()
}

defineExpose({
  mimirFocus: focusEditorPane,
  navigationTabs, activeNavigationTab, selectNavigationTab,
  mimirScratchpad: scratchpadEditor.show,
  mimirOpen,
  mimirOpenGraph,
  mimirReviewGit,
  mimirReviewHistory,
  mimirState,
  mimirActive,
  mimirTabs,
  mimirSelection,
  mimirComments,
  mimirCommentAction,
  mimirReplaceSelection,
  mimirSetContent,
  mimirReviewProposal,
  mimirReveal,
  mimirSave,
  mimirNewFile: createBlankFile,
  mimirOwnsFocus,
  mimirCycleTab,
  mimirCloseActiveTab,
  mimirHasOpenTabs: () => displayTabs.value.length > 0,
  mimirPrepareWorkspaceSwitch: prepareWorkspaceSwitch,
  mimirOpenSettings,
})

// --- Diff review ---

const diffReview = useDiffReview({
  diffStore,
  fileManager,
  currentFile,
  reviewTabActive,
  inlineAIState,
  restoreConfirmMeta,
  diffViewRef,
  batchDiffViewRef,
  scheduleContentSync,
  flushEditorContent,
})
const { onDiffAcceptAll, onDiffRejectAll, onDiffChunksResolved, onDiffNavigateChunk, onDiffNavigateFile, onRestoreConfirm, activateDiffForCurrentFile, activateBatchDiff, onBatchAllResolved } = diffReview

// --- Keyboard shortcuts ---

useKeyboardShortcuts({
  embedded: props.embedded,
  onFormat,
  onSave,
  onSaveAs,
  onOpenDialog,
  onNewFile: createBlankFile,
  onNewTab: openNewTabPage,
  onCloseTab: closeActiveEditorTab,
  onRewriteSelection,
  editorHasFocus: () => Boolean(editorShellRef.value?.contains(document.activeElement)),
})

function onEditorKeydown(event) {
  if (event.key === 'Escape' && gitReviewVisible.value) {
    event.preventDefault()
    closeGitReview()
    return
  }
  if (event.key === 'Escape' && visibleDiffActive.value) {
    event.preventDefault()
    void rejectDiffAndFocus().catch((error) => {
      diffStore.setReviewError(error?.message || error)
    })
    return
  }
  if (
    visibleDiffActive.value
    && event.key === 'Enter'
    && (event.metaKey || event.ctrlKey)
  ) {
    event.preventDefault()
    void acceptDiffAndFocus().catch((error) => {
      diffStore.setReviewError(error?.message || error)
    })
    return
  }
  if (visibleDiffActive.value && diffStore.viewMode === 'diff') {
    if (event.key === '[' || (event.key === 'ArrowUp' && event.altKey)) {
      event.preventDefault()
      diffStore.prevChunk()
      diffViewRef.value?.scrollToChunk(diffStore.currentChunk)
    }
    if (event.key === ']' || (event.key === 'ArrowDown' && event.altKey)) {
      event.preventDefault()
      diffStore.nextChunk()
      diffViewRef.value?.scrollToChunk(diffStore.currentChunk)
    }
  }
}

// --- Lifecycle ---

onMounted(async () => {
  editorDisposed = false
  editorSession.beginMount()
  window.addEventListener('beforeunload', editorSession.beforeUnload)
  document.addEventListener('keydown', onEditorKeydown)
  void windowCloseGuard.setup().catch(reportSessionError)

  await scratchpadEditor.start()
  if (editorDisposed) return
  await editorSession.hydrate()
  scratchpadEditor.reconcile()

  // An async onMounted callback is not canceled by Vue. If this component was
  // replaced during hydration, the replacement owns persistence and native
  // listeners; this stale instance must not install them after unmount.
  if (editorDisposed) return

  // Persist session state reactively (debounced on any change)
  editorSession.startPersistence()

  await nativeFileOpen.setup()
  if (editorDisposed) return
  syncOpenFileSnapshot()
  await externalFileSync.start()
  if (editorDisposed) return
  await nativeLifecycle.start()
  if (editorDisposed) return

  // Re-offer a pending proposal that survived an application restart for the
  // restored active document. Later tab activations go through the watcher.
  void proposalLifecycle.checkProposalsForFile(currentFile.value)

  // Dev: expose diff activation for console testing
  if (import.meta.env.DEV) {
    const sampleDiff = () => {
      const orig = '# My Document\n\nThis is the first paragraph of my document. It contains some important information.\n\n## Section One\n\nHere is some content in section one. This section discusses the main topic.\n\n## Section Two\n\nThis section has additional details. The conclusion follows below.\n\n## Conclusion\n\nIn summary, this document covers the key points.'
      const mod = '# My Document (Revised)\n\nThis is the first paragraph of my document. It contains some important information that has been carefully reviewed.\n\n## Section One\n\nHere is some content in section one. This section discusses the main topic with additional context and references.\n\n## New Section\n\nThis entirely new section was added to provide more depth on the subject matter.\n\n## Section Two\n\nThis section has additional details and expanded analysis. The conclusion follows below.\n\n## Conclusion\n\nIn summary, this document covers the key points and provides a comprehensive overview.'
      activateDiffForCurrentFile(orig, mod)
    }
    window.__activateDiff = sampleDiff
    if (new URLSearchParams(location.search).has('testdiff')) {
      setTimeout(sampleDiff, 500)
    }
  }
})

onUnmounted(() => {
  editorDisposed = true
  // Synchronize the latest CodeMirror transaction before canceling its
  // debounce and before any replacement HMR instance reads the shared store.
  flushEditorContent({ bridge: 'unmount' })
  window.removeEventListener('beforeunload', editorSession.beforeUnload)
  document.removeEventListener('keydown', onEditorKeydown)
  windowCloseGuard.dispose()
  autoSave.clear()
  clearTimeout(documentStatsTimer)
  contentSync.dispose()
  externalFileSync.dispose()
  scratchpadEditor.dispose()
  nativeLifecycle.dispose()
  proposalLifecycle.dispose()
  saveFeedback.dispose()
  releaseEditorSettingsSync?.()
  releaseUpdateRestartGuard()
  editorSession.dispose()
  documentBridge.dispose()
})

function normalizeComparablePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/\/+$/, '')
}
</script>

<style scoped>
.graph-source-header { display: flex; justify-content: space-between; flex-shrink: 0; }
.graph-source-kind { margin-inline: 10px; color: var(--color-ink-4); font-size: 10px; text-transform: capitalize; }
.graph-source-help { border-bottom: 1px solid var(--color-rule-light); padding: 9px 14px; color: var(--color-ink-3); font-size: 11px; }
.graph-delete-notice { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--color-rule-light); padding: 8px 14px; color: var(--color-ink-3); font-size: 11px; }
.graph-delete-notice span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-delete-notice button { flex-shrink: 0; color: var(--color-accent); font-weight: 600; }

.editor-body {
  position: relative;
  overflow: hidden;
}

.editor-panes {
  min-width: 0;
}

.close-confirm-card {
  width: 380px;
  background: var(--color-surface);
  border: 1px solid var(--color-rule);
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
}

.close-confirm-title {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink);
  margin: 0 0 4px;
}

.close-confirm-body {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-2);
  margin: 0 0 20px;
  line-height: 1.5;
}

.close-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.close-confirm-btn {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 6px;
}
.close-confirm-btn:hover { opacity: 0.85; }
.close-confirm-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

.btn-cancel {
  background: none;
  border: 1px solid var(--color-rule);
  color: var(--color-ink-2);
}

.btn-discard {
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  border: 1px solid var(--color-rule);
}

.btn-save {
  background: var(--color-accent);
  color: var(--color-accent-ink, #fff);
  border: none;
}

.btn-remove {
  background: var(--color-rem);
  color: var(--color-accent-ink, #fff);
  border: none;
}

.discard-confirm-error {
  margin: -12px 0 16px;
  color: var(--color-rem);
  font-family: var(--font-sans);
  font-size: 11px;
  line-height: 1.4;
}
</style>
