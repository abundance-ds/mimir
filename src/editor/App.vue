<template>
  <div
    ref="editorShellRef"
    class="editor-shell h-full w-full flex flex-col bg-surface overflow-hidden"
  >
    <AppHeader
      :embedded="embedded"
      :showAppMenus="showAppMenus"
      :recentFiles="fileManager.recentFiles"
      :canSave="Boolean(currentFile) && currentFile?.kind !== 'pdf' && currentFile?.kind !== 'external'"
      :hasSelection="Boolean(selectionText)"
      :tabs="displayTabs"
      :activeTab="displayActiveTab"
      :arrivedTabIndex="arrivedTabIndex"
      :hideSidebar="hideSidebar"
      @new-file="createBlankFile"
      @open-file="onOpenDialog"
      @save="onSave"
      @save-as="onSaveAs"
      @close-file="() => closeEditorTab(activeFileIndex)"
      @open-recent="onOpenRecent"
      @clear-recent="onClearRecent"
      @edit-command="onEditCommand"
      @rewrite-selection="onRewriteSelection"
      @select-tab="selectEditorTab"
      @close-tab="closeEditorTab"
      @add-tab="openNewTabPage"
      @reorder-tab="onReorderTab"
    />

    <div class="editor-body flex-1 flex min-h-0 bg-chrome">
      <div class="editor-workspace flex-1 flex flex-col min-w-0">
        <InlineAI
          v-if="inlineAIState && !isResourcePreview"
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
          v-else-if="diffStore.active && (!diffStore.isBatch || reviewTabActive || diffStore.isBatchFileFocused)"
          @accept-all="acceptDiffAndFocus"
          @reject-all="rejectDiffAndFocus"
          @navigate-chunk="onDiffNavigateChunk"
          @navigate-file="onDiffNavigateFile"
        />
        <EditorToolbar
          v-if="editorToolbarVisible"
          :active-formats="activeFormats"
          :has-selection="Boolean(selectionText)"
          :comment-count="commentManager.comments.length"
          @format="onFormat"
          @comment="onComment"
        />
        <div class="editor-panes flex-1 flex min-h-0 overflow-hidden">
          <BatchDiffView
            v-if="diffStore.active && diffStore.isBatch && reviewTabActive"
            ref="batchDiffViewRef"
            @all-resolved="onBatchAllResolved"
          />
          <DiffView
            v-else-if="diffStore.active && (!diffStore.isBatch || diffStore.isBatchFileFocused)"
            ref="diffViewRef"
            @accept="onDiffChunksResolved"
          />
          <FilePreviewPage
            v-if="isResourcePreview && !diffStore.active"
            :file="currentFile"
          />
          <NewTabPage
            v-else-if="isNewTabPage && !diffStore.active"
            @activated="restoreEditorFocus"
          />
          <EditorSurface
            ref="editorSurfaceRef"
            v-show="!isResourcePreview && !isNewTabPage && (!diffStore.active || (diffStore.isBatch && !reviewTabActive && !diffStore.isBatchFileFocused))"
            :content="currentFile?.content ?? ''"
            :path="currentFile?.path ?? ''"
            :zoomLevel="state.zoomLevel"
            :maxWidth="editorContentMaxWidth"
            :showBorder="false"
            :extensions="editorExtensions"
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
          v-if="!isResourcePreview"
          :zoomLevel="state.zoomLevel"
          :selectionText="selectionText"
          :stats="documentStats"
          :saveStatus="footerSave"
          @zoom-in="zoomIn"
          @zoom-out="zoomOut"
          @set-zoom="setZoomLevel"
          @save-status-click="onSaveStatusClick"
        />
      </div>

    </div>

    <SettingsDialog
      :open="state.settingsOpen"
      :initial-section="settingsInitialSection"
      @close="closeSettings"
      @launch-app="onSettingsAppLaunch"
      @open-definition="onSettingsOpenDefinition"
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
import { useFileStore } from '../stores/files.js'
import { useSettingsStore } from '../stores/settings.js'
import { useDocumentBridge } from './composables/useDocumentBridge.js'
import { isTauriRuntime, platformKind } from '../shared/platform.js'
import { relativeTime } from '../shared/time.js'
import { basename, parentPath } from '../shared/utils/path.js'
import { readFile } from '../services/fileSystem.js'
import { createWindowCloseGuard } from './windowCloseGuard.js'
import { ghostExtension } from './codemirror/ghost.js'
import { livePreviewExtension } from './codemirror/livePreview.js'
import { taskCheckboxExtension } from './codemirror/taskCheckboxes.js'
import { commentsExtension, setActiveComment as setActiveCommentEffect, getCommentsFromState, commentMutation } from './codemirror/comments.js'
import { escapeAttr } from '../services/comments/parser.js'
import { buildCommentsPrompt } from '../services/comments/prompt.js'
import { EditorView } from '@codemirror/view'
import { useCommentsStore } from '../stores/comments.js'
import { useEditorProposalLifecycle } from './composables/useEditorProposalLifecycle.js'
import { useEditorNativeLifecycle } from './composables/useEditorNativeLifecycle.js'
import { useEditorSessionLifecycle } from './composables/useEditorSessionLifecycle.js'
import { useEditorCommandApi } from './composables/useEditorCommandApi.js'
import { useFileOpen } from './composables/useFileOpen.js'
import { useContentSync } from './composables/useContentSync.js'
import { useExternalFileSync } from './composables/useExternalFileSync.js'
import { useCommentMutations } from './composables/useCommentMutations.js'
import { useDiffReview } from './composables/useDiffReview.js'
import { useTabManagement } from './composables/useTabManagement.js'
import { requestGhostSuggestions } from '../services/ai/ghost.js'
import { documentIdFromPath } from '../services/ai/context.js'
import { createAutoSaveController } from './autoSaveController.js'
import { fileDisplayName, footerSaveStatus, tabFromFile } from './saveStatus.js'
import { useSaveFeedbackStore } from '../stores/saveFeedback.js'

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
import { useDiffStore } from '../stores/diff.js'

