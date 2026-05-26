<template>
  <aside class="sb" :class="dragging && 'select-none'" :style="{ width: width + 'px' }" aria-label="Panel sessions">

    <!-- Search bar + actions -->
    <div class="sb-top-row">
      <div class="sb-toolbar">
        <IconSearch :size="13" class="sb-toolbar-search-icon" />
        <input
          ref="searchInputRef"
          v-model="panelUI.searchQuery"
          type="search"
          placeholder="Search sessions..."
          class="sb-search-input"
          autocorrect="off"
          autocapitalize="off"
          @keydown.escape="clearSearch"
        />
        <button v-if="panelUI.searchQuery" class="sb-icon-btn" title="Clear" @click="clearSearch">
          <IconX :size="11" />
        </button>
      </div>
      <button class="sb-icon-btn sb-collapse-btn" title="Collapse all" @click="projStore.collapseAllProjects()">
        <IconCollapseAll :size="13" />
      </button>
      <div ref="addProjectRef" class="relative">
        <button class="sb-icon-btn" title="Add project" @click="addProjectMenuOpen = !addProjectMenuOpen">
          <IconPlus :size="13" />
        </button>
        <div v-if="addProjectMenuOpen" class="project-add-menu">
          <button @click="doOpenFolderProject">
            <IconFolderOpen :size="13" />
            <span>Open Folder...</span>
          </button>
          <button @click="openProjectDialog('new')">
            <IconFolderPlus :size="13" />
            <span>New Folder...</span>
          </button>
          <button @click="openProjectDialog('clone')">
            <IconGitBranch :size="13" />
            <span>Clone Repository...</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Full-text search results (replaces normal list when searching) -->
    <div v-if="search.searchActive.value" class="sb-projects">
      <p v-if="search.isSearching.value" class="px-3.5 py-2 text-[11px] text-ink-3">Searching...</p>
      <p v-else-if="search.results.value.length === 0" class="px-3.5 py-2 text-[11px] text-ink-3">No results</p>
      <template v-else>
        <div v-for="projectId in searchProjectIds" :key="'sr-' + projectId" class="project-group">
          <div class="project-toggle cursor-default">
            <component :is="searchProjectIcon(projectId)" class="text-ink-3 shrink-0" :size="13" />
            <span class="project-name">{{ searchProjectName(projectId) }}</span>
          </div>
          <div class="flex flex-col gap-px">
            <button
              v-for="result in search.resultsByProject.value[projectId]"
              :key="'sr-' + result.session_id + '-' + result.message_index"
              class="search-result-row"
              :class="{ 'opacity-55 hover:opacity-80': result.archived }"
              @click="onSearchResultClick(result)"
            >
              <span class="text-[12.5px] font-medium text-ink truncate" :class="result.archived && 'font-normal'">{{ result.label }}</span>
              <span class="search-result-excerpt" v-html="highlightMatch(result.match_text, panelUI.searchQuery)" />
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- Normal session list -->
    <template v-else>

    <!-- Pinned sessions (no header, float above all sections) -->
    <div v-if="sessionStore.pinnedSessions.length" class="sb-pinned-area">
      <button
        v-for="session in sessionStore.pinnedSessions"
        :key="'pin-' + session.id"
        class="session-row"
        :class="rowClasses(session)"
        @click="actions.selectSession(session.id)"
        @contextmenu.prevent="openContextMenu($event, session)"
        @dblclick="startRename(session)"
      >
        <IconPinFilled :size="10" class="text-ink-3 shrink-0" />
        <input
          v-if="editingId === session.id"
          :ref="el => { if (el) editInputRef = el }"
          v-model="editValue"
          class="session-rename-input"
          autocorrect="off"
          autocapitalize="off"
          @keydown.enter.prevent="commitRename"
          @keydown.escape.prevent="cancelRename"
          @blur="commitRename"
          @click.stop
        />
        <span v-else class="session-label">{{ session.label }}</span>
        <span v-if="statusTag(session)" class="session-tag" :class="tagClass(session)">
          <WorkingIndicator v-if="statusKind(session) === 'working'" />
          <template v-if="statusKind(session) !== 'working'">{{ statusTag(session) }}</template>
        </span>
        <time v-else class="text-[10px] text-ink-3 shrink-0 font-mono">{{ time(session.updatedAt || session.createdAt) }}</time>
      </button>
    </div>

    <!-- Project sections -->
    <div class="sb-projects">
      <div v-for="project in sessionStore.visibleProjects" :key="project.id" class="project-group">
        <div class="project-toggle" @contextmenu.prevent="openProjectContextMenu($event, project)">
          <button class="project-folder-btn" @click="projStore.toggleProject(project.id)">
            <component :is="projectIcon(project)" :size="13" />
          </button>
          <button class="project-name-btn" @click="onProjectNameClick(project)">
            {{ project.name }}
          </button>
          <button class="project-btn" title="More" @click.stop="openProjectContextMenu($event, project)">
            <IconDotsVertical :size="13" />
          </button>
        </div>

        <div
          v-if="projStore.projectExpanded(project.id)"
          class="flex flex-col gap-px"
          :data-project-id="project.id"
        >
          <template v-for="session in projectSessions(project.id)" :key="session.id">
            <div v-if="dropIndicator?.beforeId === session.id && dropIndicator?.projectId === project.id" class="drop-indicator" />
            <button
              class="session-row"
              :class="[rowClasses(session), drag?.sessionId === session.id && drag?.active && 'is-dragging']"
              :data-session-id="session.id"
              :data-project-id="project.id"
              @pointerdown="onRowPointerDown($event, session)"
              @click="onRowClick($event, session)"
              @contextmenu.prevent="openContextMenu($event, session)"
              @dblclick="startRename(session)"
            >
              <input
                v-if="editingId === session.id"
                :ref="el => { if (el) editInputRef = el }"
                v-model="editValue"
                class="session-rename-input"
                autocorrect="off"
                autocapitalize="off"
                @keydown.enter.prevent="commitRename"
                @keydown.escape.prevent="cancelRename"
                @blur="commitRename"
                @click.stop
                @pointerdown.stop
              />
              <span v-else class="session-label">{{ session.label }}</span>
              <span v-if="statusTag(session)" class="session-tag" :class="tagClass(session)">
                <WorkingIndicator v-if="statusKind(session) === 'working'" />
                <template v-if="statusKind(session) !== 'working'">{{ statusTag(session) }}</template>
              </span>
              <time v-else class="text-[10px] text-ink-3 shrink-0 font-mono">{{ time(session.updatedAt || session.createdAt) }}</time>
            </button>
            <div v-if="dropIndicator?.afterId === session.id && dropIndicator?.projectId === project.id" class="drop-indicator" />
          </template>
        </div>
      </div>

    </div>
    </template>

    <footer class="mt-auto pt-3 pb-1 border-t border-rule-light/60 flex flex-col gap-0.5">
      <SidebarRow label="Settings" dim @click="settingsOpen = true">
        <template #icon><IconSettings :size="14" /></template>
      </SidebarRow>
    </footer>

    <SettingsDialog :open="settingsOpen" initial-section="models" @close="settingsOpen = false" />

    <!-- Project context menu -->
    <ProjectContextMenu
      v-if="projectCtxMenu"
      :x="projectCtxMenu.x"
      :y="projectCtxMenu.y"
      :has-folder="Boolean(projStore.projects.find(p => p.id === projectCtxMenu.projectId)?.workspacePath)"
      :system="projectCtxMenu.projectId === 'general'"
      :has-done-sessions="projectHasCleanableSessions(projectCtxMenu.projectId)"
      @close="projectCtxMenu = null"
      @reveal="handleProjectReveal(projectCtxMenu.projectId)"
      @remove="handleProjectRemove(projectCtxMenu.projectId)"
      @settings="handleProjectSettings(projectCtxMenu.projectId)"
      @cleanup="handleProjectCleanup(projectCtxMenu.projectId)"
    />

    <!-- Session context menu -->
    <SessionContextMenu
      v-if="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :pinned="ctxMenu.session?.pinned"
      @close="closeContextMenu"
      @rename="onCtxRename"
      @pin="onCtxPin"
      @export="onCtxExport"
      @archive="onCtxArchive"
      @delete="onCtxDelete"
    />

    <Transition name="toast-fade">
      <div v-if="panelUI.undoToast" class="sb-undo-toast">
        <span>{{ panelUI.undoToast.message }}</span>
        <button @click="onUndoArchive">Undo</button>
      </div>
    </Transition>

    <div
      class="sb-resize-handle"
      :class="dragging && 'sb-resize-dragging'"
      @pointerdown="$emit('resize-start', $event)"
    />
  </aside>
