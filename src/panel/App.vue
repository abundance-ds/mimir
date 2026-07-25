<template>
  <main class="panel-frame" :class="{ 'is-sidebar-open': panelUI.sidebarOpen }">
    <PanelHeader
      :sidebar-open="panelUI.sidebarOpen"
      :sidebar-width="sidebarWidth"
      @toggle-sidebar="panelUI.toggleSidebar()"
    />
    <div class="panel-body">
      <div
        class="panel-scrim"
        aria-hidden="true"
        @click="panelUI.closeSidebar()"
      />
      <Sidebar
        class="panel-sidebar"
        :width="sidebarWidth"
        :dragging="sidebarDragging"
        @resize-start="onSidebarResizeStart"
      />
      <div class="panel-content" :class="panelUI.sidebarOpen && 'rounded-bl-xl'">
        <div class="panel-content-main">
          <ProjectBoard v-if="panelUI.projectHomeId" :project-id="panelUI.projectHomeId" />
          <AppView v-else-if="activeAppSession" :session="activeAppSession" />
          <ChatView v-else-if="showChat" />
          <NewChat v-else />
        </div>
        <TerminalPanel
          v-show="panelUI.terminalOpen"
          :visible="panelUI.terminalOpen"
          ref="terminalPanelRef"
          @close="panelUI.closeTerminal()"
        />
      </div>
    </div>

    <AddProjectDialog
      v-if="panelUI.showAddProjectDialog"
      :mode="panelUI.projectDialogMode"
      @close="panelUI.closeProjectDialog()"
      @created="panelUI.closeProjectDialog()"
    />
  </main>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { primaryModifierPressed, platformKind } from '../shared/platform.js'
import { usePanelUIStore } from '../stores/panel/ui.js'
import { useSessionStore } from '../stores/panel/sessions.js'
import { useChatStore } from '../stores/panel/chat.js'
import { initializePanelStores } from '../stores/panel/persistence.js'
import { createSessionWithChat, doneSession, unarchiveSession } from '../stores/panel/actions.js'
import { sessionStatusKind } from '../stores/panel/helpers.js'
import { useSettingsStore } from '../stores/settings.js'
import { useSidebarResize } from '../shared/composables/useSidebarResize.js'
import PanelHeader from './components/PanelHeader.vue'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import NewChat from './components/NewChat.vue'
import AppView from './components/AppView.vue'
import ProjectBoard from './components/board/ProjectBoard.vue'
import AddProjectDialog from './components/AddProjectDialog.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import { init as initTelemetry } from '../services/telemetry.js'
import { useProjectStore } from '../stores/panel/projects.js'

const panelUI = usePanelUIStore()
const sessions = useSessionStore()
const chat = useChatStore()
const settingsStore = useSettingsStore()
const terminalPanelRef = ref(null)
const { width: sidebarWidth, dragging: sidebarDragging, onPointerDown: onSidebarResizeStart } = useSidebarResize(settingsStore.panelSidebarWidth, { min: 180, max: 400 })
watch(() => sidebarDragging.value, (isDragging) => {
  if (!isDragging) settingsStore.set('panelSidebarWidth', sidebarWidth.value)
})

const NARROW_PANEL_QUERY = '(max-width: 640px)'
let narrowPanelQuery = null

function syncNarrowSidebar(event) {
  if (event.matches) panelUI.closeSidebar()
}

async function closePanelWindow() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().close()
  } catch {
    window.close()
  }
}

function onKeydown(event) {
  if (primaryModifierPressed(event) && !event.shiftKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    panelUI.newChatStartMode = 'chat'
    const projectId = panelUI.projectHomeId || sessions.activeSession?.projectId || 'general'
    createSessionWithChat(null, { projectId })
    return
  }
  if (primaryModifierPressed(event) && !event.shiftKey && event.key.toLowerCase() === 'w') {
    if (panelUI.terminalOpen && terminalPanelRef.value?.$el?.contains(document.activeElement)) {
      event.preventDefault()
      terminalPanelRef.value.closeActiveTab()
      return
    }
    event.preventDefault()
    closePanelWindow()
    return
  }
  // Ctrl+` / Cmd+` toggles terminal
  if (primaryModifierPressed(event) && event.key === '`') {
    event.preventDefault()
    panelUI.toggleTerminal()
    if (panelUI.terminalOpen) {
      nextTick(() => terminalPanelRef.value?.focus())
    }
    return
  }
  // Cmd/Ctrl+Shift+D: archive / unarchive active session
  if (primaryModifierPressed(event) && event.shiftKey && event.key.toLowerCase() === 'd') {
    event.preventDefault()
    const s = sessions.activeSession
    if (s?.archived) unarchiveSession(s.id)
    else if (s && !['ready', 'working'].includes(sessionStatusKind(s))) doneSession()
    return
  }
  if (event.key === 'Escape' && panelUI.sidebarOpen && narrowPanelQuery?.matches) {
    panelUI.closeSidebar()
  }
}

