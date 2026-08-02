<template>
  <section
    data-files-activity
    class="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    aria-label="Files"
    @keydown.capture="onCommandKeydown"
  >
    <header class="flex h-10 shrink-0 items-end border-b border-rule bg-chrome-high px-2">
      <nav class="flex h-full min-w-0 flex-1 items-end" aria-label="Files view">
        <button
          v-for="option in views"
          :key="option.id"
          type="button"
          :data-files-mode="option.id"
          :aria-current="viewMode === option.id ? 'page' : undefined"
          class="relative flex h-full items-center gap-1.5 px-2 text-[11px] font-medium text-ink-3 outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          :class="{ 'text-ink': viewMode === option.id }"
          @click="setViewMode(option.id)"
        >
          <component :is="option.icon" :size="13" :stroke-width="1.75" />
          <span>{{ option.label }}</span>
          <span
            v-if="option.id === 'favorites' && favorites.length"
            class="font-mono text-[9px] tabular-nums text-ink-4"
          >
            {{ favorites.length }}
          </span>
          <span
            v-if="viewMode === option.id"
            aria-hidden="true"
            class="absolute inset-x-2 bottom-0 h-0.5 bg-accent"
          />
        </button>
      </nav>

      <button
        type="button"
        data-files-new-file
        title="New file (⌘N)"
        aria-label="New file"
        class="mb-1.5 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="promptNew('file')"
      >
        <IconFilePlus :size="14" :stroke-width="1.75" />
      </button>
      <button
        type="button"
        data-files-new-folder
        title="New folder (⇧⌘N)"
        aria-label="New folder"
        class="mb-1.5 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="promptNew('folder')"
      >
        <IconFolderPlus :size="14" :stroke-width="1.75" />
      </button>
      <button
        type="button"
        data-files-refresh
        title="Refresh workspace (⌘R)"
        aria-label="Refresh workspace"
        :disabled="refreshing"
        class="mb-1.5 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="refresh"
      >
        <IconRefresh
          :size="14"
          :stroke-width="1.75"
          :class="{ 'motion-safe:animate-spin': refreshing }"
        />
      </button>
    </header>

    <label
      v-if="files.workspacePath"
      class="mx-2 my-2 flex h-8 shrink-0 items-center gap-2 border border-rule-light bg-chrome-high px-2 focus-within:border-accent/60"
    >
      <IconSearch :size="13" :stroke-width="1.8" class="shrink-0 text-ink-4" />
      <input
        ref="queryInput"
        v-model="query"
        data-files-search
        type="search"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        :placeholder="searchPlaceholder"
        class="h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-4"
        @input="onQueryInput"
        @keydown.down.prevent="focusList(1)"
        @keydown.up.prevent="focusList(-1)"
        @keydown.esc.prevent="clearQuery"
      />
      <kbd v-if="!query" class="font-mono text-[9px] text-ink-4">⌘F</kbd>
      <button
        v-else
        type="button"
        title="Clear filter"
        aria-label="Clear filter"
        class="grid size-5 place-items-center text-ink-4 hover:text-ink"
        @click="clearQuery"
      >
        <IconX :size="12" :stroke-width="1.8" />
      </button>
    </label>

    <div
      v-if="files.workspacePath"
      ref="listRef"
      data-files-list
      role="tree"
      aria-label="Workspace files"
      aria-multiselectable="true"
      tabindex="0"
      :data-files-drop-root="rootDropActive ? '' : undefined"
      class="scrollbar-thin min-h-0 flex-1 overflow-auto bg-surface outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :class="{ 'ring-1 ring-inset ring-accent': rootDropActive }"
      @keydown="onListKeydown"
      @contextmenu="openEmptyContextMenu"
      @scroll.passive="onListScroll"
      @pointerdown="onRowPointerDown"
    >
      <div
        v-if="isLoading"
        data-files-loading
        class="grid h-40 place-items-center px-8 text-center"
      >
        <div>
          <span class="mx-auto block h-px w-20 overflow-hidden bg-rule">
            <span class="block h-full w-1/2 bg-accent motion-safe:animate-pulse" />
          </span>
          <p class="mt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
            Indexing workspace
          </p>
        </div>
      </div>

      <div
        v-else-if="surfaceError"
        data-files-error
        role="alert"
        class="grid h-52 place-items-center px-8 text-center"
      >
        <div class="max-w-sm">
          <IconAlertTriangle :size="21" :stroke-width="1.5" class="mx-auto text-rem" />
          <p class="mt-3 text-[12px] font-semibold">Files could not be loaded</p>
          <p class="mt-1 break-words text-[10px] leading-relaxed text-ink-3">{{ surfaceError }}</p>
          <button
            type="button"
            data-files-retry
            class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            @click="refresh"
          >
            Try again
          </button>
        </div>
      </div>

      <template v-else>
        <template v-for="item in renderPlan" :key="item.key">
          <div
            v-if="item.spacer"
            data-files-spacer
            role="presentation"
            aria-hidden="true"
            :style="{ height: `${item.height}px` }"
          />
          <FileTreeRow
            v-else
            :row="item.row"
            :selected="selectedPaths.has(item.row.entry.path)"
            :active="isActive(item.row.entry)"
            :ancestry="isActiveAncestry(item.row.entry)"
            :favorite="isFavorite(item.row.entry)"
            :drop-target="dropHighlightPath === item.row.entry.path"
            :drag-source="treeDragging && draggedPaths.has(item.row.entry.path)"
            :editing="isEditing(item.row)"
            :edit-kind="nameAction?.kind"
            :edit-draft="nameDraft"
            @select="onRowSelect(item.row, item.index, $event)"
            @activate="onRowActivate(item.row)"
            @toggle="onRowToggle(item.row, item.index)"
            @favorite="toggleFavorite(item.row.entry)"
            @context="openContextMenu"
            @update:edit-draft="nameDraft = $event"
            @commit-edit="commitNameAction"
            @cancel-edit="cancelNameAction"
          />
        </template>

        <div
          v-if="!renderedRows.length"
          data-files-empty
          class="grid min-h-48 place-items-center px-8 py-8 text-center"
          @contextmenu="openEmptyContextMenu"
        >
          <div class="max-w-xs">
            <IconStar
              v-if="viewMode === 'favorites'"
              :size="22"
              :stroke-width="1.5"
              class="mx-auto text-ink-3"
            />
            <IconHistory
              v-else-if="viewMode === 'recent'"
              :size="22"
              :stroke-width="1.5"
              class="mx-auto text-ink-3"
            />
            <IconFolderOpen
              v-else
              :size="22"
              :stroke-width="1.5"
              class="mx-auto text-ink-3"
            />
            <p class="mt-3 text-[12px] font-semibold">{{ emptyTitle }}</p>
            <p class="mt-1 text-[10px] leading-relaxed text-ink-3">{{ emptyBody }}</p>
            <button
              v-if="viewMode === 'project' && !query"
              type="button"
              class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="promptNew('file')"
            >
              Create a file
            </button>
          </div>
        </div>
      </template>
    </div>

    <div v-else class="grid min-h-0 flex-1 place-items-center px-8 text-center">
      <div>
        <IconFolderOpen :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
        <p class="mt-3 text-[12px] font-semibold">Open a workspace</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          Browse, favorite, and preview its files without leaving Mimir.
        </p>
        <button
          type="button"
          data-files-choose-workspace
          class="mt-4 h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          @click="$emit('chooseWorkspace')"
        >
          Choose folder
        </button>
      </div>
    </div>

    <footer
      v-if="files.workspacePath"
      class="flex h-7 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3 font-mono text-[9px] text-ink-4"
    >
      <span>{{ selectedPaths.size ? `${selectedPaths.size} selected` : `${visibleRows.length} visible` }}</span>
      <span v-if="importing" data-files-importing class="text-accent">Adding dropped items…</span>
      <span v-else-if="gitChanges.length" class="text-accent">
        {{ gitChanges.length }} changed
      </span>
      <button
        v-if="viewMode === 'project' && files.expandedDirectories.size"
        type="button"
        class="ml-auto text-ink-4 hover:text-ink"
        @click="collapseAll"
      >
        Collapse all
      </button>
      <span v-else class="ml-auto truncate">{{ workspaceName }}</span>
    </footer>

    <div
      v-if="operationError || operationNotice"
      class="absolute inset-x-2 bottom-9 z-30 flex flex-col gap-1"
    >
      <div
        v-if="operationNotice"
        data-files-operation-notice
        role="status"
        class="flex items-start gap-2 border border-rule bg-surface px-3 py-2 text-[10px] text-ink-2 shadow-lg"
      >
        <span class="min-w-0 flex-1">{{ operationNotice }}</span>
        <button
          type="button"
          title="Dismiss"
          class="grid size-5 shrink-0 place-items-center hover:bg-chrome"
          @click="operationNotice = ''"
        >
          <IconX :size="12" :stroke-width="1.8" />
        </button>
      </div>
      <div
        v-if="operationError"
        data-files-operation-error
        role="alert"
        class="flex items-start gap-2 border border-rem/30 bg-surface px-3 py-2 text-[10px] text-rem shadow-lg"
      >
        <span class="min-w-0 flex-1">{{ operationError }}</span>
        <button
          type="button"
          title="Dismiss"
          class="grid size-5 shrink-0 place-items-center hover:bg-chrome"
          @click="operationError = ''"
        >
          <IconX :size="12" :stroke-width="1.8" />
        </button>
      </div>
    </div>

    <div
      v-if="contextEntry || emptyContext"
      class="fixed inset-0 z-[260]"
      @pointerdown.self="closeContextMenu"
      @contextmenu.prevent.self="closeContextMenu"
    >
      <div
        ref="contextMenuRef"
        data-files-context-menu
        role="menu"
        tabindex="-1"
        class="fixed min-w-52 border border-rule bg-surface py-1 text-[11px] text-ink-2 shadow-lg"
        :style="contextStyle"
        @pointerdown.stop
        @keydown="onContextMenuKeydown"
      >
        <template v-if="emptyContext">
          <ContextAction label="New file" action="new-file" @select="promptNew('file')" />
          <ContextAction label="New folder" action="new-folder" @select="promptNew('folder')" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Refresh workspace" action="refresh" @select="refreshFromMenu" />
          <ContextAction label="Collapse all folders" action="collapse-all" @select="collapseAllFromMenu" />
        </template>
        <template v-else-if="contextEntry">
          <ContextAction
            :label="contextEntry.isDirectory ? 'Expand or collapse' : 'Open in Mimir'"
            action="open"
            @select="activateContextEntry"
          />
          <ContextAction
            v-if="!contextEntry.isDirectory"
            label="Open in default app"
            action="open-native"
            @select="openContextNative"
          />
          <ContextAction
            :label="isFavorite(contextEntry) ? 'Remove from Favorites' : 'Add to Favorites'"
            action="favorite"
            @select="favoriteContextEntry"
          />
          <template v-if="contextEntry.isDirectory">
            <div class="my-1 border-t border-rule-light" />
            <ContextAction label="New file inside" action="new-file-inside" @select="promptNewInside('file')" />
            <ContextAction label="New folder inside" action="new-folder-inside" @select="promptNewInside('folder')" />
          </template>
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Rename" action="rename" shortcut="F2" @select="promptRenameContext" />
          <ContextAction label="Duplicate" action="duplicate" @select="duplicateContext" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Reveal in Finder" action="reveal" @select="revealContext" />
          <ContextAction label="Copy path" action="copy-path" @select="copyContextPath(false)" />
          <ContextAction label="Copy relative path" action="copy-relative-path" @select="copyContextPath(true)" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Move to Trash…" action="trash" shortcut="⌘⌫" danger @select="promptDelete(selectedEntries())" />
        </template>
      </div>
    </div>

    <div
      v-if="deleteEntries.length"
      data-files-delete-dialog
      class="fixed inset-0 z-[270] grid place-items-center bg-black/25 px-4"
      @pointerdown.self="closeDeleteDialog"
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-label="Move items to Trash"
        class="w-full max-w-sm border border-rule bg-surface shadow-xl"
      >
        <header class="flex h-10 items-center border-b border-rule bg-chrome-high px-4">
          <h2 class="text-[12px] font-semibold">
            {{ deleteEntries.length === 1 ? `Move ${deleteEntries[0].name} to Trash?` : `Move ${deleteEntries.length} items to Trash?` }}
          </h2>
        </header>
        <div class="space-y-3 p-4">
          <p class="text-[11px] leading-relaxed text-ink-2">
            The selection moves to the system Trash and can be restored there.
          </p>
          <p v-if="deleteError" class="text-[10px] leading-relaxed text-rem">{{ deleteError }}</p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome"
              @click="closeDeleteDialog"
            >
              Cancel
            </button>
            <button
              type="button"
              data-files-confirm-delete
              :disabled="operationBusy"
              class="h-7 bg-rem px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              @click="confirmDelete"
            >
              {{ operationBusy ? 'Moving…' : 'Move to Trash' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <div
      v-if="treeDragging"
      data-files-drag-ghost
      aria-hidden="true"
      class="pointer-events-none fixed z-[280] flex h-6 max-w-56 items-center border border-rule bg-surface px-2 shadow-lg"
      :style="{ left: `${dragPointer.x + 12}px`, top: `${dragPointer.y + 14}px` }"
    >
      <span class="truncate text-[11px] text-ink">{{ dragLabel }}</span>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconClock,
  IconFilePlus,
  IconFolderOpen,
  IconFolderPlus,
  IconHistory,
  IconRefresh,
  IconSearch,
  IconStar,
  IconX,
} from '@tabler/icons-vue'
import FileTreeRow from '../components/FileTreeRow.vue'
import { useFileStore } from '../../stores/files.js'
import { useSettingsStore } from '../../stores/settings.js'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import { loadGitChanges } from '../../services/gitChanges.js'
import {
  describeFileError as describeError,
  inferOpenBehavior,
  joinRelative,
  normalizePath,
  normalizeRelative,
  parentDirectory,
} from '../files/filePaths.js'
import { useFileContextMenu } from '../files/useFileContextMenu.js'
import { useFileDrop } from '../files/useFileDrop.js'
import { useFileFavorites } from '../files/useFileFavorites.js'
import { useFileMutations } from '../files/useFileMutations.js'
import { useFileSelection } from '../files/useFileSelection.js'
import { useFileTreeDrag } from '../files/useFileTreeDrag.js'
import { importWorkspaceEntries } from '../../services/workspaceFileOperations.js'
import { basename } from '../../shared/utils/path.js'

const ContextAction = defineComponent({
  props: {
    label: { type: String, required: true },
    action: { type: String, required: true },
    shortcut: { type: String, default: '' },
    danger: { type: Boolean, default: false },
  },
  emits: ['select'],
  setup(props, { emit }) {
    return () => h('button', {
      type: 'button',
      role: 'menuitem',
      'data-file-action': props.action,
      class: [
        'flex h-7 w-full items-center gap-4 px-3 text-left hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
        props.danger ? 'text-rem' : 'text-ink-2',
      ],
      onClick: () => emit('select'),
    }, [
      h('span', { class: 'min-w-0 flex-1 truncate' }, props.label),
      props.shortcut ? h('span', { class: 'font-mono text-[8px] text-ink-4' }, props.shortcut) : null,
    ])
  },
})

const props = defineProps({
  activity: { type: Object, required: true },
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['openFile', 'chooseWorkspace'])
const files = useWorkspaceFilesStore()
const editorFiles = useFileStore()
const settings = useSettingsStore()
const viewMode = ref('project')
const query = ref('')
const queryInput = ref(null)
const listRef = ref(null)
const contextMenuRef = ref(null)
const gitChanges = ref([])
let queryTimer = null

const SEARCH_DEBOUNCE_MS = 130
// Windowed rendering: only trees larger than this render behind spacers.
const VIRTUALIZE_AT = 300
const OVERSCAN_ROWS = 20
const ROW_HEIGHT = 28 // FileTreeRow h-7
const SECONDARY_ROW_HEIGHT = 36 // FileTreeRow h-9
const scrollTop = ref(0)
const viewportHeight = ref(0)

const views = Object.freeze([
  { id: 'project', label: 'Project', icon: IconFolderOpen },
  { id: 'recent', label: 'Recent', icon: IconClock },
  { id: 'favorites', label: 'Favorites', icon: IconStar },
])

const workspaceName = computed(() => basename(files.workspacePath) || 'workspace')
const {
  favorites,
  isFavorite,
  toggleFavorite,
  updateFavoritePaths,
} = useFileFavorites({
  settings,
  workspacePath: computed(() => files.workspacePath),
})
const indexedByPath = computed(() => new Map(
  files.files.map((entry) => [normalizePath(entry.path), normalizeEntry(entry)]),
))
// Only the Favorites view resolves entries by relative path; skip the full
// tree flatten (every loaded directory) for the Project and Recent views.
const loadedByRelativePath = computed(() => {
  if (viewMode.value !== 'favorites') return new Map()
  const map = new Map()
  for (const entries of Object.values(files.treeChildren)) {
    for (const entry of entries) {
      map.set(normalizeRelative(entry.relativePath), normalizeEntry(entry))
    }
  }
  return map
})
const gitByPath = computed(() => new Map(
  gitChanges.value.map((change) => [normalizeRelative(change.path), change.status]),
))
// Directory badge lookup precomputed once per git refresh: each changed file
// walks up its ancestors, first change (in gitChanges order) wins — the same
// status the previous per-row prefix scan displayed.
const gitDirectoryStatus = computed(() => {
  const statuses = new Map()
  for (const [path, status] of gitByPath.value) {
    let parent = path
    let cut = parent.lastIndexOf('/')
    while (cut > 0) {
      parent = parent.slice(0, cut)
      if (statuses.has(parent)) break
      statuses.set(parent, status)
      cut = parent.lastIndexOf('/')
    }
  }
  return statuses
})
const activePath = computed(() => normalizePath(editorFiles.currentFile?.path))

const visibleRows = computed(() => {
  if (viewMode.value === 'recent') return recentRows()
  if (viewMode.value === 'favorites') return favoriteRows()
  if (query.value.trim()) return searchRows()
  const rows = []
  flattenDirectory('', 0, rows)
  return rows
})

const {
  clearSelection,
  focusList,
  focusParent,
  focusedIndex,
  moveFocus,
  resetSelection,
  selectedDirectory,
  selectedEntries,
  selectedPaths,
  selectRow,
} = useFileSelection({
  visibleRows,
  listRef,
  activateRow,
  closeContextMenu: () => closeContextMenu(),
})

const {
  closeContextMenu,
  contextEntry,
  contextStyle,
  emptyContext,
  onContextMenuKeydown,
  onDocumentPointerDown,
  openContextMenu,
  openEmptyContextMenu,
  openKeyboardContextMenu,
} = useFileContextMenu({
  visibleRows,
  focusedIndex,
  selectedPaths,
  listRef,
  contextMenuRef,
})

const {
  cancelNameAction,
  closeDeleteDialog,
  commitNameAction,
  confirmDelete,
  copyContextPath,
  deleteEntries,
  deleteError,
  duplicateContext,
  isEditing,
  moveEntries,
  nameAction,
  nameDraft,
  openContextNative,
  operationBusy,
  operationError,
  operationNotice,
  promptDelete,
  promptNew,
  promptNewInside,
  promptRename,
  promptRenameContext,
  reconcileMutationDirectories,
  refresh,
  refreshing,
  revealContext,
} = useFileMutations({
  files,
  editorFiles,
  listRef,
  contextEntry,
  selectedDirectory,
  closeContextMenu,
  clearSelection,
  updateFavoritePaths,
  refreshGit,
  emitOpenFile: payload => emit('openFile', payload),
})

const { dropTarget, importing } = useFileDrop({
  listRef,
  rows: () => renderedRows.value,
  acceptsDrop: () => Boolean(files.workspacePath),
  importPaths: importDroppedPaths,
  springOpen: expandDirectory,
})

// Rearranging rows inside the tree; only the plain Project tree offers it —
// filtered, Recent, and Favorites rows are projections whose position says
// nothing about where a drop would land.
const {
  dragging: treeDragging,
  draggedPaths,
  dropTarget: moveTarget,
  entries: dragCarried,
  pointer: dragPointer,
  suppressClick: dragSuppressClick,
  onPointerDown: onRowPointerDown,
} = useFileTreeDrag({
  listRef,
  rows: () => renderedRows.value,
  canDrag: () => viewMode.value === 'project' && !query.value.trim()
    && !nameAction.value && !operationBusy.value && !importing.value,
  dragEntries: row => (
    selectedPaths.value.has(row.entry.path) ? selectedEntries() : [row.entry]
  ),
  onMove: moveDraggedEntries,
  springOpen: expandDirectory,
})
const dragLabel = computed(() => (
  dragCarried.value.length === 1
    ? dragCarried.value[0].name
    : `${dragCarried.value.length} items`
))
// External drops and internal drags never overlap: one is an OS drag the
// webview never owns, the other exists only while the pointer is held down.
const dropHighlightPath = computed(() => (
  dropTarget.value?.highlightPath || moveTarget.value?.highlightPath || ''
))
// Marks the panel itself when the drop lands in the workspace root, where
// there is no row to highlight.
const rootDropActive = computed(() => {
  const target = dropTarget.value || moveTarget.value
  return Boolean(target) && !target.highlightPath
})

const renderedRows = computed(() => {
  const rows = [...visibleRows.value]
  if (!nameAction.value || nameAction.value.renamePath) return rows
  const parent = normalizeRelative(nameAction.value.parent)
  const parentIndex = parent
    ? rows.findIndex((row) => normalizeRelative(row.entry.relativePath) === parent)
    : -1
  const depth = parentIndex >= 0 ? rows[parentIndex].depth + 1 : 0
  const row = makeRow({
    path: `__create__:${nameAction.value.kind}:${parent}`,
    relativePath: joinRelative(parent, nameDraft.value || ''),
    name: nameDraft.value || '',
    isDirectory: nameAction.value.kind === 'folder',
    textReadable: nameAction.value.kind !== 'folder',
    openBehavior: nameAction.value.kind === 'folder' ? 'directory' : 'text',
  }, depth, { editing: true })
  rows.splice(parentIndex + 1, 0, row)
  return rows
})

const rowOffsets = computed(() => {
  const rows = renderedRows.value
  const offsets = new Array(rows.length + 1)
  offsets[0] = 0
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index]
      + (rows[index].secondary ? SECONDARY_ROW_HEIGHT : ROW_HEIGHT)
  }
  return offsets
})