const props = defineProps({
  hideSidebar: { type: Boolean, default: false },
  embedded: { type: Boolean, default: false },
})
const emit = defineEmits(['closeRequest', 'empty', 'launchApp', 'navigateEditor'])
const editorShellRef = ref(null)

const editorUI = useEditorUIStore()
const state = editorUI
const { zoomIn, zoomOut, setZoomLevel } = editorUI
const showAppMenus = platformKind() !== 'macos'

const editorSettings = useSettingsStore()
const releaseEditorSettingsSync = props.embedded
  ? null
  : editorSettings.startSync()

const fileManager = useFileStore()
const { currentFile, openFiles, activeFileIndex } = storeToRefs(fileManager)

const commentManager = useCommentsStore()
const diffStore = useDiffStore()
const diffViewRef = ref(null)
const batchDiffViewRef = ref(null)

const selectionText = ref('')
const cursorLine = ref(0)
const inlineAIState = ref(null)
const inlineAIKey = ref(0)
const editorSurfaceRef = ref(null)
const editorScrollInfo = ref({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
const editorGeometryVersion = ref(0)
const activeFormats = ref([])
const isNewTabPage = computed(() => currentFile.value?.newTab === true)
const isResourcePreview = computed(() => ['pdf', 'external'].includes(currentFile.value?.kind))
const editorToolbarVisible = computed(() => (
  editorSettings.editorToolbarMode !== 'none'
  && !isNewTabPage.value
  && !isResourcePreview.value
  && !diffStore.active
  && isMarkdownPath(currentFile.value?.path)
))
const inlineAIProjectPath = computed(() => parentPath(currentFile.value?.path))
const closeOverlayRef = ref(null)
const restoreConfirmMeta = ref(null)
const restoreOverlayRef = ref(null)
const commentGateVisible = ref(false)
const commentGateDontAsk = ref(false)
const commentGateOverlayRef = ref(null)
const editorModalOpen = computed(() => Boolean(
  state.settingsOpen
  || closeConfirmFile?.value
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
  normal: '80ch',
  wide: '100ch',
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
  return openFiles.value.map(file => tabFromFile(file, {
    autoSaveEnabled: editorSettings.editorAutoSave,
    untitledIndex: file.path ? 0 : ++untitledCount,
  }))
})

const reviewTabActive = ref(false)

const displayTabs = computed(() => {
  const fileTabs = editorTabs.value.map(t => ({ ...t, type: 'file' }))
  if (!diffStore.isBatch || !diffStore.active) return fileTabs
  const pending = diffStore.pendingFiles.length
  const total = diffStore.files.length
  return [
    ...fileTabs,
    {
      id: '__review__',
      name: `Review · ${pending > 0 ? pending : total}`,
      type: 'review',
      dirty: pending > 0,
      saveTone: 'clean',
    },
  ]
})

const displayActiveTab = computed(() => {
  if (reviewTabActive.value && diffStore.isBatch && diffStore.active) {
    return displayTabs.value.length - 1
  }
  return fileManager.activeFileIndex
})

const saveFeedback = useSaveFeedbackStore()
const feedbackMatchesCurrentFile = computed(() => (
  Boolean(currentFile.value?.id)
  && saveFeedback.fileId === currentFile.value.id
))
const footerSave = computed(() => footerSaveStatus({
  file: currentFile.value,
  autoSaveEnabled: editorSettings.editorAutoSave,
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
  activateDiff: (...args) => activateDiffForCurrentFile(...args),
  activateBatchDiff: (...args) => activateBatchDiff(...args),
})

const editorExtensions = computed(() => [
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
  ),
  ...taskCheckboxExtension(() => editorSettings.editorLivePreview && isMarkdownPath(currentFile.value?.path)),
])

// --- Content sync + save ---

const contentSync = useContentSync({
  editorSurfaceRef,
  currentFile,
  fileManager,
  documentBridge,
})
const { currentEditorContent, flushEditorContent, scheduleContentSync, syncOpenFileSnapshot } = contentSync

const externalFileSync = useExternalFileSync({
  fileManager,
  readFile,
  onReloaded: (file) => {
    if (fileManager.currentFile !== file) return
    if (diffStore.active) diffStore.deactivate()
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
  isAutoSaveEnabled: () => editorSettings.editorAutoSave,
  onError: () => {},
})

function onContentChange() {
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
  displayTabs,
  reviewTabActive,
  inlineAIState,
  activeFileIndex,
  flushEditorContent,
  saveCurrentFile,
  requestWindowClose: requestEditorWindowClose,
  embedded: props.embedded,
  onEmpty: () => emit('empty'),
})
const {
  closeConfirmFile,
  closeConfirmFileName,
  arrivedTabIndex,
  onSelectTab,
  onCloseTab,
  onCloseConfirm,
  onNewFile,
  onReorderTab,
  confirmFileClose,
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
  flushSession: editorSession.flush,
})

async function requestEditorWindowClose(options) {
  const guarded = await windowCloseGuard.requestClose(options)
  if (guarded !== null) return guarded
  window.close()
  return true
}

async function closeEditorTab(index) {
  if (await dismissEditorSurface()) return false
  const closed = await onCloseTab(index)
  if (closed) {
    await editorSession.flush().catch(reportSessionError)
  }
  if (openFiles.value.length) restoreEditorFocus()
  return closed
}

function restoreEditorFocus() {
  void nextTick(() => editorSurfaceRef.value?.focus?.())
}

function selectEditorTab(index) {
  const tab = displayTabs.value[index]
  onSelectTab(index)
  if (tab?.type !== 'review') restoreEditorFocus()
}

function createBlankFile() {
  onNewFile()
  restoreEditorFocus()
}

function openNewTabPage() {
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
  if (diffStore.active) {
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

function focusModal(container) {
  if (!container) return
  if (!modalReturnFocus || !modalReturnFocus.isConnected) {
    modalReturnFocus = document.activeElement
  }
  nextTick(() => {
    const target = container.querySelector('[data-modal-initial], button:not(:disabled), input:not(:disabled)')
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
    const content = await readFile(path)
    await fileManager.openFile(path, content)
  } catch {
    fileManager.removeRecentFile(path)
  }
}

function onClearRecent() {
  fileManager.setRecentFiles([])
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

function openSettings(section = 'appearance') {
  settingsInitialSection.value = section
  state.settingsOpen = true
}

function closeSettings() {
  state.settingsOpen = false
  settingsInitialSection.value = 'appearance'
}

function onSettingsAppLaunch(payload) {
  closeSettings()
  emit('launchApp', payload)
}

async function onSettingsOpenDefinition(path) {
  closeSettings()
  if (path) await mimOpen(path)
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

function nativeMenuActions() {
  return {
    newFile: createBlankFile,
    openFile: onOpenDialog,
    openRecent: onOpenRecent,
    clearRecent: onClearRecent,
    save: onSave,
    saveAs: onSaveAs,
    closeTab: props.embedded
      ? requestEmbeddedClose
      : () => closeEditorTab(activeFileIndex.value),
    quit: requestAppQuit,
    editCommand: onEditCommand,
    rewriteSelection: onRewriteSelection,
    openSettings,
  }
}

// --- Comments: Active comment sync (Vue→CM6) ---
watch(() => commentManager.activeCommentId, (id) => {
  const v = editorSurfaceRef.value?.getView()
  if (!v) return
  v.dispatch({ effects: setActiveCommentEffect.of(id) })
})

watch(() => editorSettings.aiInlineRewrite, (enabled) => {
  if (!enabled && inlineAIState.value) closeInlineAI()
})

// --- Toolbar actions ---

function onFormat(action) {
  editorSurfaceRef.value?.format(action)
}

function onEditCommand(action) {
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

  const existing = commentManager.findActiveByRange(sel.from, sel.to)
  if (existing) {
    commentManager.setActiveComment(existing.id)
    return
  }

  const currentComments = getCommentsFromState(view.state)
  for (const c of currentComments) {
    if (Math.max(sel.from, c.contentFrom) < Math.min(sel.to, c.contentTo)) return
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
      { from: sel.from, insert: openTag },
      { from: sel.to, insert: '</comment>' },
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
    return commentMutations.resolve?.(id) || { ok: false, error: 'Comment mutation unavailable.' }
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
    if (!window.__mim_activityPaste) return { ok: false, error: 'Terminal Activity not available.' }
    const ok = await window.__mim_activityPaste(commentPrompt(id))
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
  activeFileIndex,
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
})
const {
  mimActive,
  mimCloseActiveTab,
  mimCommentAction,
  mimComments,
  mimCycleTab,
  mimOpen,
  mimOpenSettings,
  mimOwnsFocus,
  mimReplaceSelection,
  mimReveal,
  mimReviewProposal,
  mimSave,
  mimSelection,
  mimSetContent,
  mimState,
  mimTabs,
} = editorCommands

defineExpose({
  mimOpen,
  mimState,
  mimActive,
  mimTabs,
  mimSelection,
  mimComments,
  mimCommentAction,
  mimReplaceSelection,
  mimSetContent,
  mimReviewProposal,
  mimReveal,
  mimSave,
  mimOwnsFocus,
  mimCycleTab,
  mimCloseActiveTab,
  mimOpenSettings,
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
  onFormat,
  onSave,
  onSaveAs,
  onOpenDialog,
  onNewFile: createBlankFile,
  onNewTab: openNewTabPage,
  onCloseTab: () => closeEditorTab(activeFileIndex.value),
  onRewriteSelection,
  editorHasFocus: () => Boolean(editorSurfaceRef.value?.hasFocus?.()),
})

function onEditorKeydown(event) {
  if (event.key === 'Escape' && diffStore.active) {
    event.preventDefault()
    void rejectDiffAndFocus().catch((error) => {
      diffStore.setReviewError(error?.message || error)
    })
    return
  }
  if (
    diffStore.active
    && event.key === 'Enter'
    && (event.metaKey || event.ctrlKey)
  ) {
    event.preventDefault()
    void acceptDiffAndFocus().catch((error) => {
      diffStore.setReviewError(error?.message || error)
    })
    return
  }
  if (diffStore.active && diffStore.viewMode === 'diff') {
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

  await editorSession.hydrate()

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
  nativeLifecycle.dispose()
  proposalLifecycle.dispose()
  saveFeedback.dispose()
  releaseEditorSettingsSync?.()
  editorSession.dispose()
  documentBridge.dispose()
})
</script>

<style scoped>
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
</style>
