<template>
  <div
    class="editor-shell h-full w-full flex flex-col bg-surface overflow-hidden"
  >
    <AppHeader
      :embedded="embedded"
      :showAppMenus="showAppMenus"
      :recentFiles="fileManager.recentFiles"
      :canSave="Boolean(currentFile?.path)"
      :hasSelection="Boolean(selectionText)"
      :tabs="displayTabs"
      :activeTab="displayActiveTab"
      :arrivedTabIndex="arrivedTabIndex"
      :hideSidebar="hideSidebar"
      @new-file="onNewFile"
      @open-file="onOpenDialog"
      @save="onSave"
      @save-as="onSaveAs"
      @close-file="() => onCloseTab(activeFileIndex)"
      @open-recent="onOpenRecent"
      @clear-recent="onClearRecent"
      @edit-command="onEditCommand"
      @rewrite-selection="onRewriteSelection"
      @select-tab="onSelectTab"
      @close-tab="onCloseTab"
      @add-tab="onNewFile"
      @reorder-tab="onReorderTab"
    />

    <div class="editor-body flex-1 flex min-h-0 bg-chrome">
      <div class="editor-workspace flex-1 flex flex-col min-w-0">
        <InlineAI
          v-if="inlineAIState"
          :key="inlineAIKey"
          :selection="inlineAIState"
          :documentId="documentIdFromPath(currentFile?.path)"
          :getDocument="getDocumentForInlineAI"
          :projectPath="currentFile?.path ? currentFile.path.replace(/\/[^/]*$/, '') : null"
          @apply="onInlineAIApply"
          @activate-diff="onInlineAIActivateDiff"
          @deactivate-diff="onInlineAIDeactivateDiff"
          @close="closeInlineAI"
        />
        <DiffBar
          v-else-if="diffStore.active && (!diffStore.isBatch || reviewTabActive || diffStore.isBatchFileFocused)"
          @accept-all="onDiffAcceptAll"
          @reject-all="onDiffRejectAll"
          @navigate-chunk="onDiffNavigateChunk"
          @navigate-file="onDiffNavigateFile"
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
          <NewTabPage v-if="isNewTabPage && !diffStore.active" />
          <EditorSurface
            ref="editorSurfaceRef"
            v-show="!isNewTabPage && (!diffStore.active || (diffStore.isBatch && !reviewTabActive && !diffStore.isBatchFileFocused))"
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
    />


    <Teleport to="body">
      <Transition name="settings-fade">
        <div
          v-if="closeConfirmFile"
          ref="closeOverlayRef"
          tabindex="-1"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onCloseConfirm('cancel')"
          @keydown.escape="onCloseConfirm('cancel')"
        >
          <div class="close-confirm-card">
            <p class="close-confirm-title">Save changes?</p>
            <p class="close-confirm-body">
              "{{ closeConfirmFileName }}" has unsaved changes that will be lost if you close without saving.
            </p>
            <div class="close-confirm-actions">
              <button class="close-confirm-btn btn-cancel" @click="onCloseConfirm('cancel')">Cancel</button>
              <button class="close-confirm-btn btn-discard" @click="onCloseConfirm('discard')">Don't Save</button>
              <button class="close-confirm-btn btn-save" @click="onCloseConfirm('save')">Save</button>
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
          tabindex="-1"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onRestoreConfirm('cancel')"
          @keydown.escape="onRestoreConfirm('cancel')"
        >
          <div class="close-confirm-card">
            <p class="close-confirm-title">Restore this version?</p>
            <p class="close-confirm-body">
              Your document will revert to how it was {{ restoreTimeLabel }}. Use {{ modKey }}Z to undo.
            </p>
            <div class="close-confirm-actions">
              <button class="close-confirm-btn btn-cancel" @click="onRestoreConfirm('cancel')">Cancel</button>
              <button class="close-confirm-btn btn-save" @click="onRestoreConfirm('restore')">Restore</button>
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
          tabindex="-1"
          class="fixed inset-0 bg-black/30 z-[200] flex items-center justify-center outline-none"
          @click.self="onCommentGateConfirm(false)"
          @keydown.escape="onCommentGateConfirm(false)"
        >
          <div class="close-confirm-card">
            <p class="close-confirm-title">Comments modify your file</p>
            <p class="close-confirm-body">
              This will modify your document file. Comments may not display correctly in other applications. You can remove all comments at any time.
            </p>
            <label class="flex items-center gap-2 mb-4 font-sans text-[12px] text-ink-2">
              <input type="checkbox" v-model="commentGateDontAsk" class="accent-accent" />
              Don't show again
            </label>
            <div class="close-confirm-actions">
              <button class="close-confirm-btn btn-cancel" @click="onCommentGateConfirm(false)">Cancel</button>
              <button class="close-confirm-btn btn-save" @click="onCommentGateConfirm(true)">Add comment</button>
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
import { installNativeEditorMenu, shouldInstallNativeEditorMenu } from './nativeMenu.js'
import { platformKind } from '../shared/platform.js'
import { relativeTime } from '../shared/time.js'
import { readFile } from '../services/fileSystem.js'
import { loadSession, saveSession } from '../services/session.js'
import { createSessionPersist } from './sessionPersist.js'
import { ghostExtension } from './codemirror/ghost.js'
import { livePreviewExtension } from './codemirror/livePreview.js'
import { commentsExtension, setActiveComment as setActiveCommentEffect, getCommentsFromState, commentMutation } from './codemirror/comments.js'
import { escapeAttr } from '../services/comments/parser.js'
import { buildCommentsPrompt } from '../services/comments/prompt.js'
import { EditorView } from '@codemirror/view'
import { useCommentsStore } from '../stores/comments.js'
import { useProposalBridge, computeDiffFromReview, computeCompoundDiff } from './composables/useProposalBridge.js'
import { useFileOpen } from './composables/useFileOpen.js'
import { useContentSync } from './composables/useContentSync.js'
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
import InlineAI from './components/workspace/InlineAI.vue'
import DiffBar from './components/workspace/DiffBar.vue'
import DiffView from './components/workspace/DiffView.vue'
import BatchDiffView from './components/workspace/BatchDiffView.vue'
import NewTabPage from './components/workspace/NewTabPage.vue'
import { useDiffStore } from '../stores/diff.js'