const windowRange = computed(() => {
  const rows = renderedRows.value
  const offsets = rowOffsets.value
  const top = scrollTop.value
  const bottom = top + Math.max(viewportHeight.value, 1)
  const start = Math.max(rowIndexAt(offsets, top) - OVERSCAN_ROWS, 0)
  const end = Math.min(rowIndexAt(offsets, bottom) + 1 + OVERSCAN_ROWS, rows.length)
  return { start, end }
})

// Small trees render every row exactly as before; large trees render only the
// scroll window (plus overscan) between spacers that keep scroll geometry.
// The keyboard-focused row always stays mounted so focus and roving keyboard
// navigation survive, wherever the window sits.
const renderPlan = computed(() => {
  const rows = renderedRows.value
  if (rows.length <= VIRTUALIZE_AT) {
    return rows.map((row, index) => ({ key: row.key, row, index }))
  }
  const offsets = rowOffsets.value
  const { start, end } = windowRange.value
  const focus = Math.min(Math.max(focusedIndex.value, 0), rows.length - 1)
  const plan = []
  const pushRow = (index) => plan.push({ key: rows[index].key, row: rows[index], index })
  const pushSpacer = (from, to, key) => {
    if (to > from) plan.push({ key, spacer: true, height: offsets[to] - offsets[from] })
  }
  if (focus < start) {
    pushSpacer(0, focus, 'spacer-lead')
    pushRow(focus)
    pushSpacer(focus + 1, start, 'spacer-top')
  } else {
    pushSpacer(0, start, 'spacer-top')
  }
  for (let index = start; index < end; index += 1) pushRow(index)
  if (focus >= end) {
    pushSpacer(end, focus, 'spacer-bottom')
    pushRow(focus)
    pushSpacer(focus + 1, rows.length, 'spacer-tail')
  } else {
    pushSpacer(end, rows.length, 'spacer-bottom')
  }
  return plan
})