</template>

<script setup>

import { computed, reactive, ref, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { usePanelUIStore } from '../../stores/panel/ui.js'
import { useProjectStore } from '../../stores/panel/projects.js'
import { useSessionStore } from '../../stores/panel/sessions.js'
import { sessionStatusKind, relativeTime } from '../../stores/panel/helpers.js'
import * as actions from '../../stores/panel/actions.js'
import { useBoardStore } from '../../stores/panel/board.js'
import { useSessionSearch } from '../composables/useSessionSearch.js'
import SidebarRow from './SidebarRow.vue'
import ProjectContextMenu from './ProjectContextMenu.vue'
import SessionContextMenu from './SessionContextMenu.vue'
import SettingsDialog from '../../shared/ui/SettingsDialog.vue'
import WorkingIndicator from '../../shared/ui/WorkingIndicator.vue'
import {
  IconSearch, IconFolderPlus, IconFolder,
  IconFolderOpen, IconDotsVertical, IconPlus, IconGitBranch, IconSettings,
  IconPinFilled, IconUser,
  IconX,
} from '@tabler/icons-vue'
import IconCollapseAll from '../../shared/icons/IconCollapseAll.vue'

defineProps({
  width: { type: Number, default: 256 },
  dragging: { type: Boolean, default: false },
})
defineEmits(['resize-start'])

const panelUI = usePanelUIStore()
const projStore = useProjectStore()
const sessionStore = useSessionStore()
const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
const settingsOpen = ref(false)
const addProjectMenuOpen = ref(false)
const addProjectRef = ref(null)
const search = useSessionSearch()
const editingId = ref(null)
const editValue = ref('')
const editInputRef = ref(null)
const searchInputRef = ref(null)

// ---- Pointer-based drag and drop ----
const drag = ref(null)
const dropIndicator = ref(null)
const DRAG_THRESHOLD = 5

function onRowPointerDown(event, session) {
  if (event.target.tagName === 'INPUT' || event.button !== 0) return
  drag.value = { sessionId: session.id, projectId: session.projectId, startX: event.clientX, startY: event.clientY, active: false }
  document.addEventListener('pointermove', onDocPointerMove)
  document.addEventListener('pointerup', onDocPointerUp)
}

function onRowClick(event, session) {
  if (drag.value?.active) { event.preventDefault(); return }
  actions.selectSession(session.id)
}

function onDocPointerMove(event) {
  if (!drag.value) return
  if (!drag.value.active) {
    const dx = Math.abs(event.clientX - drag.value.startX)
    const dy = Math.abs(event.clientY - drag.value.startY)
    if (dx + dy < DRAG_THRESHOLD) return
    drag.value.active = true
    panelUI.sidebarDragging = true
  }
  updateDropIndicator(event.clientY)
}

function onDocPointerUp() {
  document.removeEventListener('pointermove', onDocPointerMove)
  document.removeEventListener('pointerup', onDocPointerUp)
  if (drag.value?.active && dropIndicator.value) {
    const { projectId, beforeId } = dropIndicator.value
    const sessionId = drag.value.sessionId
    if (drag.value.projectId !== projectId) {
      actions.moveSessionToProject(sessionId, projectId)
    }
    sessionStore.reorderSession(projectId, sessionId, beforeId)
    import('../../stores/panel/persistence.js').then(({ schedulePersist }) => schedulePersist())
  }
  drag.value = null
  dropIndicator.value = null
  panelUI.sidebarDragging = false
}

function updateDropIndicator(clientY) {
  const rows = document.querySelectorAll('.sb .session-row[data-session-id]')
  let best = null
  for (const row of rows) {
    const sid = row.dataset.sessionId
    const pid = row.dataset.projectId
    if (sid === drag.value.sessionId) continue
    const rect = row.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    if (clientY < midY) {
      best = { projectId: pid, beforeId: sid, afterId: null }
      break
    }
    best = { projectId: pid, beforeId: null, afterId: sid }
  }
  dropIndicator.value = best
}

// ---- Search ----

function clearSearch() {
  panelUI.searchQuery = ''
  searchInputRef.value?.blur()
}

const searchProjectIds = computed(() => {
  return Object.keys(search.resultsByProject.value)
})

function searchProjectName(projectId) {
  const project = projStore.projects.find((p) => p.id === projectId)
  return project?.name || projectId
}

function searchProjectIcon(projectId) {
  const project = projStore.projects.find((p) => p.id === projectId)
  if (project?.system) return IconUser
  return IconFolder
}

function highlightMatch(text, query) {
  if (!query?.trim()) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const q = query.trim()
  const regex = new RegExp(`(${escapeRegex(q)})`, 'gi')
  return escaped.replace(regex, '<mark>$1</mark>')
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function onSearchResultClick(result) {
  if (result.archived) {
    await actions.restoreArchivedSession(result.project_id, result.session_id)
  } else {
    actions.selectSession(result.session_id)
  }
}

// ---- Archived ----



// ---- Lifecycle ----

function onKeydown(e) {
  if (e.metaKey && e.key === ',') {
    e.preventDefault()
    settingsOpen.value = !settingsOpen.value
  }
}
function onPointerDown(event) {
  if (addProjectRef.value && !addProjectRef.value.contains(event.target)) {
    addProjectMenuOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('pointerdown', onPointerDown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('pointerdown', onPointerDown)
})

// ---- Session display ----

function statusKind(session) { return sessionStatusKind(session) }
function time(value) { return relativeTime(value) }

function rowClasses(session) {
  const kind = statusKind(session)
  return {
    active: !panelUI.projectHomeId && session.id === sessionStore.activeSession?.id,
    'is-unread': kind === 'unread',
    'is-attention': kind === 'needs-approval',
    'is-error': kind === 'error',
  }
}

const justFinished = reactive(new Set())
const prevStatuses = new Map()

watch(
  () => sessionStore.sessions.map((s) => [s.id, sessionStatusKind(s)]),
  (entries) => {
    for (const [id, kind] of entries) {
      const prev = prevStatuses.get(id)
      prevStatuses.set(id, kind)
      if (prev === 'working' && kind !== 'working' && kind !== 'error') {
        justFinished.add(id)
        setTimeout(() => justFinished.delete(id), 2100)
      }
    }
  },
  { deep: true },
)

function statusTag(session) {
  const kind = statusKind(session)
  if (kind === 'working') return 'Working'
  if (kind === 'needs-approval') return 'Approve'
  if (kind === 'awaiting-review') return 'Review'
  if (kind === 'error') return 'Error'
  if (justFinished.has(session.id)) return 'Done'
  return null
}

function tagClass(session) {
  const kind = statusKind(session)
  if (justFinished.has(session.id) && kind !== 'needs-approval' && kind !== 'awaiting-review' && kind !== 'error') return 'tag-done'
  return 'tag-' + kind
}

// ---- Inline rename ----

function startRename(session) {
  editingId.value = session.id
  editValue.value = session.label
  nextTick(() => editInputRef.value?.select())
}

function commitRename() {
  if (!editingId.value) return
  const id = editingId.value
  editingId.value = null
  const trimmed = editValue.value.trim()
  const session = sessionStore.sessions.find(s => s.id === id)
  if (trimmed && session && trimmed !== session.label) {
    sessionStore.renameSession(id, trimmed)
  }
}

function cancelRename() {
  editingId.value = null
}

// ---- Projects ----

function onProjectNameClick(project) {
  const isViewingThisProject = panelUI.projectHomeId === project.id
  if (isViewingThisProject) {
    projStore.toggleProject(project.id)
  } else {
    panelUI.showProjectHome(project.id)
    if (!projStore.projectExpanded(project.id)) {
      projStore.toggleProject(project.id)
    }
  }
}

function projectIcon(project) {
  if (project.system) return IconUser
  return projStore.projectExpanded(project.id) ? IconFolderOpen : IconFolder
}

function projectSessions(projectId) {
  return sessionStore.sessionsForProject(projectId).filter((s) => !s.pinned)
}

async function doOpenFolderProject() {
  addProjectMenuOpen.value = false
  await actions.openFolderProject()
}

function openProjectDialog(mode) {
  addProjectMenuOpen.value = false
  panelUI.openProjectDialog(mode)
}

// ---- Context menu ----
const ctxMenu = reactive({ visible: false, x: 0, y: 0, session: null })

function openContextMenu(event, session) {
  ctxMenu.x = event.clientX
  ctxMenu.y = event.clientY
  ctxMenu.session = session
  ctxMenu.visible = true
}

function closeContextMenu() {
  ctxMenu.visible = false
  ctxMenu.session = null
}

function onCtxExport() {
  if (ctxMenu.session) sessionStore.exportSession(ctxMenu.session.id)
  closeContextMenu()
}

function onCtxRename() {
  if (!ctxMenu.session) return
  const session = ctxMenu.session
  closeContextMenu()
  startRename(session)
}

function onCtxPin() {
  if (ctxMenu.session) sessionStore.togglePinSession(ctxMenu.session.id)
  closeContextMenu()
}

function onCtxArchive() {
  if (ctxMenu.session) {
    actions.selectSession(ctxMenu.session.id)
    actions.archiveActiveSession()
  }
  closeContextMenu()
}

function onCtxDelete() {
  if (ctxMenu.session) actions.deleteSession(ctxMenu.session.id)
  closeContextMenu()
}

// ---- Project context menu & settings ----
const projectCtxMenu = ref(null)

function openProjectContextMenu(event, project) {
  projectCtxMenu.value = { projectId: project.id, x: event.clientX, y: event.clientY }
}

function handleProjectSettings(projectId) {
  const boardStore = useBoardStore()
  projectCtxMenu.value = null
  panelUI.showProjectHome(projectId, 'settings')
  boardStore.viewMode = 'settings'
}

async function handleProjectReveal(projectId) {
  const project = projStore.projects.find((p) => p.id === projectId)
  projectCtxMenu.value = null
  if (!project?.workspacePath || !isTauri) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('reveal_in_finder', { path: project.workspacePath })
  } catch {}
}

async function handleProjectRemove(projectId) {
  const project = projStore.projects.find((p) => p.id === projectId)
  projectCtxMenu.value = null
  if (!project || projectId === 'general') return
  if (isTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog')
    const confirmed = await ask(
      `Remove "${project.name}" from the sidebar? Sessions will be moved to Personal. The folder will not be deleted.`,
      { title: 'Remove Project', kind: 'warning', okLabel: 'Remove', cancelLabel: 'Cancel' }
    )
    if (!confirmed) return
  } else if (!window.confirm(`Remove "${project.name}" from the sidebar?`)) {
    return
  }
  await actions.removeProject(projectId)
}

const KEEP_STATUSES = new Set(['working', 'needs-approval', 'awaiting-review'])

function projectHasCleanableSessions(projectId) {
  return sessionStore.sessions.some(
    (s) => !s.archived && s.projectId === projectId && !KEEP_STATUSES.has(statusKind(s))
  )
}

function handleProjectCleanup(projectId) {
  projectCtxMenu.value = null
  actions.cleanUpProject(projectId)
}

function onUndoArchive() {
  actions.undoArchive()
}
</script>

<style scoped>
/* ---- Sidebar shell ---- */
.sb {
  position: relative; flex-shrink: 0;
  height: 100%;
  background: var(--color-chrome);
  padding: 8px;
  display: flex; flex-direction: column; gap: 1px;
  overflow: hidden auto;
}

.sb::-webkit-scrollbar { width: 4px; }
.sb::-webkit-scrollbar-track { background: transparent; }
.sb::-webkit-scrollbar-thumb { background: var(--color-rule); border-radius: 2px; }

.sb-resize-handle {
  position: absolute;
  top: 0; right: -6px;
  width: 12px; height: 100%;
  cursor: col-resize; z-index: 5;
}
.sb-resize-handle::after {
  content: '';
  position: absolute; top: 0; left: 5px;
  width: 2px; height: 100%;
  border-radius: 1px;
  background: transparent;
  transition: background 150ms;
}
.sb-resize-handle:hover::after,
.sb-resize-dragging::after { background: var(--color-accent); }

/* ---- Search toolbar ---- */
.sb-top-row {
  display: flex; align-items: center; gap: 4px;
  margin-bottom: 12px;
}
.sb-toolbar {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--color-chrome-mid);
}
.sb-toolbar:focus-within {
  background: var(--color-surface);
  box-shadow: 0 0 0 1px var(--color-rule);
}
.sb-toolbar-search-icon {
  color: var(--color-ink-3); flex-shrink: 0;
}
.sb-toolbar:focus-within .sb-toolbar-search-icon {
  color: var(--color-ink-3);
}
.sb-collapse-btn { flex-shrink: 0; }
.sb-search-input {
  flex: 1; min-width: 0; height: 22px;
  border: 0; background: transparent; outline: none;
  font-family: var(--font-sans); font-size: 12px;
  color: var(--color-ink);
}
.sb-search-input::placeholder { color: var(--color-ink-3); }
.sb-search-input::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
.sb-icon-btn {
  width: 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--color-ink-3);
}
.sb-icon-btn:hover { background: var(--color-chrome-mid); color: var(--color-ink); }