async function installPanelMenu() {
  if (!window.__TAURI_INTERNALS__ || platformKind() !== 'macos') return
  try {
    const { Menu } = await import('@tauri-apps/api/menu')
    const menu = await Menu.new({
      items: [
        { text: 'Edit', items: [
          { item: 'Undo' },
          { item: 'Redo' },
          { item: 'Separator' },
          { item: 'Cut' },
          { item: 'Copy' },
          { item: 'Paste' },
          { item: 'SelectAll' },
        ] },
        { text: 'Window', items: [
          { item: 'Minimize' },
          { item: 'Maximize' },
          { item: 'Fullscreen' },
          { item: 'Separator' },
          { item: 'BringAllToFront' },
        ] },
      ],
    })
    await menu.setAsAppMenu()
  } catch {}
}

onMounted(async () => {
  await initializePanelStores()
  initTelemetry(settingsStore)
  installPanelMenu()
  narrowPanelQuery = window.matchMedia?.(NARROW_PANEL_QUERY) || null
  if (narrowPanelQuery?.matches) panelUI.closeSidebar()
  narrowPanelQuery?.addEventListener?.('change', syncNarrowSidebar)
  document.addEventListener('keydown', onKeydown)

  // Silent update check after startup
  if (window.__TAURI_INTERNALS__) {
    setTimeout(async () => {
      try {
        const { checkForUpdate } = await import('../services/appUpdater.js')
        const update = await checkForUpdate()
        if (update) {
          panelUI.setUndoToast(`Update available: v${update.version}`, [])
        }
      } catch {}
    }, 5000)

    startToolServer()
  }
})

async function startToolServer() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { initToolServer } = await import('../services/toolServer.js')
    const projStore = useProjectStore()
    await invoke('tool_server_start', {})
    await initToolServer((cwd) => projStore.findProjectByFilePath(cwd))
  } catch (e) {
    console.warn('[tool-server] Failed to start:', e)
  }
}

onUnmounted(() => {
  narrowPanelQuery?.removeEventListener?.('change', syncNarrowSidebar)
  document.removeEventListener('keydown', onKeydown)
  if (window.__TAURI_INTERNALS__) {
    import('../services/toolServer.js').then(({ destroyToolServer }) => destroyToolServer())
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('tool_server_stop').catch(() => {}))
  }
})

const activeAppSession = computed(() => {
  const s = sessions.activeSession
  if (s?.type === 'app') return s
  return null
})

const showChat = computed(() =>
  sessions.activeSession && !activeAppSession.value && chat.activeMessages.length > 0
)
</script>

<style scoped>
.panel-frame {
  height: 100%; width: 100%;
  display: flex; flex-direction: column;
  font-size: 13px; line-height: 1.45;
  background: var(--color-chrome);
}

.panel-body {
  position: relative;
  flex: 1; display: flex; min-height: 0;
  overflow: hidden;
}

.panel-content {
  position: relative;
  flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  overflow: hidden;
  background: var(--color-chrome-high);
  border-left: 1px solid var(--color-rule-light);
}

.panel-content-main {
  position: relative;
  flex: 1; display: flex; min-height: 0;
  overflow: hidden;
}

.panel-frame:not(.is-sidebar-open) .panel-sidebar {
  display: none;
}

.panel-scrim {
  display: none;
}

@media (max-width: 640px) {
  .panel-sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 30;
    display: flex !important;
    width: min(256px, calc(100% - 44px));
    max-width: calc(100% - 44px);
    transform: translateX(-100%);
    visibility: hidden;
    pointer-events: none;
    box-shadow: 18px 0 44px rgba(0, 0, 0, 0.16);
    transition:
      transform 180ms ease,
      visibility 0ms linear 180ms;
  }

  .panel-frame.is-sidebar-open .panel-sidebar {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 180ms ease,
      visibility 0ms;
  }

  .panel-scrim {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: block;
    background: rgba(20, 18, 14, 0.18);
    opacity: 0;
    pointer-events: none;
    transition: opacity 180ms ease;
  }

  .panel-frame.is-sidebar-open .panel-scrim {
    opacity: 1;
    pointer-events: auto;
  }

  .panel-sidebar :deep(.sb-resize-handle) { display: none; }
  .panel-sidebar :deep(.sb) { width: min(256px, calc(100% - 44px)) !important; }
}
</style>