function rowIndexAt(offsets, y) {
  let low = 0
  let high = Math.max(offsets.length - 2, 0)
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid] <= y) low = mid
    else high = mid - 1
  }
  return low
}

function onListScroll() {
  const list = listRef.value
  if (!list) return
  scrollTop.value = list.scrollTop
  viewportHeight.value = list.clientHeight
}

const listResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => onListScroll())
  : null

watch(listRef, (element, previous) => {
  if (previous) listResizeObserver?.unobserve(previous)
  if (element) {
    listResizeObserver?.observe(element)
    onListScroll()
  }
}, { flush: 'post' })

const isLoading = computed(() => files.loading || (
  viewMode.value === 'project'
  && !query.value.trim()
  && !Object.prototype.hasOwnProperty.call(files.treeChildren, '')
))
const surfaceError = computed(() => files.error || files.treeErrors[''] || '')
const searchPlaceholder = computed(() => ({
  project: 'Filter project files',
  recent: 'Filter recent files',
  favorites: 'Filter favorites',
}[viewMode.value]))
const emptyTitle = computed(() => {
  if (query.value.trim()) return 'No matching files'
  if (viewMode.value === 'favorites') return 'No favorites yet'
  if (viewMode.value === 'recent') return 'No recent files'
  return 'This workspace is empty'
})
const emptyBody = computed(() => {
  if (query.value.trim()) return 'Try a shorter filename or path.'
  if (viewMode.value === 'favorites') return 'Star files or folders you return to often.'
  if (viewMode.value === 'recent') return 'Files you open in Mimir appear here.'
  return 'Create a file to start working here.'
})

