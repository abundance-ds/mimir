<template>
  <main class="mim-frame" :class="{ 'is-panel-hidden': !panelVisible, 'is-terminal-hidden': !terminalVisible }">
    <!-- Terminal (left panel) -->
    <section v-show="terminalVisible" ref="terminalSectionRef" class="mim-terminal">
      <header class="mim-terminal-header drag-region" data-tauri-drag-region="deep">
        <div class="mim-traffic-spacer" data-tauri-drag-region aria-hidden="true" />
        <div class="mim-terminal-title" data-tauri-drag-region>
          <button class="mim-folder-btn no-drag" @click="openFolder" :title="workspaceFolder || 'Open a folder'">
            <IconFolder :size="12" />
            <span class="mim-folder-name">{{ folderDisplayName }}</span>
          </button>
          <button v-if="workspaceFolder" class="mim-folder-clear no-drag" title="Close folder" @click="clearFolder">
            <IconX :size="10" />
          </button>
        </div>
        <button class="mim-header-btn no-drag" :title="panelVisible ? 'Expand terminal' : 'Show panel'" @click="togglePanel">
          <component :is="panelVisible ? IconLayoutSidebarRightCollapse : IconLayoutSidebarRightExpand" :size="14" />
        </button>
        <div class="flex-1 self-stretch" data-tauri-drag-region />
      </header>
      <TerminalPanel
        v-if="settingsLoaded"
        ref="terminalPanelRef"
        visible
        dock="side"
        :side-width="terminalWidth"
        :default-cwd="workspaceFolder"
        @close="onTerminalAllClosed"
      />
      <div
        class="mim-resize"
        :class="{ active: terminalDragging }"
        @pointerdown="onTerminalResizeStart"
      />
    </section>

    <!-- Right panel -->
    <section v-show="panelVisible" class="mim-right-panel">
      <EditorApp v-show="rightPanel === 'editor'" ref="editorRef" hide-sidebar />

      <div v-show="rightPanel === 'issues'" class="mim-view">
        <header class="mim-view-header drag-region" data-tauri-drag-region="deep">
          <div class="flex-1 self-stretch" data-tauri-drag-region />
          <button class="mim-collapse-btn no-drag" :title="terminalVisible ? 'Expand panel' : 'Show terminal'" @click="toggleTerminal">
            <component :is="terminalVisible ? IconLayoutSidebarLeftCollapse : IconLayoutSidebarLeftExpand" :size="14" />
          </button>
          <div class="mim-panel-toggles no-drag">
            <button v-for="p in panels" :key="p.id" class="mim-ptoggle" :class="{ active: rightPanel === p.id }" @click="setRightPanel(p.id)">{{ p.label }}</button>
          </div>
        </header>
        <div v-if="!workspaceFolder" class="mim-empty-state">
          <IconFolder :size="24" class="mim-empty-icon" />
          <p>Open a folder to track issues</p>
          <button class="mim-empty-btn" @click="openFolder">Open Folder</button>
        </div>
        <template v-else>
          <div v-if="boardStore.selectedEntry && boardStore.selectedEntry.meta.type === 'issue'" class="flex-1 overflow-y-auto">
            <EntryDetail :entry="boardStore.selectedEntry" back-label="Board" @close="boardStore.clearSelection()" @save="onSaveEntry" @delete="onDeleteEntry" />
          </div>
          <KanbanView v-else />
        </template>
      </div>

      <div v-show="rightPanel === 'knowledge'" class="mim-view">
        <header class="mim-view-header drag-region" data-tauri-drag-region="deep">
          <div class="flex-1 self-stretch" data-tauri-drag-region />
          <button class="mim-collapse-btn no-drag" :title="terminalVisible ? 'Expand panel' : 'Show terminal'" @click="toggleTerminal">
            <component :is="terminalVisible ? IconLayoutSidebarLeftCollapse : IconLayoutSidebarLeftExpand" :size="14" />
          </button>
          <div class="mim-panel-toggles no-drag">
            <button v-for="p in panels" :key="p.id" class="mim-ptoggle" :class="{ active: rightPanel === p.id }" @click="setRightPanel(p.id)">{{ p.label }}</button>
          </div>
        </header>
        <div v-if="!workspaceFolder" class="mim-empty-state">
          <IconBook :size="24" class="mim-empty-icon" />
          <p>Open a folder to use the knowledge base</p>
          <button class="mim-empty-btn" @click="openFolder">Open Folder</button>
        </div>
        <template v-else>
          <div v-if="boardStore.selectedEntry && boardStore.selectedEntry.meta.type === 'knowledge'" class="flex-1 overflow-y-auto">
            <EntryDetail :entry="boardStore.selectedEntry" back-label="Knowledge" @close="boardStore.clearSelection()" @save="onSaveEntry" @delete="onDeleteEntry" />
          </div>
          <KnowledgeView v-else />
        </template>
      </div>
    </section>

  </main>
