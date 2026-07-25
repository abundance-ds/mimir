<template>
  <section
    data-files-activity
    class="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface text-ink"
    aria-label="Files"
    @keydown.capture="onCommandKeydown"
  >
    <header class="flex h-10 shrink-0 items-center gap-1 border-b border-rule bg-chrome-high px-2">
      <div class="flex h-6 shrink-0 items-center border border-rule bg-chrome p-0.5" aria-label="Files view">
        <button
          type="button"
          data-files-mode="recent"
          title="Recent files"
          :aria-pressed="viewMode === 'recent'"
          class="grid h-[18px] w-6 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :class="{ 'bg-surface text-ink': viewMode === 'recent' }"
          @click="setViewMode('recent')"
        >
          <IconClock :size="13" :stroke-width="1.8" />
        </button>
        <button
          type="button"
          data-files-mode="browse"
          title="Browse workspace"
          :aria-pressed="viewMode === 'browse'"
          class="grid h-[18px] w-6 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :class="{ 'bg-surface text-ink': viewMode === 'browse' }"
          @click="setViewMode('browse')"
        >
          <IconList :size="13" :stroke-width="1.8" />
        </button>
      </div>

      <label class="ml-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 border border-rule-light bg-surface px-2 focus-within:border-accent/50">
        <IconSearch :size="13" :stroke-width="1.8" class="shrink-0 text-ink-3" />
        <input
          ref="queryInput"
          v-model="query"
          data-files-search
          type="search"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          :placeholder="contentMode ? 'Search contents' : 'Search files'"
          class="h-full min-w-0 flex-1 bg-transparent font-mono text-[10px] text-ink outline-none placeholder:text-ink-4"
          @input="onQueryInput"
          @keydown="onSearchKeydown"
        />
        <span
          v-if="contentMode && files.contentSearching"
          class="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-4"
        >
          Searching
        </span>
      </label>

      <div class="flex h-6 shrink-0 items-center border border-rule bg-chrome p-0.5">
        <button
          type="button"
          data-search-mode="paths"
          title="Search file names and paths"
          :aria-pressed="!contentMode"
          class="h-[18px] px-1.5 font-mono text-[8px] uppercase tracking-[0.06em] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :class="{ 'bg-surface text-ink': !contentMode }"
          @click="setContentMode(false)"
        >
          Path
        </button>
        <button
          type="button"
          data-search-mode="content"
          title="Search inside text files"
          :aria-pressed="contentMode"
          class="h-[18px] px-1.5 font-mono text-[8px] uppercase tracking-[0.06em] text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          :class="{ 'bg-surface text-ink': contentMode }"
          @click="setContentMode(true)"
        >
          Text
        </button>
      </div>

      <button
        type="button"
        data-files-new-file
        title="New file (⌘N)"
        aria-label="New file"
        class="grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="promptNew('file')"
      >
        <IconFilePlus :size="14" :stroke-width="1.8" />
      </button>
      <button
        type="button"
        data-files-new-folder
        title="New folder (⇧⌘N)"
        aria-label="New folder"
        class="grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="promptNew('folder')"
      >
        <IconFolderPlus :size="14" :stroke-width="1.8" />
      </button>
      <button
        type="button"
        data-files-refresh
        title="Refresh files (⌘R)"
        aria-label="Refresh files"
        :disabled="refreshing"
        class="grid size-7 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="refresh"
      >
        <IconRefresh
          :size="14"
          :stroke-width="1.8"
          :class="{ 'motion-safe:animate-spin': refreshing }"
        />
      </button>
    </header>

    <div
      v-if="viewMode === 'browse' && !contentMode && !query.trim() && files.workspacePath"
      class="flex h-7 shrink-0 items-center gap-0.5 border-b border-rule-light bg-chrome-high px-2 text-[10px]"
    >
      <button
        type="button"
        title="Up one folder"
        aria-label="Up one folder"
        :disabled="!files.currentDirectory"
        class="mr-1 grid size-6 shrink-0 place-items-center text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-30"
        @click="openParent"
      >
        <IconArrowUp :size="13" :stroke-width="1.8" />
      </button>
      <nav class="flex min-w-0 items-center gap-0.5 overflow-hidden" aria-label="Current folder">
        <template v-for="(crumb, index) in files.breadcrumbs" :key="crumb.path">
          <IconChevronRight
            v-if="index"
            :size="11"
            :stroke-width="1.8"
            class="shrink-0 text-ink-4"
          />
          <button
            type="button"
            :data-files-breadcrumb="crumb.path || 'workspace'"
            class="min-w-0 truncate px-1.5 py-0.5 text-ink-3 hover:bg-chrome hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            :class="{ 'font-semibold text-ink': index === files.breadcrumbs.length - 1 }"
            @click="openDirectory(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </nav>
    </div>

    <div
      v-if="files.workspacePath && !contentMode"
      class="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_72px_54px] items-center gap-3 border-b border-rule-light bg-surface px-3 font-mono text-[8px] uppercase tracking-[0.08em] text-ink-4"
      aria-hidden="true"
    >
      <span>{{ viewMode === 'browse' && !query.trim() ? 'Name' : 'Recently changed' }}</span>
      <span class="text-right">Size</span>
      <span class="text-right">Edited</span>
    </div>

    <div
      v-if="files.workspacePath"
      ref="listRef"
      data-files-list
      role="listbox"
      aria-label="Workspace files"
      aria-multiselectable="true"
      tabindex="0"
      class="min-h-0 flex-1 overflow-y-auto bg-surface outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      @keydown="onListKeydown"
      @contextmenu="openEmptyContextMenu"
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
            {{ files.loading ? 'Indexing workspace' : 'Reading folder' }}
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

      <template v-else-if="contentMode">
        <button
          v-for="(match, index) in files.contentMatches"
          :key="`${match.path}:${match.line}:${match.column}`"
          type="button"
          data-content-match
          role="option"
          :aria-selected="index === focusedIndex"
          class="block w-full border-b border-rule-light px-3 py-2 text-left hover:bg-chrome-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          :class="{ 'bg-accent-soft': index === focusedIndex }"
          @click="focusedIndex = index"
          @dblclick="$emit('openFile', match.path)"
        >
          <span class="block font-mono text-[9px] text-accent">
            {{ match.relativePath }}:{{ match.line }}:{{ match.column }}
          </span>
          <span class="mt-1 block truncate font-mono text-[10px] text-ink-2">{{ match.excerpt }}</span>
        </button>
        <div
          v-if="query.trim() && !files.contentSearching && !files.contentMatches.length"
          data-files-empty
          class="grid h-40 place-items-center px-8 text-center text-[11px] text-ink-3"
        >
          No text matches. Try another phrase.
        </div>
        <div
          v-else-if="!query.trim()"
          data-files-empty
          class="grid h-40 place-items-center px-8 text-center"
        >
          <div>
            <IconFileSearch :size="21" :stroke-width="1.5" class="mx-auto text-ink-3" />
            <p class="mt-3 text-[11px] font-semibold">Search inside workspace files</p>
            <p class="mt-1 text-[10px] text-ink-3">Results include the exact line and excerpt.</p>
          </div>
        </div>
        <div
          v-if="files.contentTruncated"
          class="border-t border-rule bg-chrome-high px-3 py-2 text-[10px] text-ink-3"
        >
          The safe search limit was reached. Narrow the phrase to continue.
        </div>
      </template>

      <template v-else>
        <button
          v-for="(entry, index) in displayEntries"
          :key="entry.path"
          type="button"
          :data-file-row="entry.path"
          role="option"
          :aria-selected="selectedPaths.has(entry.path)"
          class="group grid h-9 w-full grid-cols-[minmax(0,1fr)_72px_54px] items-center gap-3 border-b border-rule-light px-3 text-left hover:bg-chrome-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          :class="{
            'bg-accent-soft text-ink': selectedPaths.has(entry.path),
            'ring-1 ring-inset ring-accent/40': index === focusedIndex && !selectedPaths.has(entry.path),
          }"
          @click="selectEntry(entry, index, $event)"
          @dblclick="activateEntry(entry)"
          @contextmenu="openContextMenu(entry, index, $event)"
        >
          <span class="flex min-w-0 items-center gap-2">
            <IconFolder
              v-if="entry.isDirectory"
              :size="15"
              :stroke-width="1.7"
              class="shrink-0 text-ink-3"
            />
            <IconFileText
              v-else-if="entry.textReadable !== false"
              :size="15"
              :stroke-width="1.7"
              class="shrink-0 text-ink-3"
            />
            <IconFile
              v-else
              :size="15"
              :stroke-width="1.7"
              class="shrink-0 text-ink-3"
            />
            <span class="min-w-0">
              <span class="block truncate text-[11px] font-medium">{{ entry.name }}</span>
              <span
                v-if="viewMode === 'recent' || query.trim()"
                class="block truncate font-mono text-[8px] text-ink-4"
              >
                {{ directory(entry.relativePath) }}
              </span>
            </span>
          </span>
          <span class="text-right font-mono text-[9px] tabular-nums text-ink-3">
            {{ entry.isDirectory ? '—' : byteSize(entry.size) }}
          </span>
          <span class="text-right font-mono text-[9px] tabular-nums text-ink-3">
            {{ relativeTime(entry.mtime) }}
          </span>
        </button>

        <div
          v-if="!displayEntries.length"
          data-files-empty
          class="grid min-h-48 place-items-center px-8 py-8 text-center"
          @contextmenu="openEmptyContextMenu"
        >
          <div class="max-w-xs">
            <IconFolderOpen :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
            <p class="mt-3 text-[12px] font-semibold">
              {{ query.trim() ? 'No matching paths' : viewMode === 'browse' ? 'This folder is empty' : 'No files yet' }}
            </p>
            <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
              {{ query.trim() ? 'Try a shorter name or switch to text search.' : 'Create a file or folder to start working here.' }}
            </p>
            <div v-if="!query.trim()" class="mt-4 flex justify-center gap-2">
              <button
                type="button"
                class="h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="promptNew('file')"
              >
                Create a file
              </button>
              <button
                type="button"
                class="h-8 border border-rule px-3 text-[10px] font-semibold hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                @click="promptNew('folder')"
              >
                New folder
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div v-else class="grid min-h-0 flex-1 place-items-center px-8 text-center">
      <div>
        <IconFolderOpen :size="22" :stroke-width="1.5" class="mx-auto text-ink-3" />
        <p class="mt-3 text-[12px] font-semibold">Open a workspace</p>
        <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
          Browse, search, and manage its files without leaving Mim.
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
      class="flex h-7 shrink-0 items-center gap-3 border-t border-rule bg-chrome-high px-3 font-mono text-[8px] uppercase tracking-[0.08em] text-ink-4"
    >
      <span>{{ selectedPaths.size ? `${selectedPaths.size} selected` : `${displayEntries.length} items` }}</span>
      <span class="ml-auto truncate normal-case tracking-normal">{{ files.currentDirectory || 'workspace' }}</span>
    </footer>

    <div
      v-if="operationError"
      data-files-operation-error
      role="alert"
      class="absolute inset-x-2 bottom-9 z-30 flex items-start gap-2 border border-rem/30 bg-surface px-3 py-2 text-[10px] text-rem"
    >
      <span class="min-w-0 flex-1">{{ operationError }}</span>
      <button
        type="button"
        title="Dismiss"
        class="grid size-5 shrink-0 place-items-center hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        @click="operationError = ''"
      >
        <IconX :size="12" :stroke-width="1.8" />
      </button>
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
        class="fixed min-w-48 border border-rule bg-surface py-1 text-[11px] text-ink-2"
        :style="contextStyle"
        @pointerdown.stop
        @keydown="onContextMenuKeydown"
      >
        <template v-if="emptyContext">
          <ContextAction label="New file" action="new-file" @select="promptNew('file')" />
          <ContextAction label="New folder" action="new-folder" @select="promptNew('folder')" />
          <ContextAction label="Refresh" action="refresh" @select="refreshFromMenu" />
        </template>
        <template v-else-if="contextEntry && contextSelection.length > 1">
          <ContextAction :label="`Copy ${contextSelection.length} paths`" action="copy-paths" @select="copySelectedPaths" />
          <ContextAction :label="`Move ${contextSelection.length} items to Trash…`" action="trash" danger @select="promptDelete(contextSelection)" />
          <ContextAction label="Clear selection" action="clear-selection" @select="clearSelection" />
        </template>
        <template v-else-if="contextEntry">
          <ContextAction
            :label="contextEntry.isDirectory ? 'Open folder' : contextEntry.textReadable === false ? 'Open in default app' : 'Open'"
            action="open"
            @select="activateContextEntry"
          />
          <ContextAction
            v-if="!contextEntry.isDirectory && contextEntry.textReadable !== false"
            label="Open in default app"
            action="open-native"
            @select="openContextNative"
          />
          <div v-if="contextEntry.isDirectory" class="my-1 border-t border-rule-light" />
          <ContextAction
            v-if="contextEntry.isDirectory"
            label="New file inside"
            action="new-file-inside"
            @select="promptNewInside('file')"
          />
          <ContextAction
            v-if="contextEntry.isDirectory"
            label="New folder inside"
            action="new-folder-inside"
            @select="promptNewInside('folder')"
          />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Rename" action="rename" shortcut="F2" @select="promptRenameContext" />
          <ContextAction label="Duplicate" action="duplicate" @select="duplicateContext" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Reveal in Finder" action="reveal" @select="revealContext" />
          <ContextAction label="Copy path" action="copy-path" @select="copyContextPath(false)" />
          <ContextAction label="Copy relative path" action="copy-relative-path" @select="copyContextPath(true)" />
          <div class="my-1 border-t border-rule-light" />
          <ContextAction label="Move to Trash…" action="trash" shortcut="⌘⌫" danger @select="promptDelete([contextEntry])" />
        </template>
      </div>
    </div>

    <div
      v-if="nameAction"
      class="fixed inset-0 z-[270] grid place-items-center bg-black/25 px-4"
      @pointerdown.self="closeNameDialog"
    >
      <section
        role="dialog"
        aria-modal="true"
        :aria-label="nameDialogTitle"
        class="w-full max-w-sm border border-rule bg-surface"
      >
        <header class="flex h-10 items-center border-b border-rule bg-chrome-high px-4">
          <h2 class="text-[12px] font-semibold">{{ nameDialogTitle }}</h2>
        </header>
        <form
          data-files-name-form
          class="space-y-3 p-4"
          @submit.prevent="confirmNameAction"
        >
          <label class="block">
            <span class="mb-1.5 block text-[10px] text-ink-3">Name</span>
            <input
              ref="nameInputRef"
              v-model="nameDraft"
              data-files-name-input
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="h-8 w-full border border-rule bg-surface px-2 font-mono text-[11px] outline-none focus:border-accent"
              :placeholder="nameAction.kind === 'folder' ? 'folder-name' : 'file-name.md'"
              @keydown.esc.prevent="closeNameDialog"
            />
          </label>
          <p v-if="nameError" class="text-[10px] leading-relaxed text-rem">{{ nameError }}</p>
          <p v-else class="truncate font-mono text-[8px] text-ink-4">
            {{ nameAction.parent ? `${nameAction.parent}/` : 'workspace/' }}
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="closeNameDialog"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="operationBusy"
              class="h-7 bg-accent px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
            >
              {{ operationBusy ? 'Working…' : nameAction.renamePath ? 'Rename' : 'Create' }}
            </button>
          </div>
        </form>
      </section>
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
        class="w-full max-w-sm border border-rule bg-surface"
      >
        <header class="flex h-10 items-center border-b border-rule bg-chrome-high px-4">
          <h2 class="text-[12px] font-semibold">
            {{ deleteEntries.length === 1 ? `Move ${deleteEntries[0].name} to Trash?` : `Move ${deleteEntries.length} items to Trash?` }}
          </h2>
        </header>
        <div class="space-y-3 p-4">
          <p class="text-[11px] leading-relaxed text-ink-2">
            {{ deleteEntries.length === 1 ? 'It moves to the system Trash and can be restored there.' : 'The selected items move to the system Trash and can be restored there.' }}
          </p>
          <p v-if="deleteError" class="text-[10px] leading-relaxed text-rem">{{ deleteError }}</p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="closeDeleteDialog"
            >
              Cancel
            </button>
            <button
              type="button"
              data-files-confirm-delete
              :disabled="operationBusy"
              class="h-7 bg-rem px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
              @click="confirmDelete"
            >
              {{ operationBusy ? 'Moving…' : 'Move to Trash' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconArrowUp,
  IconChevronRight,
  IconClock,
  IconFile,
  IconFilePlus,
  IconFileSearch,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconList,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/files.js'
import { useWorkspaceFilesStore } from '../../stores/workspaceFiles.js'
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  duplicateWorkspaceEntry,
  openWorkspaceEntryNative,
  renameWorkspaceEntry,
  revealWorkspaceEntry,
  trashWorkspaceEntries,
} from '../../services/workspaceFileOperations.js'

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
const viewMode = ref('recent')
const contentMode = ref(false)
const query = ref('')
const queryInput = ref(null)
const listRef = ref(null)
const contextMenuRef = ref(null)
const nameInputRef = ref(null)
const focusedIndex = ref(0)
const selectedPaths = ref(new Set())
const anchorIndex = ref(0)
const contextEntry = ref(null)
const emptyContext = ref(false)
const contextPosition = ref({ x: 12, y: 12 })
const nameAction = ref(null)
const nameDraft = ref('')
const nameError = ref('')
const deleteEntries = ref([])
const deleteError = ref('')
const operationError = ref('')
const operationBusy = ref(false)
const refreshing = ref(false)
let queryTimer = null

const displayEntries = computed(() => {
  if (contentMode.value) return []
  if (query.value.trim()) return files.visibleFiles.map(asFileEntry)
  if (viewMode.value === 'browse') return files.directoryEntries
  return files.visibleFiles.map(asFileEntry)
})

const selectedEntry = computed(() => displayEntries.value[focusedIndex.value] || null)
const contextSelection = computed(() => {
  if (!contextEntry.value) return []
  if (selectedPaths.value.size > 1 && selectedPaths.value.has(contextEntry.value.path)) {
    return displayEntries.value.filter((entry) => selectedPaths.value.has(entry.path))
  }
  return [contextEntry.value]
})
const isLoading = computed(() => files.loading || (viewMode.value === 'browse' && !query.value.trim() && files.directoryLoading))
const surfaceError = computed(() => files.error || (
  viewMode.value === 'browse' && !query.value.trim() ? files.directoryError : ''
))
const contextStyle = computed(() => ({
  left: `${contextPosition.value.x}px`,
  top: `${contextPosition.value.y}px`,
}))
const nameDialogTitle = computed(() => {
  if (nameAction.value?.renamePath) return `Rename ${nameAction.value.kind}`
  return nameAction.value?.kind === 'folder' ? 'New folder' : 'New file'
})

watch(displayEntries, (entries) => {
  focusedIndex.value = Math.min(focusedIndex.value, Math.max(entries.length - 1, 0))
  const visible = new Set(entries.map((entry) => entry.path))
  selectedPaths.value = new Set([...selectedPaths.value].filter((path) => visible.has(path)))
})

watch(() => props.active, (active, wasActive) => {
  if (active && wasActive === false && files.workspacePath) void refresh()
})

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onUnmounted(() => {
  clearTimeout(queryTimer)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

function setViewMode(mode) {
  clearTimeout(queryTimer)
  viewMode.value = mode
  contentMode.value = false
  query.value = ''
  files.setQuery('')
  clearSelection()
  if (mode === 'browse' && !files.directoryEntries.length && files.workspacePath) {
    void files.loadDirectory(files.currentDirectory)
  }
  nextTick(() => listRef.value?.focus())
}

function setContentMode(value) {
  contentMode.value = value
  clearSelection()
  onQueryInput()
  nextTick(() => queryInput.value?.focus())
}

function onQueryInput() {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(async () => {
    try {
      if (contentMode.value) await files.searchContent(query.value)
      else await files.setQuery(query.value)
      focusedIndex.value = 0
      selectedPaths.value = new Set()
    } catch (error) {
      operationError.value = describeError(error, 'Search failed')
    }
  }, contentMode.value ? 160 : 35)
}

function onSearchKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    listRef.value?.focus()
    moveFocus(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    listRef.value?.focus()
    moveFocus(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateFocused()
  } else if (event.key === 'Escape' && query.value) {
    event.preventDefault()
    query.value = ''
    onQueryInput()
  }
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
  }
}

function onListKeydown(event) {
  if (event.defaultPrevented) return
  const command = event.metaKey || event.ctrlKey
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    activateFocused()
  } else if (event.key === ' ') {
    event.preventDefault()
    toggleFocusedSelection()
  } else if (event.key === 'F2') {
    event.preventDefault()
    promptRename(selectedEntry.value)
  } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    event.preventDefault()
    openKeyboardContextMenu()
  } else if ((event.key === 'Delete' || (event.key === 'Backspace' && command)) && selectedPaths.value.size) {
    event.preventDefault()
    promptDelete(selectedEntries())
  } else if (event.key === 'Backspace' && !command && viewMode.value === 'browse' && !query.value && files.currentDirectory) {
    event.preventDefault()
    void openParent()
  } else if (command && event.key.toLowerCase() === 'a' && !query.value) {
    event.preventDefault()
    selectedPaths.value = new Set(displayEntries.value.map((entry) => entry.path))
  } else if (event.key === 'Escape') {
    clearSelection()
    closeContextMenu()
  }
}