watch(() => files.workspacePath, () => {
  resetSelection()
  if (files.workspacePath) void refreshGit()
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  if (files.workspacePath) void refreshGit()
})
onUnmounted(() => {
  clearTimeout(queryTimer)
  listResizeObserver?.disconnect()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

function normalizeEntry(entry) {
  const openBehavior = entry.openBehavior || (
    entry.isDirectory ? 'directory'
      : String(entry.name || '').toLowerCase().endsWith('.pdf') ? 'pdf'
        : entry.textReadable === false ? 'external' : 'text'
  )
  return { ...entry, openBehavior }
}

function makeRow(entry, depth, options = {}) {
  const normalized = normalizeEntry(entry)
  return {
    key: options.key || normalized.path,
    entry: normalized,
    depth,
    expanded: normalized.isDirectory && files.expandedDirectories.has(normalizeRelative(normalized.relativePath)),
    loading: normalized.isDirectory && files.treeLoadingPaths.has(normalizeRelative(normalized.relativePath)),
    gitStatus: gitStatusFor(normalized),
    secondary: Boolean(options.secondary),
    favoriteRoot: Boolean(options.favoriteRoot),
    missing: Boolean(options.missing),
    editing: Boolean(options.editing),
  }
}

function flattenDirectory(parent, depth, rows, seen = new Set()) {
  const key = normalizeRelative(parent)
  if (seen.has(key)) return
  seen.add(key)
  for (const entry of files.treeChildren[key] || []) {
    const row = makeRow(entry, depth)
    rows.push(row)
    if (entry.isDirectory && row.expanded) {
      flattenDirectory(entry.relativePath, depth + 1, rows, seen)
    }
  }
}

function searchRows() {
  return files.visibleFiles.map((entry) => makeRow(entry, 0, { secondary: true }))
}

function recentRows() {
  const needle = query.value.trim().toLowerCase()
  return editorFiles.recentFiles
    .map((path) => indexedByPath.value.get(normalizePath(path)) || fallbackFileEntry(path))
    .filter((entry) => matchesEntry(entry, needle))
    .map((entry) => makeRow(entry, 0, { secondary: true, missing: !indexedByPath.value.has(normalizePath(entry.path)) }))
}

function favoriteRows() {
  const needle = query.value.trim().toLowerCase()
  const rows = []
  for (const record of favorites.value) {
    const entry = resolveFavorite(record)
    if (needle && !matchesEntry(entry, needle)) continue
    const row = makeRow(entry, 0, {
      favoriteRoot: true,
      secondary: true,
      missing: Boolean(entry.missing),
      key: `favorite:${record.relativePath}`,
    })
    rows.push(row)
    if (!needle && entry.isDirectory && row.expanded && !entry.missing) {
      flattenDirectory(entry.relativePath, 1, rows)
    }
  }
  return rows
}

function resolveFavorite(record) {
  const relativePath = normalizeRelative(record.relativePath)
  const loaded = loadedByRelativePath.value.get(relativePath)
  if (loaded) return loaded
  const absolute = absolutePath(relativePath)
  const indexed = indexedByPath.value.get(normalizePath(absolute))
  if (indexed) return indexed
  const parent = parentDirectory(relativePath)
  const parentLoaded = Object.prototype.hasOwnProperty.call(files.treeChildren, parent)
  return normalizeEntry({
    path: absolute,
    relativePath,
    name: basename(relativePath),
    isDirectory: record.isDirectory,
    textReadable: record.isDirectory ? false : undefined,
    openBehavior: record.isDirectory ? 'directory' : inferOpenBehavior(relativePath),
    missing: parentLoaded,
  })
}

function fallbackFileEntry(path) {
  const relativePath = relativeFromAbsolute(path)
  return normalizeEntry({
    path,
    relativePath,
    name: basename(path),
    isDirectory: false,
    textReadable: inferOpenBehavior(path) === 'text',
    openBehavior: inferOpenBehavior(path),
  })
}

function setViewMode(mode) {
  viewMode.value = mode
  query.value = ''
  void files.setQuery('')
  clearSelection()
  nextTick(() => listRef.value?.focus())
}

function onQueryInput() {
  clearTimeout(queryTimer)
  if (viewMode.value !== 'project') return
  queryTimer = setTimeout(async () => {
    try {
      await files.setQuery(query.value)
      focusedIndex.value = 0
      selectedPaths.value = new Set()
    } catch (error) {
      operationError.value = describeError(error, 'File filter failed')
    }
  }, SEARCH_DEBOUNCE_MS)
}

function clearQuery() {
  clearTimeout(queryTimer)
  query.value = ''
  void files.setQuery('')
  focusedIndex.value = 0
  selectedPaths.value = new Set()
  queryInput.value?.focus()
}

function onCommandKeydown(event) {
  const command = event.metaKey || event.ctrlKey
  if (!command) return
  const key = event.key.toLowerCase()
  if (key === 'n') {
    event.preventDefault()
    event.stopPropagation()
    promptNew(event.shiftKey ? 'folder' : 'file')
  } else if (key === 'f') {
    event.preventDefault()
    event.stopPropagation()
    queryInput.value?.focus()
    queryInput.value?.select()
  } else if (key === 'r') {
    event.preventDefault()
    event.stopPropagation()
    void refresh()
  } else if (key === 'arrowleft' && viewMode.value === 'project') {
    event.preventDefault()
    collapseAll()
  }
}

function onListKeydown(event) {
  if (event.defaultPrevented) return
  const command = event.metaKey || event.ctrlKey
  const row = visibleRows.value[focusedIndex.value]
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
  } else if (event.key === 'ArrowRight' && row?.entry.isDirectory) {
    event.preventDefault()
    if (!row.expanded) void toggleRow(row, focusedIndex.value)
    else moveFocus(1)
  } else if (event.key === 'ArrowLeft' && row?.entry.isDirectory) {
    event.preventDefault()
    if (row.expanded) void toggleRow(row, focusedIndex.value)
    else focusParent(row)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateFocused(false)
  } else if (event.key === ' ') {
    event.preventDefault()
    activateFocused(true)
  } else if (event.key === 'F2') {
    event.preventDefault()
    promptRename(row?.entry)
  } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    event.preventDefault()
    openKeyboardContextMenu()
  } else if ((event.key === 'Delete' || (event.key === 'Backspace' && command)) && selectedPaths.value.size) {
    event.preventDefault()
    promptDelete(selectedEntries())
  } else if (command && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    selectedPaths.value = new Set(visibleRows.value.map((item) => item.entry.path))
  } else if (event.key === 'Escape') {
    if (nameAction.value) cancelNameAction()
    else clearSelection()
  }
}