</template>

<script setup>
import '../panel/styles.css'
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconFolder,
  IconX,
  IconBook,
} from '@tabler/icons-vue'
import TerminalPanel from '../panel/components/TerminalPanel.vue'
import EditorApp from '../editor/App.vue'
import KanbanView from '../panel/components/board/KanbanView.vue'
import KnowledgeView from '../panel/components/board/KnowledgeView.vue'
import EntryDetail from '../panel/components/board/EntryDetail.vue'
import { initializePanelStores } from '../stores/panel/persistence.js'
import { useSettingsStore } from '../stores/settings.js'
import { useFileStore } from '../stores/files.js'
import { useBoardStore } from '../stores/panel/board.js'
import { useSidebarResize } from '../shared/composables/useSidebarResize.js'

const settings = useSettingsStore()
const fileStore = useFileStore()
const boardStore = useBoardStore()
const editorRef = ref(null)
const terminalPanelRef = ref(null)
const terminalSectionRef = ref(null)
const panelVisible = ref(true)
const terminalVisible = ref(true)

const settingsLoaded = ref(false)
const workspaceFolder = ref('')
const rightPanel = ref('editor')

const folderDisplayName = computed(() => {
  if (!workspaceFolder.value) return 'Open Folder'
  return workspaceFolder.value.split('/').pop() || workspaceFolder.value
})

const panels = [
  { id: 'editor', label: 'Editor' },
  { id: 'issues', label: 'Issues' },
  { id: 'knowledge', label: 'KB' },
]

const mimPanelToggles = {
  panels,
  rightPanel,
  setRightPanel,
  panelVisible,
  terminalVisible,
  collapse: () => toggleTerminal(),
}

provide('mimWorkspaceFolder', workspaceFolder)
provide('mimPanelToggles', mimPanelToggles)

const { width: terminalWidth, dragging: terminalDragging, onPointerDown: onTerminalResizeStart } = useSidebarResize(
  settings.mimTerminalWidth || 460,
  { min: 300, max: 900, side: 'left' },
)

watch(terminalDragging, (isDragging) => {
  if (!isDragging) settings.set('mimTerminalWidth', terminalWidth.value)
})

// ── Panel toggle logic ──
// Each button toggles the OTHER panel.
// Both visible → icon means "expand me" (hide other). Solo → icon means "bring back other".

function togglePanel() {
  if (panelVisible.value) {
    panelVisible.value = false
  } else {
    panelVisible.value = true
    if (rightPanel.value === 'editor' && fileStore.openFiles.length === 0) {
      nextTick(() => fileStore.newFile())
    }
  }
}

function toggleTerminal() {
  if (terminalVisible.value) {
    terminalVisible.value = false
  } else {
    terminalVisible.value = true
    nextTick(() => terminalPanelRef.value?.addTab?.())
  }
}

// ── Panel switching ──

function setRightPanel(panel) {
  rightPanel.value = panel
  settings.set('mimRightPanel', panel)
  boardStore.clearSelection()
}

// ── Cmd+W / tab close logic ──

let _cmdDown = false

function isTerminalFocused() {
  return Boolean(
    terminalPanelRef.value?.hasFocus?.() ||
    terminalSectionRef.value?.contains(document.activeElement),
  )
}

function onTerminalAllClosed() {
  if (panelVisible.value) {
    terminalVisible.value = false
  } else {
    closeWindow()
  }
}

watch(() => fileStore.openFiles.length, (count, prev) => {
  if (count === 0 && prev > 0 && rightPanel.value === 'editor') {
    if (terminalVisible.value) {
      panelVisible.value = false
    } else {
      closeWindow()
    }
  }
})

async function closeWindow() {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().destroy()
  } catch {}
}