function moveFocus(delta, extend = false) {
  const length = contentMode.value ? files.contentMatches.length : displayEntries.value.length
  if (!length) return
  focusedIndex.value = (focusedIndex.value + delta + length) % length
  if (contentMode.value) return
  if (extend) {
    const start = Math.min(anchorIndex.value, focusedIndex.value)
    const end = Math.max(anchorIndex.value, focusedIndex.value)
    selectedPaths.value = new Set(displayEntries.value.slice(start, end + 1).map((entry) => entry.path))
  } else {
    anchorIndex.value = focusedIndex.value
    selectedPaths.value = new Set([displayEntries.value[focusedIndex.value].path])
  }
  nextTick(() => {
    const row = listRef.value?.querySelector(`[data-file-row="${cssEscape(displayEntries.value[focusedIndex.value]?.path)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  })
}

function selectEntry(entry, index, event) {
  focusedIndex.value = index
  if (event.shiftKey) {
    const start = Math.min(anchorIndex.value, index)
    const end = Math.max(anchorIndex.value, index)
    selectedPaths.value = new Set(displayEntries.value.slice(start, end + 1).map((item) => item.path))
  } else if (event.metaKey || event.ctrlKey) {
    const next = new Set(selectedPaths.value)
    if (next.has(entry.path)) next.delete(entry.path)
    else next.add(entry.path)
    selectedPaths.value = next
    anchorIndex.value = index
  } else {
    selectedPaths.value = new Set([entry.path])
    anchorIndex.value = index
  }
}

function toggleFocusedSelection() {
  const entry = selectedEntry.value
  if (!entry) return
  const next = new Set(selectedPaths.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else next.add(entry.path)
  selectedPaths.value = next
}

function selectedEntries() {
  if (!selectedPaths.value.size && selectedEntry.value) return [selectedEntry.value]
  return displayEntries.value.filter((entry) => selectedPaths.value.has(entry.path))
}

async function activateEntry(entry) {
  closeContextMenu()
  if (entry.isDirectory) {
    await openDirectory(entry.relativePath)
  } else if (entry.textReadable === false) {
    await runOperation(() => openWorkspaceEntryNative(entry.path), `Could not open ${entry.name}`)
  } else {
    emit('openFile', entry.path)
  }
}

function activateFocused() {
  if (contentMode.value) {
    const match = files.contentMatches[focusedIndex.value]
    if (match) emit('openFile', match.path)
  } else if (selectedEntry.value) {
    void activateEntry(selectedEntry.value)
  }
}

async function openDirectory(relativePath) {
  try {
    await files.openDirectory(relativePath)
    focusedIndex.value = 0
    selectedPaths.value = new Set()
  } catch (error) {
    operationError.value = describeError(error, 'Folder could not be opened')
  }
}

function openParent() {
  return openDirectory(files.currentDirectory.split('/').slice(0, -1).join('/'))
}

async function refresh() {
  if (refreshing.value || !files.workspacePath) return
  refreshing.value = true
  operationError.value = ''
  try {
    const report = await files.refresh()
    if (report === null && files.error) operationError.value = files.error
  } catch (error) {
    operationError.value = describeError(error, 'Files could not be refreshed')
  } finally {
    refreshing.value = false
  }
}

function openContextMenu(entry, index, event) {
  event.preventDefault()
  event.stopPropagation()
  focusedIndex.value = index
  if (!(selectedPaths.value.size > 1 && selectedPaths.value.has(entry.path))) {
    selectedPaths.value = new Set([entry.path])
    anchorIndex.value = index
  }
  contextEntry.value = entry
  emptyContext.value = false
  placeContextMenu(event.clientX, event.clientY)
}

function openKeyboardContextMenu() {
  const entry = selectedEntry.value
  if (!entry) {
    emptyContext.value = true
    placeContextMenu(16, 72)
    return
  }
  if (!selectedPaths.value.has(entry.path)) selectedPaths.value = new Set([entry.path])
  contextEntry.value = entry
  const row = listRef.value?.querySelector(`[data-file-row="${cssEscape(entry.path)}"]`)
  const rect = row?.getBoundingClientRect?.()
  placeContextMenu(rect?.left || 16, rect?.bottom || 72)
}

function openEmptyContextMenu(event) {
  if (event.target?.closest?.('[data-file-row]')) return
  event.preventDefault()
  contextEntry.value = null
  emptyContext.value = true
  placeContextMenu(event.clientX, event.clientY)
}

function placeContextMenu(x, y) {
  contextPosition.value = {
    x: Math.max(8, Math.min(Number(x) || 8, window.innerWidth - 220)),
    y: Math.max(8, Math.min(Number(y) || 8, window.innerHeight - 300)),
  }
  nextTick(() => {
    const first = contextMenuRef.value?.querySelector('[role="menuitem"]')
    ;(first || contextMenuRef.value)?.focus()
  })
}

function closeContextMenu() {
  contextEntry.value = null
  emptyContext.value = false
}

function onContextMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeContextMenu()
    nextTick(() => listRef.value?.focus())
    return
  }
  const items = [...(contextMenuRef.value?.querySelectorAll('[role="menuitem"]') || [])]
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement))
  let next = null
  if (event.key === 'ArrowDown') next = (current + 1) % items.length
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = items.length - 1
  else if ((event.key === 'Enter' || event.key === ' ') && document.activeElement?.matches?.('[role="menuitem"]')) {
    event.preventDefault()
    document.activeElement.click()
    return
  }
  if (next !== null) {
    event.preventDefault()
    items[next].focus()
  }
}

function onDocumentPointerDown(event) {
  if (!contextEntry.value && !emptyContext.value) return
  if (contextMenuRef.value?.contains(event.target)) return
  closeContextMenu()
}

function activateContextEntry() {
  const entry = contextEntry.value
  if (entry) void activateEntry(entry)
}

function openContextNative() {
  const entry = contextEntry.value
  closeContextMenu()
  if (entry) void runOperation(() => openWorkspaceEntryNative(entry.path), `Could not open ${entry.name}`)
}

function promptNew(kind, parent = operationDirectory()) {
  closeContextMenu()
  nameAction.value = { kind, parent }
  nameDraft.value = ''
  nameError.value = ''
  nextTick(() => nameInputRef.value?.focus())
}

function promptNewInside(kind) {
  const entry = contextEntry.value
  if (entry?.isDirectory) promptNew(kind, entry.relativePath)
}

function promptRename(entry) {
  if (!entry) return
  closeContextMenu()
  nameAction.value = {
    kind: entry.isDirectory ? 'folder' : 'file',
    parent: parentDirectory(entry.relativePath),
    renamePath: entry.path,
  }
  nameDraft.value = entry.name
  nameError.value = ''
  nextTick(() => {
    nameInputRef.value?.focus()
    nameInputRef.value?.select()
  })
}

function promptRenameContext() {
  promptRename(contextEntry.value)
}

function closeNameDialog() {
  if (operationBusy.value) return
  nameAction.value = null
  nameError.value = ''
}

async function confirmNameAction() {
  const action = nameAction.value
  if (!action || operationBusy.value) return
  const name = nameDraft.value.trim()
  if (!name) {
    nameError.value = 'Enter a name.'
    return
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    nameError.value = 'Use a name without folder separators.'
    return
  }
  operationBusy.value = true
  nameError.value = ''
  try {
    if (action.renamePath) {
      await editorFiles.waitForWorkspacePaths([action.renamePath])
      const result = await renameWorkspaceEntry(action.renamePath, name)
      editorFiles.moveWorkspacePath(action.renamePath, result.path)
    } else {
      const relativePath = joinRelative(action.parent, name)
      if (action.kind === 'folder') {
        await createWorkspaceFolder(relativePath)
      } else {
        const result = await createWorkspaceFile(relativePath)
        emit('openFile', result.path)
      }
    }
    nameAction.value = null
    await files.refresh()
  } catch (error) {
    nameError.value = describeError(error, action.renamePath ? 'Rename failed' : 'Creation failed')
  } finally {
    operationBusy.value = false
  }
}

async function duplicateContext() {
  const entry = contextEntry.value
  closeContextMenu()
  if (!entry) return
  await runOperation(async () => {
    await duplicateWorkspaceEntry(entry.path)
    await files.refresh()
  }, `Could not duplicate ${entry.name}`)
}

function promptDelete(entries) {
  closeContextMenu()
  const unique = new Map(entries.filter(Boolean).map((entry) => [entry.path, entry]))
  deleteEntries.value = [...unique.values()]
  deleteError.value = ''
}

function closeDeleteDialog() {
  if (operationBusy.value) return
  deleteEntries.value = []
  deleteError.value = ''
}

async function confirmDelete() {
  if (!deleteEntries.value.length || operationBusy.value) return
  operationBusy.value = true
  deleteError.value = ''
  const paths = deleteEntries.value.map((entry) => entry.path)
  try {
    await editorFiles.waitForWorkspacePaths(paths)
    await trashWorkspaceEntries(paths)
    editorFiles.handleWorkspaceTrash(paths)
    deleteEntries.value = []
    clearSelection()
    await files.refresh()
  } catch (error) {
    deleteError.value = describeError(error, 'Could not move the selection to the Trash')
  } finally {
    operationBusy.value = false
  }
}

async function revealContext() {
  const entry = contextEntry.value
  closeContextMenu()
  if (entry) await runOperation(() => revealWorkspaceEntry(entry.path), `Could not reveal ${entry.name}`)
}

function copyContextPath(relative) {
  const entry = contextEntry.value
  closeContextMenu()
  if (entry) void copyText(relative ? entry.relativePath : entry.path)
}

function copySelectedPaths() {
  const paths = contextSelection.value.map((entry) => entry.path)
  closeContextMenu()
  void copyText(paths.join('\n'))
}

async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
    await navigator.clipboard.writeText(text)
  } catch (error) {
    operationError.value = describeError(error, 'Path could not be copied')
  }
}

function clearSelection() {
  selectedPaths.value = new Set()
  closeContextMenu()
}

function refreshFromMenu() {
  closeContextMenu()
  void refresh()
}

async function runOperation(operation, fallback) {
  operationError.value = ''
  try {
    return await operation()
  } catch (error) {
    operationError.value = describeError(error, fallback)
    return null
  }
}

function operationDirectory() {
  return viewMode.value === 'browse' && !query.value.trim() ? files.currentDirectory : ''
}

function asFileEntry(file) {
  return { ...file, isDirectory: false }
}

function joinRelative(parent, name) {
  return parent ? `${parent.replace(/\/+$/, '')}/${name}` : name
}

function parentDirectory(path) {
  const parts = String(path || '').split('/')
  parts.pop()
  return parts.join('/')
}

function directory(path) {
  const value = String(path || '')
  const index = value.lastIndexOf('/')
  return index < 0 ? 'workspace' : value.slice(0, index)
}

function byteSize(bytes) {
  const count = Number(bytes || 0)
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  if (count < 1024 * 1024 * 1024) return `${(count / 1024 / 1024).toFixed(1)} MB`
  return `${(count / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function relativeTime(timestamp) {
  const delta = Math.max(0, Date.now() - Number(timestamp || 0))
  if (delta < 60_000) return 'now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d`
  return new Date(Number(timestamp || 0)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function describeError(error, fallback) {
  const message = error instanceof Error ? error.message : String(error || '')
  return message ? `${fallback}: ${message}` : fallback
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(value || '')) : String(value || '').replaceAll('"', '\\"')
}
</script>