// The click released at the end of a drag must not also toggle or open the
// row it happened to end over.
function onRowSelect(row, index, event) {
  if (dragSuppressClick.value) return
  selectRow(row, index, event)
}

function onRowToggle(row, index) {
  if (dragSuppressClick.value) return
  void toggleRow(row, index)
}

function onRowActivate(row) {
  if (dragSuppressClick.value) return
  activateRow(row, false)
}

async function moveDraggedEntries(entries, destination) {
  const moved = await moveEntries(entries, destination)
  if (!moved.length) return
  await files.revealTreePath(destination)
  await expandDirectory(destination)
  selectArrivals(moved)
}

async function toggleRow(row, index = focusedIndex.value) {
  if (!row.entry.isDirectory || row.missing) return
  focusedIndex.value = Math.max(index, 0)
  selectedPaths.value = new Set([row.entry.path])
  try {
    await files.toggleDirectory(row.entry.relativePath)
  } catch (error) {
    operationError.value = describeError(error, 'Folder could not be opened')
  }
}

function activateRow(row, preview) {
  if (!row || row.missing) return
  if (row.entry.isDirectory) {
    void toggleRow(row)
    return
  }
  emit('openFile', { path: row.entry.path, preview, entry: row.entry })
}

function activateFocused(preview) {
  const row = visibleRows.value[focusedIndex.value]
  if (row) activateRow(row, preview)
}