const props = defineProps({
  hideSidebar: { type: Boolean, default: false },
  embedded: { type: Boolean, default: false },
})

const editorUI = useEditorUIStore()
const state = editorUI
const { zoomIn, zoomOut, setZoomLevel } = editorUI
const showAppMenus = platformKind() !== 'macos'

const editorSettings = useSettingsStore()

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
const closeOverlayRef = ref(null)
const restoreConfirmMeta = ref(null)
const restoreOverlayRef = ref(null)
const commentGateVisible = ref(false)
const commentGateDontAsk = ref(false)
const commentGateOverlayRef = ref(null)
let commentGateResolve = null

watch(restoreConfirmMeta, (v) => {
  if (v) nextTick(() => restoreOverlayRef.value?.focus())
})
watch(commentGateVisible, (v) => {
  if (v) nextTick(() => commentGateOverlayRef.value?.focus())
})
let sessionPersistCleanup = null

const documentBridge = useDocumentBridge()
useFileOpen()

const editorLineWidthMap = {
  normal: '80ch',
  wide: '100ch',
  off: '',
}

const documentStats = computed(() => {
  const text = currentFile.value?.content ?? ''
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  const characters = text.length
  const spaces = (text.match(/ /g) || []).length
  const lines = text ? text.split('\n').length : 0
  const readingMinutes = Math.max(1, Math.round(words / 230))
  return { words, characters, spaces, lines, readingMinutes }
})

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
const footerSave = computed(() => footerSaveStatus({
  file: currentFile.value,
  autoSaveEnabled: editorSettings.editorAutoSave,
  savingVisible: saveFeedback.savingVisible,
  savedVisible: saveFeedback.savedVisible,
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

const proposalWindowLabel = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('window') || ''
  : ''
let proposalRegisterTimer = null

function scheduleProposalEditorRegistration() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return
  clearTimeout(proposalRegisterTimer)
  proposalRegisterTimer = setTimeout(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('proposal_register_editor', {
        windowLabel: proposalWindowLabel,
        documents: openFiles.value.map((file, index) => ({
          path: file.path || '',
          dirty: Boolean(file.dirty),
          active: index === activeFileIndex.value,
        })),
      })
    } catch {}
  }, 50)
}