async function setupCloseInterceptor() {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().onCloseRequested((event) => {
      if (!_cmdDown) return
      event.preventDefault()
      _cmdDown = false

      if (isTerminalFocused() && terminalVisible.value) {
        terminalPanelRef.value?.closeActiveTab?.()
      } else if (panelVisible.value && rightPanel.value === 'editor') {
        editorRef.value?.mimCloseActiveTab?.()
      }
    })
  } catch {}
}

// ── Folder ──

async function openFolder() {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false, title: 'Open folder' })
    if (!selected) return
    const path = Array.isArray(selected) ? selected[0] : selected
    if (!path) return
    workspaceFolder.value = path
    settings.set('mimWorkspaceFolder', path)
    boardStore.loadBoardFromFolder(path)
  } catch (err) {
    console.warn('[mim-panel] openFolder failed:', err)
  }
}

function clearFolder() {
  workspaceFolder.value = ''
  settings.set('mimWorkspaceFolder', '')
  boardStore.loadBoardFromFolder('')
}

// ── Board entry handlers ──

async function onSaveEntry({ entryId, meta, body }) {
  await boardStore.updateEntry(entryId, meta, body)
}

async function onDeleteEntry(entryId) {
  await boardStore.removeEntry(entryId)
}

// ── Tool server ──

async function startToolServer() {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const { initToolServer } = await import('../services/toolServer.js')
    await invoke('tool_server_start', {})
    await initToolServer(() => null, editorRef.value)
  } catch (error) {
    console.warn('[mim-panel] Failed to start tool server:', error)
  }
}

// ── Keyboard shortcuts ──

function onKeydown(event) {
  if (event.key === 'Meta' || event.key === 'Control') _cmdDown = true
  const primary = event.metaKey || event.ctrlKey
  const terminalFocused = isTerminalFocused()
  const key = event.key.toLowerCase()

  if (primary && terminalFocused && !event.shiftKey && (key === 't' || key === 'n')) {
    event.preventDefault()
    event.stopImmediatePropagation()
    terminalPanelRef.value?.addTab?.()
    return
  }

  if (primary && terminalFocused && (event.key === '+' || event.key === '=')) {
    event.preventDefault()
    event.stopImmediatePropagation()
    terminalPanelRef.value?.zoomIn?.()
    return
  }

  if (primary && terminalFocused && event.key === '-') {
    event.preventDefault()
    event.stopImmediatePropagation()
    terminalPanelRef.value?.zoomOut?.()
    return
  }

  if (primary && event.altKey && terminalFocused && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.key === 'ArrowLeft') terminalPanelRef.value?.previousTab?.()
    else terminalPanelRef.value?.nextTab?.()
    return
  }

  // Cmd+W: close active tab in focused panel
  if (primary && !event.shiftKey && key === 'w') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (terminalFocused && terminalVisible.value) {
      terminalPanelRef.value?.closeActiveTab?.()
    } else if (panelVisible.value && rightPanel.value === 'editor') {
      editorRef.value?.mimCloseActiveTab?.()
    }
    return
  }

  // Cmd+`: focus or show terminal
  if (primary && event.key === '`') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (terminalVisible.value) {
      terminalPanelRef.value?.focus?.()
    } else {
      toggleTerminal()
    }
  }

  // Cmd+\: toggle terminal
  if (primary && event.key === '\\') {
    event.preventDefault()
    event.stopImmediatePropagation()
    toggleTerminal()
  }
}

function onKeyup(event) {
  if (event.key === 'Meta' || event.key === 'Control') _cmdDown = false
}

function onWindowBlur() {
  _cmdDown = false
}

window.__mim_terminalPaste = async (text) => {
  if (!text) return false
  return (await terminalPanelRef.value?.pasteText?.(text)) || false
}

// ── Lifecycle ──