.project-add-menu {
  position: absolute; z-index: 20; top: calc(100% + 4px); right: 0;
  min-width: 178px; padding: 4px;
  background: var(--color-chrome-mid);
  border: 1px solid var(--color-rule);
  border-radius: 6px;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
}
.project-add-menu button {
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 28px; padding: 0 8px;
  border-radius: 4px; color: var(--color-ink-2);
  font-family: var(--font-sans); font-size: 12px; text-align: left;
}
.project-add-menu button:hover { background: var(--color-chrome-high); color: var(--color-ink); }

/* ---- Pinned area ---- */
.sb-pinned-area {
  display: flex; flex-direction: column; gap: 1px;
  padding-bottom: 6px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--color-rule-light);
}

/* ---- Projects ---- */
.sb-projects { flex: 1; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }

.project-group + .project-group { margin-top: 10px; }

.project-toggle {
  display: flex; align-items: center; gap: 0;
  width: 100%; height: 28px; padding: 0 6px;
  font-size: 13px; font-weight: 500; color: var(--color-ink);
  text-align: left;
}
.project-folder-btn {
  width: 22px; height: 22px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--color-ink-3); flex-shrink: 0;
  margin-right: 4px;
}
.project-folder-btn:hover { background: var(--color-chrome-mid); color: var(--color-ink-2); }
.project-name-btn {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: left; padding: 2px 4px; border-radius: 4px;
  font: inherit; color: inherit;
}
.project-name-btn:hover { background: var(--color-chrome-mid); }
.project-name {
  flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.project-btn {
  width: 20px; height: 20px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--color-ink-3); opacity: 0; flex-shrink: 0;
}
.project-toggle:hover .project-btn { opacity: 1; }
.project-btn:hover { background: var(--color-chrome-high); color: var(--color-ink-2); }