function unregisterProposalEditor() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('proposal_register_editor', {
      windowLabel: proposalWindowLabel,
      documents: [],
    }))
    .catch(() => {})
}

const proposalBridge = useProposalBridge({
  getDocContent: () => currentEditorContent(),
  applyChange: (from, to, text) => editorSurfaceRef.value?.replaceRange(from, to, text),
  getDocPath: () => currentFile.value?.path ?? '',
  activateDiff: (original, modified, opts) => activateDiffForCurrentFile(original, modified, opts),
  activateBatchDiff: (fileList, meta) => activateBatchDiff(fileList, meta),
  openFileForDiff: (path, content) => fileManager.openFile(path, content),
  stashFileReviews: (review) => fileManager.setFileReviews(currentFile.value, [review]),
})

// Listen for proposal changes from the panel (via Rust broadcast)
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen('mim://file-updated', (event) => {
      const { path, content } = event.payload || {}
      if (!path) return
      const file = fileManager.openFiles.find(f => f.path === path)
      if (!file) return
      file.content = content
      file.dirty = false
      fileManager.clearFileReviews(file)
      if (fileManager.currentFile === file && diffStore.active) {
        diffStore.deactivate()
      }
    })

    listen('mim://proposals-changed', (event) => {
      const proposals = event.payload || []
      const file = fileManager.currentFile
      if (!file?.path) return
      flushEditorContent()

      const matches = proposals.filter(p =>
        p.path === file.path || p.absolutePath === file.path
      )

      if (matches.length > 0 && !file.reviews) {
        const reviews = matches.map(m => ({
          proposalId: m.id,
          sessionId: m.threadId || m.sessionId || '',
          targetText: m.targetText || '',
          replacement: m.replacement || '',
          path: m.absolutePath || m.path,
          type: m.type || 'edit',
        }))
        fileManager.setFileReviews(file, reviews)
        activateDiffFromReviews(file)
      } else if (matches.length === 0 && file.reviews) {
        fileManager.clearFileReviews(file)
        diffStore.deactivate()
      }
    })
  })
}

function activateDiffFromReviews(file) {
  if (!file?.reviews?.length) return false
  if (fileManager.currentFile === file) flushEditorContent()
  const content = file.content || ''
  const diff = file.reviews.length === 1
    ? computeDiffFromReview(file.reviews[0], content)
    : computeCompoundDiff(file.reviews, content)
  if (diff) {
    const ids = file.reviews.map(r => r.proposalId)
    const r = file.reviews[0]
    diffStore.activate({ original: diff.original, modified: diff.modified, path: file.path || '', review: { ids, sessionId: r.sessionId, path: r.path } })
    return true
  }
  fileManager.clearFileReviews(file)
  return false
}

async function checkProposalsForFile(file) {
  if (!file?.path || file.reviews) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const proposals = await invoke('get_proposals_for_path', { path: file.path })
    if (proposals.length === 0) return
    const reviews = proposals.map(p => ({
      proposalId: p.id,
      sessionId: p.threadId || p.sessionId || '',
      targetText: p.targetText || '',
      replacement: p.replacement || '',
      path: p.absolutePath || p.path,
      type: p.type || 'edit',
    }))
    fileManager.setFileReviews(file, reviews)
    activateDiffFromReviews(file)
  } catch {}
}