async function expandDirectory(relativePath) {
  const directory = normalizeRelative(relativePath)
  if (!directory || files.expandedDirectories.has(directory)) return
  try {
    await files.toggleDirectory(directory)
  } catch (error) {
    operationError.value = describeError(error, 'Folder could not be opened')
  }
}

async function importDroppedPaths(destination, paths) {
  operationError.value = ''
  operationNotice.value = ''
  let report = null
  try {
    report = await importWorkspaceEntries(destination, paths)
  } catch (error) {
    operationError.value = describeError(error, 'Dropped items could not be added')
  }
  // Individual sources can fail after others have already landed, so the tree
  // is reconciled either way — never leave arrivals invisible behind an error.
  await files.revealTreePath(destination)
  await expandDirectory(destination)
  await reconcileMutationDirectories([destination])
  if (!report) return

  selectArrivals(report.entries || [])
  const failures = report.failures || []
  if (failures.length) {
    operationError.value = failures.length === 1
      ? failures[0]
      : `${failures.length} dropped items could not be added. ${failures[0]}`
  }
  const skipped = report.skippedLinks || 0
  if (skipped) {
    operationNotice.value = skipped === 1
      ? 'One symbolic link inside the drop was skipped.'
      : `${skipped} symbolic links inside the drop were skipped.`
  }
}