/* ---- Drag and drop ---- */
.drop-indicator {
  height: 2px; margin: 0 6px;
  background: var(--color-accent);
  border-radius: 1px;
}
.session-row.is-dragging {
  opacity: 0.35;
}

/* ---- Session rows ---- */
.session-row {
  display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 6px 0 14px;
  border-radius: 6px;
  font-size: 12px; color: var(--color-ink-2);
  text-align: left;
}
.session-row:hover { background: var(--color-chrome-mid); }
.session-row.active { background: var(--color-accent-tint); color: var(--color-ink); }
.session-row.is-attention { background: var(--color-accent-soft); }
.session-row.is-attention:hover { background: var(--color-accent-tint); }
.session-row.is-error { background: rgba(200, 60, 48, 0.04); }
.session-row.is-error:hover { background: rgba(200, 60, 48, 0.07); }
.session-row.is-unread .session-label { font-weight: 500; color: var(--color-ink); }

.session-label {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 400;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---- Status tags ---- */
.session-tag {
  display: flex; align-items: center; gap: 5px;
  font-size: 10px;
  font-family: var(--font-mono);
  flex-shrink: 0; white-space: nowrap;
}
.tag-working { color: var(--color-ink-3); }
.tag-needs-approval { color: var(--color-accent); font-weight: 500; }
.tag-awaiting-review { color: var(--color-ink-2); }
.tag-error { color: var(--color-accent); }
.tag-done {
  color: var(--color-ink-3);
  animation: tag-done 2s ease-out forwards;
}
@keyframes tag-done {
  0%, 85% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(3px); }
}