watch(() => fileManager.activeFileIndex, () => {
  const file = fileManager.currentFile
  if (file?.reviews) {
    if (!activateDiffFromReviews(file)) diffStore.deactivate()
  } else if (diffStore.active && diffStore.reviewMeta?.ids) {
    diffStore.deactivate()
  }
  checkProposalsForFile(file)
})

watch(
  () => [
    activeFileIndex.value,
    ...openFiles.value.map(file => `${file.path || ''}:${file.dirty ? '1' : '0'}`),
  ].join('|'),
  scheduleProposalEditorRegistration,
  { immediate: true },
)

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
])

// --- Content sync + save ---

let nativeMenuTimer = null
let unlistenNativeMenuFocus = null

const contentSync = useContentSync({
  editorSurfaceRef,
  currentFile,
  fileManager,
  documentBridge,
})
const { currentEditorContent, flushEditorContent, scheduleContentSync, syncOpenFileSnapshot } = contentSync

async function saveCurrentFile({ source = 'manual', mode = 'save' } = {}) {
  const feedbackMode = mode === 'saveAs' || !currentFile.value?.path ? 'saveAs' : 'save'
  saveFeedback.begin(source)
  saveFeedback.setMode(feedbackMode)
  try {
    const didSave = mode === 'saveAs'
      ? await fileManager.saveAs()
      : await fileManager.save()
    saveFeedback.finish(didSave, currentFile.value?.path ? fileDisplayName(currentFile.value) : 'Saved')
    return didSave
  } catch (error) {
    saveFeedback.finish(false)
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
})
const { closeConfirmFile, closeConfirmFileName, arrivedTabIndex, onSelectTab, onCloseTab, onCloseConfirm, onNewFile, onReorderTab } = tabMgmt

watch(closeConfirmFile, (v) => {
  if (v) nextTick(() => closeOverlayRef.value?.focus())
})

const restoreTimeLabel = computed(() => {
  const meta = restoreConfirmMeta.value
  if (!meta?.timestamp) return 'an earlier point'
  return relativeTime(meta.timestamp)
})

const modKey = computed(() => platformKind() === 'mac' ? '⌘' : 'Ctrl+')

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

function nativeMenuActions() {
  return {
    newFile: onNewFile,
    openFile: onOpenDialog,
    openRecent: onOpenRecent,
    clearRecent: onClearRecent,
    save: onSave,
    saveAs: onSaveAs,
    closeTab: () => onCloseTab(activeFileIndex.value),
    editCommand: onEditCommand,
    rewriteSelection: onRewriteSelection,
    openSettings,
  }
}

async function syncNativeMenu() {
  await installNativeEditorMenu({
    recentFiles: fileManager.recentFiles,
    actions: nativeMenuActions(),
  })
}

function scheduleNativeMenuSync() {
  if (!shouldInstallNativeEditorMenu()) return
  clearTimeout(nativeMenuTimer)
  nativeMenuTimer = setTimeout(() => {
    syncNativeMenu().catch((error) => {
      console.error('[nativeMenu] sync failed', error)
    })
  }, 80)
}

async function bindNativeMenuFocusSync() {
  if (!shouldInstallNativeEditorMenu()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    unlistenNativeMenuFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) syncNativeMenu()
    })
  } catch (error) {
    console.error('[nativeMenu] focus binding failed', error)
  }
}

watch(() => fileManager.recentFiles.slice(), () => {
  scheduleNativeMenuSync()
})

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

  const existing = commentManager.findActiveByRange(null, sel.from, sel.to)
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
  commentManager.commentAdded()
}

function commentPrompt(commentId) {
  const view = editorSurfaceRef.value?.getView()
  const comments = view ? getCommentsFromState(view.state) : commentManager.comments
  const active = comments.find(c => c.id === commentId) || comments[0]
  const path = currentFile.value?.path || ''
  const line = view && active ? view.state.doc.lineAt(Math.min(active.contentFrom, view.state.doc.length)).number : null
  return buildCommentsPrompt({ comments, filePath: path, focusId: commentId, focusLine: line })
}