// Only what the current view actually shows: selecting rows that are not
// rendered would report a selection the user cannot see or act on.
function selectArrivals(entries) {
  if (!entries.length) return
  const arrived = new Set(entries.map((entry) => entry.path))
  const rows = visibleRows.value
  const index = rows.findIndex((row) => arrived.has(row.entry.path))
  if (index < 0) return
  selectedPaths.value = new Set(
    rows.filter((row) => arrived.has(row.entry.path)).map((row) => row.entry.path),
  )
  focusedIndex.value = index
}

async function refreshGit() {
  if (!files.workspacePath) {
    gitChanges.value = []
    return
  }
  try {
    gitChanges.value = await loadGitChanges(files.workspacePath)
  } catch {
    gitChanges.value = []
  }
}

function gitStatusFor(entry) {
  const relativePath = normalizeRelative(entry.relativePath)
  const exact = gitByPath.value.get(relativePath)
  if (exact) return exact
  if (!entry.isDirectory) return ''
  return gitDirectoryStatus.value.get(relativePath) || ''
}

function collapseAll() {
  files.collapseAllDirectories()
  focusedIndex.value = 0
}

function collapseAllFromMenu() {
  closeContextMenu()
  collapseAll()
}

function activateContextEntry() {
  const entry = contextEntry.value
  closeContextMenu()
  if (!entry) return
  const row = visibleRows.value.find((item) => item.entry.path === entry.path) || makeRow(entry, 0)
  activateRow(row, false)
}

function favoriteContextEntry() {
  const entry = contextEntry.value
  closeContextMenu()
  toggleFavorite(entry)
}

function refreshFromMenu() {
  closeContextMenu()
  void refresh()
}

function isActive(entry) {
  return Boolean(activePath.value) && normalizePath(entry.path) === activePath.value
}

function isActiveAncestry(entry) {
  if (!activePath.value || !entry.isDirectory) return false
  const path = normalizePath(entry.path).replace(/\/+$/, '')
  return activePath.value.startsWith(`${path}/`)
}

function matchesEntry(entry, needle) {
  if (!needle) return true
  return `${entry.name} ${entry.relativePath}`.toLowerCase().includes(needle)
}

function absolutePath(relativePath) {
  const root = String(files.workspacePath || '').replace(/[\\/]+$/, '')
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return relativePath ? `${root}${separator}${relativePath.replaceAll('/', separator)}` : root
}

function relativeFromAbsolute(path) {
  const root = normalizePath(files.workspacePath).replace(/\/+$/, '')
  const candidate = normalizePath(path)
  return candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : basename(path)
}

</script>