/* ---- Inline rename ---- */
.session-rename-input {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 400;
  color: var(--color-ink);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-accent);
  outline: none; padding: 0;
  font-family: inherit;
}

/* ---- Undo toast ---- */
.sb-undo-toast {
  position: absolute; bottom: 48px; left: 8px; right: 8px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  background: var(--color-ink); color: var(--color-surface);
  border-radius: 6px;
  font-family: var(--font-sans); font-size: 12px;
  z-index: 50;
  box-shadow: 0 4px 16px rgba(0,0,0,.24);
}
.sb-undo-toast button { color: var(--color-accent); font-weight: 500; font-size: 12px; }
.sb-undo-toast button:hover { opacity: 0.8; }
.toast-fade-enter-active,
.toast-fade-leave-active { transition: opacity 200ms ease, transform 200ms ease; }
.toast-fade-enter-from,
.toast-fade-leave-to { opacity: 0; transform: translateY(8px); }

/* ---- Search results ---- */
.search-result-row {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 10px 6px 18px;
  border-radius: 6px; text-align: left;
}
.search-result-row:hover { background: var(--color-chrome-mid); }
.search-result-excerpt {
  font-size: 11px; color: var(--color-ink-3); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word;
}
.search-result-excerpt :deep(mark) {
  background: var(--color-accent-tint); color: var(--color-ink);
  border-radius: 2px; padding: 0 1px;
}
</style>