onMounted(async () => {
  await initializePanelStores()
  await nextTick()
  if (settings.mimWorkspaceFolder) {
    workspaceFolder.value = settings.mimWorkspaceFolder
  }
  if (settings.mimRightPanel) {
    rightPanel.value = settings.mimRightPanel
  }
  settingsLoaded.value = true
  await startToolServer()
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', onWindowBlur)
  await setupCloseInterceptor()
  if (workspaceFolder.value) {
    boardStore.loadBoardFromFolder(workspaceFolder.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('keyup', onKeyup, true)
  window.removeEventListener('blur', onWindowBlur)
  delete window.__mim_terminalPaste
  if (window.__TAURI_INTERNALS__) {
    import('../services/toolServer.js').then(({ destroyToolServer }) => destroyToolServer())
    invoke('tool_server_stop').catch(() => {})
  }
})
</script>

<style scoped>
.mim-frame {
  height: 100%;
  width: 100%;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-chrome);
}

.mim-terminal {
  position: relative;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mim-right-panel {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mim-terminal-header {
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  min-width: 0;
  padding-right: 10px;
  background: var(--color-chrome-high);
  border-right: 1px solid var(--color-rule-light);
  border-bottom: 1px solid var(--color-rule-light);
}

.mim-traffic-spacer {
  width: 76px;
  align-self: stretch;
  flex: none;
}

.mim-terminal-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: none;
}

.mim-folder-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border: none;
  border-radius: 4px;
  background: var(--color-chrome-mid);
  color: var(--color-ink-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  max-width: 200px;
}

.mim-folder-btn:hover {
  background: var(--color-chrome);
  color: var(--color-ink);
}

.mim-folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mim-folder-clear {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--color-ink-3);
  flex-shrink: 0;
}

.mim-folder-clear:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}

.mim-header-btn {
  width: 28px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--color-ink-3);
  transition: color 140ms, background 140ms, border-color 140ms;
}

.mim-header-btn:hover {
  color: var(--color-ink);
  background: var(--color-chrome-mid);
  border-color: var(--color-rule-light);
}

.mim-terminal :deep(.tp-side) {
  flex: 1;
  height: auto;
  min-height: 0;
}

/* ── Panel hidden states ── */

.mim-frame.is-panel-hidden .mim-terminal {
  flex: 1;
}

.mim-frame.is-panel-hidden .mim-terminal :deep(.tp-side) {
  width: 100% !important;
  max-width: none;
}

.mim-frame.is-panel-hidden .mim-resize {
  display: none;
}

.mim-frame.is-terminal-hidden .mim-resize {
  display: none;
}

.mim-resize {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 8px;
  z-index: 40;
  cursor: col-resize;
}

.mim-resize::after {
  content: "";
  position: absolute;
  top: 0;
  right: 3px;
  bottom: 0;
  width: 2px;
  background: var(--color-accent);
  opacity: 0;
  transition: opacity 120ms ease;
}

.mim-resize:hover::after,
.mim-resize.active::after {
  opacity: 1;
}

/* ── View container (issues / knowledge) ── */

.mim-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── View headers (match editor AppHeader: 40px, chrome bg) ── */

.mim-view-header {
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 14px;
  background: var(--color-chrome);
  border-bottom: 1px solid var(--color-rule-light);
  white-space: nowrap;
  overflow: visible;
}

.mim-collapse-btn {
  width: 28px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--color-ink-3);
  transition: color 140ms, background 140ms, border-color 140ms;
}

.mim-collapse-btn:hover {
  color: var(--color-ink);
  background: var(--color-chrome-mid);
  border-color: var(--color-rule-light);
}

/* ── Panel toggles (inside view headers) ── */

.mim-panel-toggles {
  display: flex;
  gap: 1px;
  background: var(--color-chrome-mid);
  border-radius: 5px;
  padding: 2px;
  flex-shrink: 0;
}

.mim-ptoggle {
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-ink-3);
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 560;
  white-space: nowrap;
  transition: color 100ms, background 100ms;
}

.mim-ptoggle:hover {
  color: var(--color-ink-2);
}

.mim-ptoggle.active {
  background: var(--color-surface);
  color: var(--color-ink);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

/* ── Board content area ── */

.mim-view :deep(.flex.flex-col.flex-1) {
  background: var(--color-chrome-high);
}

/* ── Empty state ── */

.mim-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  background: var(--color-chrome-high);
}

.mim-empty-icon {
  color: var(--color-ink-3);
  margin-bottom: 4px;
}

.mim-empty-state p {
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--color-ink-3);
  text-align: center;
}

.mim-empty-btn {
  height: 28px;
  padding: 0 14px;
  margin-top: 4px;
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
}

.mim-empty-btn:hover {
  background: var(--color-chrome-mid);
  color: var(--color-ink);
}
</style>