async function onInlineCommentAction({ type, id, text }) {
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
      await navigator.clipboard?.writeText(commentPrompt(id))
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
  const title = path ? path.split('/').pop() : 'Untitled'
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

async function mimOpen(path) {
  if (!path) throw new Error('path is required')
  flushEditorContent({ bridge: 'flush' })
  const content = await readFile(path)
  await fileManager.openFile(path, content)
  await nextTick()
  editorSurfaceRef.value?.scrollToPos(0)
  return mimActive()
}

function mimActive({ includeContent = false } = {}) {
  flushEditorContent({ bridge: 'flush' })
  const file = currentFile.value
  if (!file) return null
  const content = editorSurfaceRef.value?.getContent?.() ?? file.content ?? ''
  return {
    path: file.path || null,
    name: file.path ? file.path.split('/').pop() : 'Untitled.md',
    dirty: Boolean(file.dirty),
    index: activeFileIndex.value,
    cursor: editorSurfaceRef.value?.getCursor?.() || null,
    content: includeContent ? content : undefined,
  }
}

function mimTabs() {
  flushEditorContent({ bridge: 'flush' })
  return openFiles.value.map((file, index) => ({
    index,
    path: file.path || null,
    name: file.path ? file.path.split('/').pop() : `Untitled-${index + 1}.md`,
    dirty: Boolean(file.dirty),
    active: index === activeFileIndex.value,
  }))
}

function mimSelection() {
  return editorSurfaceRef.value?.getSelection?.() || null
}

function mimComments() {
  const view = editorSurfaceRef.value?.getView()
  const comments = view ? getCommentsFromState(view.state) : []
  return {
    ...mimActive(),
    comments: comments.map((comment) => {
      const line = view ? view.state.doc.lineAt(Math.min(comment.contentFrom, view.state.doc.length)) : null
      return {
        id: comment.id,
        author: comment.author || 'user',
        text: comment.text || '',
        status: comment.status || 'active',
        created: comment.created || null,
        anchorText: comment.anchorText || '',
        line: line?.number || null,
        column: line ? comment.contentFrom - line.from + 1 : null,
        replies: (comment.replies || []).map(reply => ({
          id: reply.id || null,
          author: reply.author || 'agent',
          text: reply.text || '',
          timestamp: reply.ts || null,
        })),
      }
    }),
    prompt: commentPrompt(comments[0]?.id),
  }
}

function mimCommentAction(action, commentId) {
  const handlers = {
    resolve: commentMutations.resolve,
    reopen: commentMutations.reopen,
    delete: commentMutations.delete,
  }
  const handler = handlers[action]
  if (!handler) return { ok: false, error: `Unknown comment action: ${action}` }
  return handler(commentId)
}

function mimReplaceSelection(text = '') {
  const sel = editorSurfaceRef.value?.getSelection?.()
  if (!sel) throw new Error('No active selection')
  editorSurfaceRef.value?.replaceRange(sel.from, sel.to, text)
  return { from: sel.from, to: sel.from + text.length, replaced: sel.to - sel.from }
}

function mimSetContent(content = '') {
  const current = editorSurfaceRef.value?.getContent?.() || ''
  editorSurfaceRef.value?.replaceRange(0, current.length, content)
  return mimActive()
}

function mimReviewProposal(proposal) {
  if (!proposal?.id || !proposal?.targetText) {
    throw new Error('A review proposal needs an id and targetText.')
  }
  const file = currentFile.value
  if (!file) throw new Error('No document is open.')
  flushEditorContent({ bridge: 'flush' })
  const review = {
    proposalId: proposal.id,
    sessionId: proposal.sessionId || proposal.threadId || 'mcp',
    targetText: proposal.targetText,
    replacement: proposal.replacement || '',
    path: proposal.absolutePath || proposal.path || file.path || '',
    type: proposal.type || 'edit',
    original: proposal.original,
    modified: proposal.modified,
  }
  fileManager.setFileReviews(file, [review])
  const diff = computeDiffFromReview(review, file.content || '')
  if (!diff) throw new Error('The proposal target is no longer present in the active document.')
  activateDiffForCurrentFile(diff.original, diff.modified, {
    review: {
      ids: [review.proposalId],
      sessionId: review.sessionId,
      path: review.path,
    },
  })
  return { proposalId: review.proposalId, status: 'pending_review' }
}

function mimReveal({ path, line, offset } = {}) {
  if (path) {
    const idx = openFiles.value.findIndex(file => file.path === path)
    if (idx >= 0) fileManager.setActiveTab(idx)
  }
  nextTick(() => {
    const view = editorSurfaceRef.value?.getView?.()
    let pos = Number.isFinite(offset) ? offset : 0
    if (view && Number.isFinite(line) && line > 0) {
      pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
    }
    editorSurfaceRef.value?.scrollToPos(pos)
  })
  return mimActive()
}

async function mimSave() {
  flushEditorContent({ bridge: 'flush' })
  const saved = await saveCurrentFile({ source: 'mimx' })
  return { saved, active: mimActive() }
}

function mimCloseActiveTab() {
  onCloseTab(activeFileIndex.value)
}

defineExpose({
  mimOpen,
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
  mimCloseActiveTab,
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
  onNewFile,
  onNewTab: () => fileManager.newTab(),
  onCloseTab: () => onCloseTab(activeFileIndex.value),
  onRewriteSelection,
  editorHasFocus: () => Boolean(editorSurfaceRef.value?.hasFocus?.()),
})

// --- Session persistence ---

function onBeforeUnload() {
  flushEditorContent({ bridge: 'flush' })
}

function onEditorKeydown(event) {
  if (event.key === 'Escape' && diffStore.active) {
    if (diffStore.isBatchFileFocused) {
      diffStore.clearBatchFocus()
      reviewTabActive.value = true
    } else if (diffStore.isBatch) {
      diffStore.deactivate()
      reviewTabActive.value = false
    } else {
      diffStore.deactivate()
    }
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
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('keydown', onEditorKeydown)

  // Restore session
  const session = await loadSession()
  if (session?.recentFiles?.length) {
    fileManager.setRecentFiles(session.recentFiles)
  }
  if (session?.openFiles?.length) {
    for (const entry of session.openFiles) {
      const path = typeof entry === 'string' ? entry : entry.path
      if (path) {
        try {
          const content = await readFile(path)
          await fileManager.openFile(path, content)
        } catch {
          // File no longer exists, skip
        }
      } else if (entry.content) {
        fileManager.newFile()
        fileManager.updateContent(entry.content)
      }
    }
    if (session.activeFileIndex != null) {
      fileManager.setActiveTab(session.activeFileIndex)
    }
    if (session.zoomLevel) state.zoomLevel = session.zoomLevel
  }

  // If no files restored, start with a blank file
  if (!fileManager.hasOpenFiles) {
    fileManager.newFile()
  }

  // Persist session state reactively (debounced on any change)
  sessionPersistCleanup = createSessionPersist({
    openFiles,
    recentFiles: computed(() => fileManager.recentFiles),
    activeFileIndex,
    zoomLevel: computed(() => state.zoomLevel),
  }, saveSession)

  syncOpenFileSnapshot()
  await syncNativeMenu()
  await bindNativeMenuFocusSync()

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
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('keydown', onEditorKeydown)
  autoSave.clear()
  contentSync.dispose()
  clearTimeout(nativeMenuTimer)
  clearTimeout(proposalRegisterTimer)
  unregisterProposalEditor()
  saveFeedback.dispose()
  if (unlistenNativeMenuFocus) unlistenNativeMenuFocus()
  if (sessionPersistCleanup) sessionPersistCleanup()
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
