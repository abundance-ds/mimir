<template>
  <section
    ref="activityRef"
    data-files-activity
    class="files-activity relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-ink"
    :class="compact ? 'files-compact bg-chrome' : 'bg-surface'"
    aria-label="Files"
    @keydown.capture="onCommandKeydown"
  >
    <div v-if="compact" data-files-compact-toolbar class="flex h-[32px] min-w-0 shrink-0 items-center gap-1 px-[12px]" role="toolbar" aria-label="Files">
      <button v-for="option in compactViews" :key="option.id" type="button"
        :data-files-mode="option.id" :aria-label="option.label" :title="option.label"
        :aria-pressed="viewMode === option.id"
        class="grid size-[28px] shrink-0 place-items-center text-ink-3 hover:bg-chrome-mid hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        :class="{ 'bg-chrome-mid text-ink': viewMode === option.id }"
        @click="setViewMode(option.id)">
        <component :is="option.icon" :size="14" :stroke-width="1.75" />
      </button>
      <span class="min-w-0 flex-1" />
      <WorkbenchMenu label="File actions" :items="compactActions" compact @select="compactAction"><IconDots :size="14" /></WorkbenchMenu>
    </div>
    <header v-else data-files-toolbar class="pane-bar items-end">
      <nav class="flex h-full min-w-0 flex-1 items-end" aria-label="Files view">
        <button
          v-for="option in views"
          :key="option.id"
          type="button"
          :data-files-mode="option.id"
          :aria-label="option.label"
          :aria-current="viewMode === option.id ? 'page' : undefined"
          class="relative flex h-full items-center gap-1.5 px-2 text-[11px] font-medium text-ink-3 outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          :class="{ 'text-ink': viewMode === option.id }"
          @click="setViewMode(option.id)"
        >
          <component :is="option.icon" :size="13" :stroke-width="1.75" />
          <span class="files-view-label">{{ option.label }}</span>
          <span
            v-if="option.id === 'favorites' && favorites.length"
            class="font-mono text-[9px] tabular-nums text-ink-4"
          >
            {{ favorites.length }}
          </span>
          <span
            v-if="option.id === 'changes' && gitReview.changes.length"
            class="font-mono text-[9px] tabular-nums text-ink-4"
          >
            {{ gitReview.changes.length }}
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
        title="New file"
        aria-label="New file"
        class="mb-1 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="promptNew('file')"
      >
        <IconFilePlus :size="14" :stroke-width="1.75" />
      </button>
      <button
        type="button"
        data-files-new-folder
        title="New folder (⇧⌘N)"
        aria-label="New folder"
        class="mb-1 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
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
        class="mb-1 grid size-7 shrink-0 place-items-center text-ink-3 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
        @click="refresh"
      >
        <IconRefresh
          :size="14"
          :stroke-width="1.75"
          :class="{ 'motion-safe:animate-spin': refreshing }"
        />
      </button>
    </header>

    <FileHistoryPanel
      v-if="fileHistoryEntry"
      :path="fileHistoryEntry.path"
      :name="fileHistoryEntry.name"
      @close="closeFileHistory"
      @open="$emit('openFile', $event)"
    />

    <div
      v-if="files.workspacePath && !(viewMode === 'changes' && gitReview.repositoryState === 'not-repository')"
      class="files-search mx-2 my-2 flex shrink-0 items-center" :class="compact ? 'flex-col gap-1' : 'h-8'"
      @focusin="searchFocused = true"
      @focusout="onSearchFocusOut"
    >
      <template v-for="part in compact ? ['field', 'scopes'] : ['scopes', 'field']" :key="part">
        <div
          v-if="part === 'scopes' && viewMode !== 'changes' && (!compact || searchFocused || query)"
          class="files-search-scopes flex h-full shrink-0 border border-r-0 border-rule-light bg-chrome-high p-0.5"
          role="group"
          aria-label="Search scope"
        >
          <button
            v-for="scope in searchScopes"
            :key="scope.id"
            type="button"
            :data-files-search-scope="scope.id"
            :aria-pressed="searchScope === scope.id"
            class="h-full px-2 font-mono text-[9px] text-ink-4 outline-none hover:bg-chrome hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
            :class="{ 'bg-surface text-ink': searchScope === scope.id }"
            @mousedown.prevent
            @click="setSearchScope(scope.id)"
          >
            {{ scope.label }}
          </button>
        </div>
        <label v-if="part === 'field'" class="files-search-field flex h-8 min-w-0 flex-1 items-center gap-2 border border-rule-light bg-chrome-high px-2 focus-within:border-accent/60">
          <IconSearch :size="13" :stroke-width="1.8" class="shrink-0 text-ink-4" />
          <input
            :ref="setQueryInput"
            v-model="query"
            data-files-search
            type="text"
            role="searchbox"
            aria-label="Search files"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            :placeholder="searchPlaceholder"
            class="h-full min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-4"
            @input="onQueryInput"
            @keydown.down.prevent="enterSearchResults(1)"
            @keydown.up.prevent="enterSearchResults(-1)"
            @keydown.esc.prevent="clearQuery"
          />
          <kbd v-if="!query" class="font-mono text-[9px] text-ink-4">⌘F</kbd>
          <button
            v-else
            type="button"
            title="Clear search"
            aria-label="Clear search"
            class="grid size-5 place-items-center text-ink-4 hover:text-ink"
            @click="clearQuery"
          >
            <IconX :size="12" :stroke-width="1.8" />
          </button>
        </label>
      </template>
    </div>

    <div
      v-if="gitOnly && viewMode !== 'changes'"
      data-files-active-filter
      data-files-ledger-status
      role="status"
      class="pane-subbar gap-2 font-mono text-[10px] text-ink-3"
    >
      <span class="font-semibold text-accent">Git changes</span>
      <span>{{ gitChanges.length }}</span>
      <button
        type="button"
        data-files-clear-git-filter
        class="ml-auto text-ink-4 outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="toggleGitFilter(false)"
      >
        Clear
      </button>
    </div>

    <div
      v-if="!compact && files.workspacePath && !contentMode && viewMode !== 'changes'"
      data-files-ledger-header
      data-files-ledger-columns
      role="group"
      aria-label="Sort files"
      class="files-ledger-grid pane-subbar grid min-w-[248px] items-center font-mono text-[10px] text-ink-4"
    >
      <div class="flex h-full min-w-0 items-center">
        <FileSortHeader
          sort-key="name"
          label="Name"
          inset
          class="min-w-0 flex-1"
          :active="sortKey === 'name'"
          :direction="sortDirection"
          :direction-label="sortHeaderDirectionLabel('name')"
          @sort="sortByHeader('name')"
        />
        <FileSortMenu
          :options="sortOptions"
          :sort-key="sortKey"
          :sort-direction="sortDirection"
          :direction-options="sortDirectionOptions"
          :label="sortLabel"
          :direction-label="sortDirectionLabel"
          :summary="sortMenuSummary"
          @open="closeContextMenu"
          @select-sort="selectSort"
          @select-direction="selectSortDirection"
        />
      </div>
      <FileSortHeader
        sort-key="kind"
        label="Kind"
        class="files-ledger-kind"
        :active="sortKey === 'kind'"
        :direction="sortDirection"
        :direction-label="sortHeaderDirectionLabel('kind')"
        @sort="sortByHeader('kind')"
      />
      <FileSortHeader
        sort-key="git"
        label="Git"
        align="right"
        :active="sortKey === 'git'"
        :direction="sortDirection"
        :direction-label="sortHeaderDirectionLabel('git')"
        @sort="sortByHeader('git')"
      />
      <FileSortHeader
        sort-key="modified"
        label="Modified"
        align="right"
        class="files-ledger-modified"
        :active="sortKey === 'modified'"
        :direction="sortDirection"
        :direction-label="sortHeaderDirectionLabel('modified')"
        @sort="sortByHeader('modified')"
      />
      <FileSortHeader
        sort-key="size"
        label="Size"
        align="right"
        class="files-ledger-size"
        :active="sortKey === 'size'"
        :direction="sortDirection"
        :direction-label="sortHeaderDirectionLabel('size')"
        @sort="sortByHeader('size')"
      />
      <FileSortHeader
        sort-key="favorite"
        label="Favorites"
        align="center"
        :active="sortKey === 'favorite'"
        :direction="sortDirection"
        :direction-label="sortHeaderDirectionLabel('favorite')"
        @sort="sortByHeader('favorite')"
      >
        <IconStar :size="9" :stroke-width="1.7" />
      </FileSortHeader>
    </div>

    <GitChangesList
      v-if="files.workspacePath && viewMode === 'changes'"
      ref="gitListRef"
      :query="query"
      :managed="managedGit"
      :excluded-paths="[...excludedGitPaths.keys()]"
      @review="$emit('reviewGit', $event)"
      @open-file="$emit('openFile', $event)"
    />

    <div
      v-else-if="files.workspacePath"
      ref="listRef"
      data-files-list
      :role="contentMode ? 'listbox' : 'tree'"
      aria-label="Workspace files"
      :aria-multiselectable="contentMode ? undefined : 'true'"
      tabindex="0"
      :data-files-drop-root="rootDropActive ? '' : undefined"
      class="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
      :class="{ 'ring-1 ring-inset ring-accent': rootDropActive }"
      @keydown="onListKeydown"
      @contextmenu="onListContextMenu"
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

      <div v-else-if="searchPending" data-files-search-pending role="status"
        class="px-3 py-4 text-[11px] text-ink-3">Searching…</div>

      <div v-else-if="searchError" data-files-search-error role="alert"
        class="px-3 py-4 text-[11px] text-ink-3">
        <p>Files could not be searched.</p>
        <p class="mt-1 break-words text-[10px]">{{ searchError }}</p>
        <button type="button" class="mt-2 h-7 border border-rule px-2 hover:bg-chrome-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          data-files-search-retry @click="fileSearch.schedule({ immediate: true })">Try again</button>
      </div>

      <template v-else-if="contentMode">
        <button
          v-for="(match, index) in contentMatches"
          :key="`${match.path}:${match.line}:${match.column}`"
          type="button"
          data-content-match
          role="option"
          :aria-selected="contentFocusedIndex === index"
          class="block h-11 w-full px-3 text-left outline-none hover:bg-chrome-high focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          :class="[compact ? '' : 'border-b border-rule-light', contentFocusedIndex === index ? (compact ? 'bg-chrome-high' : 'bg-accent-soft') : '']"
          @click="openContentMatch(match, index, true)"
          @dblclick.prevent="openContentMatch(match, index, false)"
        >
          <span class="flex min-w-0 items-center gap-2 font-mono text-[10px] text-ink-2">
            <span class="min-w-0 flex-1 truncate">{{ match.relativePath }}</span>
            <span class="shrink-0 tabular-nums text-ink-4">{{ match.line }}:{{ match.column }}</span>
          </span>
          <span class="mt-0.5 block truncate font-mono text-[10px] text-ink-2">{{ match.excerpt }}</span>
        </button>

        <div
          v-if="query.trim() && !contentMatches.length"
          data-files-empty
          class="grid h-40 place-items-center px-8 text-center text-[11px] text-ink-3"
        >
          {{ searchLimited ? 'No matches in the files searched. Some files were not fully searched.' : 'No content matches.' }}
        </div>
        <div
          v-else-if="!query.trim()"
          data-files-empty
          class="grid h-40 place-items-center px-8 text-center"
        >
          <div>
            <IconSearch :size="21" :stroke-width="1.5" class="mx-auto text-ink-3" />
            <p class="mt-3 text-[11px] font-semibold">Search file contents</p>
            <p class="mt-1 text-[10px] text-ink-3">Matches show the file, line, and excerpt.</p>
          </div>
        </div>
        <div
          v-if="searchLimited && contentMatches.length"
          role="status"
          class="border-t border-rule bg-chrome-high px-3 py-2 text-[10px] text-ink-3"
        >
          Search results are incomplete. Some files were not fully searched.
        </div>
      </template>

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
            :compact="compact"
            :selected="selectedPaths.has(item.row.entry.path)"
            :active="isActive(item.row.entry)"
            :ancestry="isActiveAncestry(item.row.entry)"
            :favorite="item.row.favorite"
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
        <div v-if="query.trim() && searchLimited" role="status"
          class="px-3 py-2 text-[10px] text-ink-3">Showing the first 250 matches. Use a longer filename or path.</div>
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

    <PaneBand as="footer" kind="footer"
      v-if="files.workspacePath && !compact"
      data-files-footer
      class="gap-3 px-3"
    >
      <span>{{ footerCount }}</span>
      <span
        v-if="selectedFileSummary"
        data-files-selection-detail
        class="files-selected-detail min-w-0 truncate text-ink-3"
      >
        {{ selectedFileSummary }}
      </span>
      <span v-if="importing" data-files-importing class="text-accent">Adding dropped items…</span>
      <button
        v-else-if="viewMode !== 'changes' && (gitChanges.length || gitOnly)"
        type="button"
        data-files-git-filter
        :aria-pressed="gitOnly"
        class="shrink-0 whitespace-nowrap text-accent outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent"
        @click="toggleGitFilter()"
      >
        {{ gitChanges.length }} Git {{ gitChanges.length === 1 ? 'change' : 'changes' }}
      </button>
      <button
        v-if="viewMode === 'project' && !gitOnly && !contentMode && files.expandedDirectories.size"
        type="button"
        class="files-footer-secondary ml-auto text-ink-4 hover:text-ink"
        @click="collapseAll"
      >
        Collapse all
      </button>
      <span v-else class="files-footer-secondary ml-auto truncate">{{ workspaceName }}</span>
    </PaneBand>

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
        <template v-else-if="contextEntry && contextEntry.missing">
          <ContextAction
            v-if="isFavorite(contextEntry)"
            label="Remove from Favorites"
            action="favorite"
            @select="favoriteContextEntry"
          />
          <ContextAction label="Copy path" action="copy-path" @select="copyContextPath(false)" />
          <ContextAction label="Copy relative path" action="copy-relative-path" @select="copyContextPath(true)" />
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
            v-if="projectHasGit && !contextEntry.isDirectory && contextEntry.textReadable"
            label="History"
            action="history"
            @select="openFileHistory"
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
        ref="deleteDialogRef"
        role="alertdialog"
        aria-modal="true"
        aria-label="Move items to Trash"
        class="w-full max-w-sm border border-rule bg-surface shadow-xl"
        @keydown="onDeleteDialogKeydown"
      >
        <header class="dialog-header">
          <h2 class="text-[12px] font-semibold">
            {{ deleteEntries.length === 1 ? `Move ${deleteEntries[0].name} to Trash?` : `Move ${deleteEntries.length} items to Trash?` }}
          </h2>
        </header>
        <div class="space-y-3 p-4">
          <p class="text-[11px] leading-relaxed text-ink-2">
            The selection moves to the system Trash and can be restored there.
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="h-7 border border-rule px-3 text-[10px] hover:bg-chrome focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              @click="closeDeleteDialog"
            >
              Cancel
            </button>
            <button
              ref="deleteConfirmRef"
              type="button"
              data-files-confirm-delete
              :disabled="operationBusy"
              class="h-7 bg-rem px-3 text-[10px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rem disabled:opacity-40"
              @keydown.enter.prevent.stop="confirmDelete"
              @click="confirmDelete"
            >
              Move to Trash
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
import PaneBand from '../../shared/ui/chrome/PaneBand.vue'

import WorkbenchMenu from '../components/WorkbenchMenu.vue'
import { IconDots, IconPlus, IconChevronDown } from '@tabler/icons-vue'
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAlertTriangle,
  IconClock,
  IconFilePlus,
  IconFolderOpen,
  IconFolderPlus,
  IconHistory,
  IconGitCompare,
  IconRefresh,
  IconSearch,
  IconStar,
  IconX,
} from '@tabler/icons-vue'
import FileSortHeader from '../components/FileSortHeader.vue'
import FileSortMenu from '../components/FileSortMenu.vue'
import FileHistoryPanel from '../components/FileHistoryPanel.vue'
import FileTreeRow from '../components/FileTreeRow.vue'
import GitChangesList from '../components/GitChangesList.vue'
import { pathIsInsideWorkspace, useFileStore } from '../../stores/files.js'
import { useGitReviewStore } from '../../stores/gitReview.js'
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
import { useFileSearch } from '../files/useFileSearch.js'
import { useFileTreeDrag } from '../files/useFileTreeDrag.js'
import {
  compareFileRows,
  fileKind,
  formatFileSize,
  formatModifiedTime,
  gitLabel,
} from '../files/fileLedger.js'
import { importWorkspaceEntries } from '../../services/workspaceFileOperations.js'
import { managedProjectStatus } from '../../services/managedRepositories.js'
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
  activity: { type: Object, default: () => ({ id: 'files' }) },
  compact: Boolean,
  active: { type: Boolean, default: false },
})

const emit = defineEmits(['openFile', 'reviewGit', 'chooseWorkspace', 'diagnostic', 'openManager'])
const FILE_SORT_OPTIONS = Object.freeze([
  { id: 'name', label: 'Name' },
  { id: 'kind', label: 'Kind' },
  { id: 'git', label: 'Git' },
  { id: 'modified', label: 'Modified' },
  { id: 'size', label: 'Size' },
  { id: 'favorite', label: 'Favorites' },
])
const DEFAULT_FILE_SORT_STATES = Object.freeze({
  project: Object.freeze({ key: 'name', direction: 'asc' }),
  recent: Object.freeze({ key: 'view', direction: 'asc' }),
  favorites: Object.freeze({ key: 'name', direction: 'asc' }),
})
const files = useWorkspaceFilesStore()
const editorFiles = useFileStore()
const gitReview = useGitReviewStore()
const settings = useSettingsStore()
const viewMode = ref('project')
const fileSearch = useFileSearch({
  workspacePath: computed(() => files.workspacePath),
  indexedFiles: computed(() => files.files),
  searchContent: (value, options) => files.searchContent(value, options),
})
const { query, scope: searchScope, pathResults, contentResults,
  pending: searchPending, limited: searchLimited, error: searchError } = fileSearch
const searchFocused = ref(false)
const viewScroll = new Map()
const viewSelections = new Map()
const workspaceViews = new Map()
let searchReturn = null
const activityRef = ref(null)
const queryInput = ref(null)
const listRef = ref(null)
const gitListRef = ref(null)
const contextMenuRef = ref(null)
const deleteDialogRef = ref(null)
const deleteConfirmRef = ref(null)
const gitChanges = ref([])
const managedGitStatus = ref(null)
const managedGit = computed(() => Boolean(managedGitStatus.value?.managed))
const projectHasGit = computed(() => gitReview.repositoryState === 'ready')
const fileHistoryEntry = ref(null)
const excludedGitPaths = computed(() => new Map(
  (managedGitStatus.value?.excluded || []).map(entry => [normalizeRelative(entry.path), entry.reason]),
))
const gitOnly = ref(false)
const contentFocusedIndex = ref(-1)
const sortStateByView = ref(defaultFileSortStates())
let gitRefreshTimer = null

// Windowed rendering: only trees larger than this render behind spacers.
const VIRTUALIZE_AT = 300
const OVERSCAN_ROWS = 20
const ROW_HEIGHT = 28 // FileTreeRow h-7
const SECONDARY_ROW_HEIGHT = 36 // FileTreeRow h-9
const scrollTop = ref(0)
const viewportHeight = ref(0)
const activityWidth = ref(560)

const views = Object.freeze([
  { id: 'project', label: 'Project', icon: IconFolderOpen },
  { id: 'changes', label: 'Changes', icon: IconGitCompare },
  { id: 'recent', label: 'Recent', icon: IconClock },
  { id: 'favorites', label: 'Favorites', icon: IconStar },
])
const compactViews = [
  { id: 'project', label: 'File tree', icon: IconFolderOpen },
  { id: 'favorites', label: 'Favorites', icon: IconStar },
  { id: 'recent', label: 'Recent', icon: IconClock },
]
const searchScopes = Object.freeze([
  { id: 'paths', label: 'Names' },
  { id: 'contents', label: 'Contents' },
])
const contentMode = computed(() => viewMode.value !== 'changes'
  && searchScope.value === 'contents'
  && (!props.compact || Boolean(query.value.trim())))
const sortState = computed(() => sortStateByView.value[viewMode.value] || sortStateByView.value.project)
const sortKey = computed(() => sortState.value.key)
const sortDirection = computed(() => sortState.value.direction)
const sortOptions = computed(() => (
  viewMode.value === 'recent'
    ? [{ id: 'view', label: 'Recently opened' }, ...FILE_SORT_OPTIONS]
    : FILE_SORT_OPTIONS
))
const sortLabel = computed(() => (
  sortOptions.value.find(option => option.id === sortKey.value)?.label || 'Name'
))
const sortDirectionOptions = computed(() => directionOptions(sortKey.value))
const sortDirectionLabel = computed(() => (
  sortKey.value === 'view'
    ? 'Default order'
    : sortDirectionOptions.value.find(option => option.id === sortDirection.value)?.label || ''
))
const sortKeyHidden = computed(() => (
  (sortKey.value === 'kind' && activityWidth.value <= 539)
  || (sortKey.value === 'size' && activityWidth.value <= 479)
  || (sortKey.value === 'modified' && activityWidth.value <= 399)
))
const sortMenuSummary = computed(() => (sortKeyHidden.value ? sortLabel.value : ''))

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
watch(
  [() => files.workspacePath, () => settings.workbenchFileSort],
  ([workspacePath]) => {
    const workspaceKey = normalizePath(workspacePath)
    sortStateByView.value = normalizeFileSortStates(
      settings.workbenchFileSort?.[workspaceKey],
    )
  },
  { immediate: true },
)
const indexedByPath = computed(() => new Map(
  files.files.map((entry) => [normalizePath(entry.path), normalizeEntry(entry)]),
))
// Only the Favorites view resolves entries by relative path; skip the full
// tree flatten (every loaded directory) for the Project and Recent views.
const loadedByRelativePath = computed(() => {
  if (viewMode.value !== 'favorites' && !gitOnly.value) return new Map()
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
// A folder reports the number of changed descendants. One inherited status
// letter can misrepresent a folder that contains mixed Git states.
const gitDirectoryCounts = computed(() => {
  const counts = new Map()
  for (const path of gitByPath.value.keys()) {
    let parent = path
    let cut = parent.lastIndexOf('/')
    while (cut > 0) {
      parent = parent.slice(0, cut)
      counts.set(parent, (counts.get(parent) || 0) + 1)
      cut = parent.lastIndexOf('/')
    }
  }
  return counts
})
const activePath = computed(() => normalizePath(editorFiles.currentFile?.path))
const pendingTrashPaths = ref(new Set())

const visibleRows = computed(() => {
  if (contentMode.value || viewMode.value === 'changes') return []
  if (gitOnly.value && viewMode.value === 'project' && !query.value.trim()) {
    return gitChangeRows().filter(row => !isPendingTrashPath(row.entry.path))
  }
  let rows
  if (props.compact && query.value.trim()) rows = searchRows()
  else if (viewMode.value === 'recent') rows = recentRows()
  else if (viewMode.value === 'favorites') rows = favoriteRows()
  else if (query.value.trim()) rows = searchRows()
  else {
    rows = []
    flattenDirectory('', 0, rows)
  }
  if (gitOnly.value) rows = rows.filter(rowHasGitChange)
  return rows.filter(row => !isPendingTrashPath(row.entry.path))
})

const contentMatches = computed(() => {
  let matches = contentResults.value
  if (!props.compact && viewMode.value === 'recent') {
    const recent = new Set(editorFiles.recentFiles
      .filter(path => pathIsInsideWorkspace(path, files.workspacePath))
      .map(normalizePath))
    matches = matches.filter(match => recent.has(normalizePath(match.path)))
  } else if (!props.compact && viewMode.value === 'favorites') {
    const favoritePaths = favorites.value.map(record => ({
      path: normalizeRelative(record.relativePath),
      directory: Boolean(record.isDirectory),
    }))
    matches = matches.filter((match) => {
      const path = normalizeRelative(match.relativePath)
      return favoritePaths.some(favorite => (
        favorite.directory ? path.startsWith(`${favorite.path}/`) : path === favorite.path
      ))
    })
  }
  if (gitOnly.value) {
    matches = matches.filter(match => gitByPath.value.has(normalizeRelative(match.relativePath)))
  }
  return matches
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
  pendingTrashPaths,
})

watch(deleteEntries, async (entries, previous = []) => {
  if (entries.length) {
    await nextTick()
    deleteConfirmRef.value?.focus()
  } else if (previous.length) {
    await nextTick()
    listRef.value?.focus()
  }
}, { flush: 'post' })

function onDeleteDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeDeleteDialog()
  } else if (event.key === 'Tab') {
    trapDialogFocus(event, deleteDialogRef.value)
  }
}

function trapDialogFocus(event, dialog) {
  const focusable = [...(dialog?.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])]
  if (!focusable.length) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const { dropTarget, importing } = useFileDrop({
  listRef,
  rows: () => renderedRows.value,
  acceptsDrop: () => props.active && Boolean(files.workspacePath),
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
    && !gitOnly.value && !contentMode.value
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
const activityResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => {
      if (activityRef.value?.clientWidth > 0) activityWidth.value = activityRef.value.clientWidth
    })
  : null

watch(listRef, (element, previous) => {
  if (previous) listResizeObserver?.unobserve(previous)
  if (element) {
    listResizeObserver?.observe(element)
    onListScroll()
  }
}, { flush: 'post' })

watch(activityRef, (element, previous) => {
  if (previous) activityResizeObserver?.unobserve(previous)
  if (element) {
    activityResizeObserver?.observe(element)
    if (element.clientWidth > 0) activityWidth.value = element.clientWidth
  }
}, { flush: 'post' })

const isLoading = computed(() => files.loading || (
  !contentMode.value
  && viewMode.value === 'project'
  && !query.value.trim()
  && !Object.prototype.hasOwnProperty.call(files.treeChildren, '')
))
const surfaceError = computed(() => files.error || files.treeErrors[''] || '')
const searchPlaceholder = computed(() => {
  if (props.compact) return searchScope.value === 'contents' ? 'Search project contents…' : 'Find files…'
  if (viewMode.value === 'changes') return 'Filter changed files'
  if (contentMode.value) return ({
    project: 'Search project contents',
    recent: 'Search recent file contents',
    favorites: 'Search favorite contents',
  })[viewMode.value]
  return ({
    project: 'Filter project files',
    recent: 'Filter recent files',
    favorites: 'Filter favorites',
  })[viewMode.value]
})
const emptyTitle = computed(() => {
  if (gitOnly.value && !query.value.trim()) return 'No visible Git changes'
  if (query.value.trim()) return 'No matching files'
  if (viewMode.value === 'favorites') return 'No favorites yet'
  if (viewMode.value === 'recent') return 'No recent files'
  return 'This workspace is empty'
})
const emptyBody = computed(() => {
  if (gitOnly.value && !query.value.trim()) return 'Clear the Git filter to see all project files.'
  if (query.value.trim()) return 'Try a shorter filename or path.'
  if (viewMode.value === 'favorites') return 'Star files or folders you return to often.'
  if (viewMode.value === 'recent') return 'Files you open in Mimir appear here.'
  return 'Create a file to start working here.'
})
const footerCount = computed(() => {
  if (viewMode.value === 'changes') {
    const total = gitReview.visibleChanges.length
    return `${total} ${total === 1 ? 'change' : 'changes'}`
  }
  if (contentMode.value) return `${contentMatches.value.length} ${contentMatches.value.length === 1 ? 'match' : 'matches'}`
  return selectedPaths.value.size
    ? `${selectedPaths.value.size} selected`
    : `${visibleRows.value.length} visible`
})
const selectedFileSummary = computed(() => {
  if (contentMode.value || selectedPaths.value.size !== 1) return ''
  const row = visibleRows.value.find(item => selectedPaths.value.has(item.entry.path))
  if (!row || row.entry.isDirectory) return ''
  const parts = [row.entry.name, fileKind(row.entry)]
  if (row.gitStatus) parts.push(gitLabel(row.gitStatus))
  parts.push(formatModifiedTime(row.entry.mtime))
  parts.push(formatFileSize(row.entry.size))
  return parts.join(' · ')
})

watch(() => files.workspacePath, (path, previous) => {
  if (previous) workspaceViews.set(previous, {
    view: searchReturn?.view || viewMode.value,
    scroll: searchReturn?.scroll ?? (listRef.value?.scrollTop || 0),
  })
  const remembered = workspaceViews.get(path)
  viewMode.value = remembered?.view || 'project'
  nextTick(() => { if (listRef.value) listRef.value.scrollTop = remembered?.scroll || 0 })
  viewScroll.clear(); viewSelections.clear(); searchReturn = null
  fileSearch.clear()
  gitOnly.value = false
  contentFocusedIndex.value = -1
  resetSelection()
  // A pending name belongs to the project that is leaving: its parent folder
  // means nothing in the arriving one.
  cancelNameAction()
  if (files.workspacePath) {
    void refreshGit()
    void gitReview.openWorkspace(files.workspacePath, { force: true })
  } else {
    gitReview.clearWorkspace()
  }
})

watch(() => files.files, () => {
  if (!files.workspacePath) return
  clearTimeout(gitRefreshTimer)
  gitRefreshTimer = setTimeout(() => {
    void refreshGit()
    void gitReview.refreshChanges()
  }, 180)
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  if (files.workspacePath) {
    void refreshGit()
    void gitReview.openWorkspace(files.workspacePath, { force: true })
  }
})
onUnmounted(() => {
  clearTimeout(gitRefreshTimer)
  listResizeObserver?.disconnect()
  activityResizeObserver?.disconnect()
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
  const missing = Boolean(options.missing || normalized.missing)
  return {
    key: options.key || normalized.path,
    entry: missing ? { ...normalized, missing: true } : normalized,
    depth,
    expanded: normalized.isDirectory && files.expandedDirectories.has(normalizeRelative(normalized.relativePath)),
    loading: normalized.isDirectory && files.treeLoadingPaths.has(normalizeRelative(normalized.relativePath)),
    gitStatus: gitStatusFor(normalized),
    gitCount: gitCountFor(normalized),
    favorite: isFavorite(normalized),
    secondary: Boolean(options.secondary),
    favoriteRoot: Boolean(options.favoriteRoot),
    missing,
    editing: Boolean(options.editing),
  }
}

function sortedRows(rows) {
  if (sortKey.value === 'view') return rows
  return [...rows].sort((left, right) => compareFileRows(left, right, {
    by: sortKey.value,
    direction: sortDirection.value,
  }))
}

function flattenDirectory(parent, depth, rows, seen = new Set()) {
  const key = normalizeRelative(parent)
  if (seen.has(key)) return
  seen.add(key)
  const children = (files.treeChildren[key] || []).map(entry => makeRow(entry, depth))
  for (const row of sortedRows(children)) {
    rows.push(row)
    if (row.entry.isDirectory && row.expanded) {
      flattenDirectory(row.entry.relativePath, depth + 1, rows, seen)
    }
  }
}

function searchRows() {
  return sortedRows(pathResults.value.map((entry) => makeRow(entry, 0, { secondary: true })))
}

function recentRows() {
  const needle = query.value.trim().toLowerCase()
  const rows = editorFiles.recentFiles
    .filter(path => pathIsInsideWorkspace(path, files.workspacePath))
    .map((path) => indexedByPath.value.get(normalizePath(path)) || fallbackFileEntry(path))
    .filter((entry) => matchesEntry(entry, needle))
    .map((entry) => makeRow(entry, 0, { secondary: true, missing: !indexedByPath.value.has(normalizePath(entry.path)) }))
  return sortedRows(rows)
}

function favoriteRows() {
  const needle = query.value.trim().toLowerCase()
  const roots = []
  for (const record of favorites.value) {
    const entry = resolveFavorite(record)
    if (needle && !matchesEntry(entry, needle)) continue
    roots.push(makeRow(entry, 0, {
      favoriteRoot: true,
      secondary: true,
      missing: Boolean(entry.missing),
      key: `favorite:${record.relativePath}`,
    }))
  }
  const rows = []
  for (const row of sortedRows(roots)) {
    rows.push(row)
    if (!needle && row.entry.isDirectory && row.expanded && !row.entry.missing) {
      flattenDirectory(row.entry.relativePath, 1, rows)
    }
  }
  return rows
}

function gitChangeRows() {
  const rows = gitChanges.value.map((change) => {
    const relativePath = normalizeRelative(change.path)
    const absolute = absolutePath(relativePath)
    const entry = loadedByRelativePath.value.get(relativePath)
      || indexedByPath.value.get(normalizePath(absolute))
      || fallbackFileEntry(absolute)
    return makeRow(entry, 0, {
      key: `git:${relativePath}`,
      secondary: true,
      missing: change.status === 'deleted',
    })
  })
  return sortedRows(rows)
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

function isPendingTrashPath(path) {
  const candidate = normalizePath(path)
  return [...pendingTrashPaths.value].some((target) => {
    const normalized = normalizePath(target)
    return candidate === normalized || candidate.startsWith(`${normalized}/`)
  })
}

const compactActions = computed(() => [
  { id: 'file', label: 'New file', disabled: !files.workspacePath },
  { id: 'folder', label: 'New folder', disabled: !files.workspacePath },
  { id: 'collapse', label: 'Collapse all' },
  { id: 'refresh', label: 'Refresh' },
  { id: 'manager', label: 'Open File Manager' },
])
function compactAction(id) {
  if (id === 'manager') emit('openManager')
  else if (id === 'refresh') void refresh()
  else if (id === 'collapse') collapseAll()
  else if (id === 'file' || id === 'folder') promptNew(id)
}

function setViewMode(mode) {
  if (!searchReturn) {
    viewScroll.set(viewMode.value, listRef.value?.scrollTop || 0)
    viewSelections.set(viewMode.value, { selected: [...selectedPaths.value], focused: focusedIndex.value })
  } else {
    viewScroll.set(searchReturn.view, searchReturn.scroll)
    viewSelections.set(searchReturn.view, { selected: searchReturn.selected, focused: searchReturn.focused })
  }
  searchReturn = null
  viewMode.value = mode
  nextTick(() => { if (listRef.value) listRef.value.scrollTop = viewScroll.get(mode) || 0 })
  fileSearch.clear()
  contentFocusedIndex.value = -1
  clearSelection()
  const remembered = viewSelections.get(mode)
  if (remembered) { selectedPaths.value = new Set(remembered.selected); focusedIndex.value = remembered.focused }
  if (mode === 'changes') void gitReview.openWorkspace(files.workspacePath)
  nextTick(() => (mode === 'changes' ? gitListRef.value?.enter?.(1) : listRef.value?.focus()))
}

function selectSort(key) {
  if (!sortOptions.value.some(option => option.id === key)) return
  updateSortState(key, key === sortKey.value ? sortDirection.value : defaultSortDirection(key))
}

function selectSortDirection(direction) {
  if (!['asc', 'desc'].includes(direction) || sortKey.value === 'view') return
  updateSortState(sortKey.value, direction)
}

function sortByHeader(key) {
  const direction = key === sortKey.value
    ? (sortDirection.value === 'asc' ? 'desc' : 'asc')
    : defaultSortDirection(key)
  updateSortState(key, direction)
}

function sortHeaderDirectionLabel(key) {
  const direction = key === sortKey.value ? sortDirection.value : defaultSortDirection(key)
  return directionOptions(key).find(option => option.id === direction)?.label || ''
}

function updateSortState(key, direction) {
  const focusedPath = visibleRows.value[focusedIndex.value]?.entry.path
  sortStateByView.value = {
    ...sortStateByView.value,
    [viewMode.value]: { key, direction },
  }
  const workspaceKey = normalizePath(files.workspacePath)
  if (workspaceKey) {
    settings.set('workbenchFileSort', {
      ...(settings.workbenchFileSort || {}),
      [workspaceKey]: sortStateByView.value,
    })
  }
  const nextIndex = focusedPath
    ? visibleRows.value.findIndex(row => row.entry.path === focusedPath)
    : -1
  focusedIndex.value = nextIndex >= 0 ? nextIndex : 0
  nextTick(() => {
    const row = [...(listRef.value?.querySelectorAll('[data-file-row]') || [])]
      .find(element => element.getAttribute('data-file-row') === focusedPath)
    row?.scrollIntoView?.({ block: 'nearest' })
  })
}

function onSearchFocusOut(event) {
  searchFocused.value = Boolean(event.currentTarget?.contains(event.relatedTarget))
}

function setQueryInput(element) {
  queryInput.value = element
}

function setSearchScope(scope) {
  if (!searchScopes.some(option => option.id === scope) || searchScope.value === scope) return
  fileSearch.setScope(scope)
  contentFocusedIndex.value = -1
  clearSelection()
  nextTick(() => queryInput.value?.focus())
}

function onQueryInput() {
  if (query.value.trim() && !searchReturn) {
    searchReturn = { view: viewMode.value, scroll: listRef.value?.scrollTop || 0, selected: [...selectedPaths.value], focused: focusedIndex.value }
    if (props.compact) viewMode.value = 'project'
  }
  if (!query.value.trim()) { clearQuery(); return }
  if (viewMode.value === 'changes') return
  contentFocusedIndex.value = -1
  focusedIndex.value = 0
  selectedPaths.value = new Set()
  fileSearch.schedule()
}

function clearQuery() {
  fileSearch.clear()
  focusedIndex.value = 0
  contentFocusedIndex.value = -1
  selectedPaths.value = new Set()
  if (searchReturn) {
    const saved = searchReturn; searchReturn = null; viewMode.value = saved.view
    selectedPaths.value = new Set(saved.selected); focusedIndex.value = saved.focused
    nextTick(() => { if (listRef.value) listRef.value.scrollTop = saved.scroll })
  }
  queryInput.value?.focus()
}

function focusSearchResults(delta) {
  const matches = contentMatches.value
  if (!matches.length) return
  contentFocusedIndex.value = contentFocusedIndex.value < 0
    ? (delta > 0 ? 0 : matches.length - 1)
    : (contentFocusedIndex.value + delta + matches.length) % matches.length
  listRef.value?.focus()
  scrollContentMatchIntoView()
}

function enterSearchResults(delta) {
  if (viewMode.value === 'changes') {
    gitListRef.value?.enter?.(delta)
    return
  }
  if (contentMode.value) {
    contentFocusedIndex.value = -1
    focusSearchResults(delta)
    return
  }
  const rows = visibleRows.value
  if (!rows.length) return
  // focusList moves relative to the current row. Seed the opposite edge so
  // Down enters at the first result and Up enters at the last result.
  focusedIndex.value = delta > 0 ? rows.length - 1 : 0
  focusList(delta)
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
    if (viewMode.value === 'changes') void gitReview.refreshChanges()
    else void refresh()
  } else if (key === 'arrowleft' && viewMode.value === 'project') {
    event.preventDefault()
    collapseAll()
  }
}

function onListKeydown(event) {
  if (event.defaultPrevented) return
  if (contentMode.value) {
    onContentListKeydown(event)
    return
  }
  // The inline name field is a row of the tree. While it holds focus, typing,
  // caret motion, and text selection belong to the field, not to row
  // navigation.
  if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return
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
    else if (query.value.trim()) clearQuery()
    else clearSelection()
  }
}

function onContentListKeydown(event) {
  const matches = contentMatches.value
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    focusSearchResults(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const match = matches[contentFocusedIndex.value]
    if (match) openContentMatch(match, contentFocusedIndex.value, event.key === ' ')
  } else if (event.key === 'Escape') {
    clearQuery()
  }
}

function openContentMatch(match, index, preview) {
  contentFocusedIndex.value = index
  const entry = indexedByPath.value.get(normalizePath(match.path)) || fallbackFileEntry(match.path)
  emit('openFile', { path: match.path, line: match.line, column: match.column, preview, entry })
}

function scrollContentMatchIntoView() {
  nextTick(() => {
    const matches = listRef.value?.querySelectorAll?.('[data-content-match]') || []
    const row = matches[contentFocusedIndex.value]
    row?.scrollIntoView?.({ block: 'nearest' })
    row?.focus?.({ preventScroll: true })
  })
}

function onListContextMenu(event) {
  if (contentMode.value) return
  openEmptyContextMenu(event)
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

function openFileHistory() {
  const entry = contextEntry.value
  if (!projectHasGit.value || !entry || entry.isDirectory || !entry.textReadable) return
  closeContextMenu()
  fileHistoryEntry.value = entry
}

function closeFileHistory() {
  fileHistoryEntry.value = null
  nextTick(() => listRef.value?.focus())
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
    const [changes, status] = await Promise.all([
      loadGitChanges(files.workspacePath),
      Promise.resolve(managedProjectStatus(files.workspacePath)).catch(() => null),
    ])
    gitChanges.value = changes
    managedGitStatus.value = status
  } catch {
    gitChanges.value = []
    managedGitStatus.value = null
  }
}

function gitStatusFor(entry) {
  const relativePath = normalizeRelative(entry.relativePath)
  if (excludedGitPaths.value.has(relativePath)) return 'excluded'
  const exact = gitByPath.value.get(relativePath)
  return exact || ''
}

function gitCountFor(entry) {
  if (!entry.isDirectory) return 0
  return gitDirectoryCounts.value.get(normalizeRelative(entry.relativePath)) || 0
}

function rowHasGitChange(row) {
  return Boolean(row.gitStatus || row.gitCount)
}

function toggleGitFilter(force) {
  gitOnly.value = typeof force === 'boolean' ? force : !gitOnly.value
  clearSelection()
  contentFocusedIndex.value = -1
  nextTick(() => listRef.value?.focus())
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

function defaultSortDirection(key) {
  return ['git', 'modified', 'size', 'favorite'].includes(key) ? 'desc' : 'asc'
}

function defaultFileSortStates() {
  return Object.fromEntries(
    Object.entries(DEFAULT_FILE_SORT_STATES).map(([view, state]) => [view, { ...state }]),
  )
}

function normalizeFileSortStates(value) {
  const normalized = defaultFileSortStates()
  for (const view of Object.keys(normalized)) {
    const candidate = value?.[view]
    const keys = view === 'recent'
      ? new Set(['view', ...FILE_SORT_OPTIONS.map(option => option.id)])
      : new Set(FILE_SORT_OPTIONS.map(option => option.id))
    if (keys.has(candidate?.key) && ['asc', 'desc'].includes(candidate?.direction)) {
      normalized[view] = { key: candidate.key, direction: candidate.direction }
    }
  }
  return normalized
}

function directionOptions(key) {
  if (key === 'git') {
    return [
      { id: 'desc', label: 'Changed first' },
      { id: 'asc', label: 'Unchanged first' },
    ]
  }
  if (key === 'modified') {
    return [
      { id: 'desc', label: 'Newest first' },
      { id: 'asc', label: 'Oldest first' },
    ]
  }
  if (key === 'size') {
    return [
      { id: 'desc', label: 'Largest first' },
      { id: 'asc', label: 'Smallest first' },
    ]
  }
  if (key === 'favorite') {
    return [
      { id: 'desc', label: 'Favorites first' },
      { id: 'asc', label: 'Other files first' },
    ]
  }
  return [
    { id: 'asc', label: 'A–Z' },
    { id: 'desc', label: 'Z–A' },
  ]
}

</script>

<style scoped>
.files-compact .files-search-field { width:100%; flex:none; }
.files-compact .files-search-scopes { height:24px; align-self:flex-start; border:0; }
.files-compact .files-search { align-items:stretch; }
.files-compact :deep(.files-ledger-grid) { min-width:0; }

.files-activity {
  container: files / inline-size;
}

.files-ledger-grid {
  grid-template-columns: minmax(180px, 1fr) 86px 40px 112px 60px 28px;
}

.files-selected-detail {
  display: none;
}

@container files (max-width: 539px) {
  .files-ledger-grid {
    grid-template-columns: minmax(180px, 1fr) 40px 112px 60px 28px;
  }

  .files-ledger-kind {
    display: none;
  }
}

@container files (max-width: 479px) {
  .files-ledger-grid {
    grid-template-columns: minmax(180px, 1fr) 40px 112px 28px;
  }

  .files-ledger-size {
    display: none;
  }
}

@container files (max-width: 399px) {
  .files-view-label {
    display: none;
  }

  .files-ledger-grid {
    grid-template-columns: minmax(180px, 1fr) 40px 28px;
  }

  .files-ledger-modified {
    display: none;
  }

  .files-selected-detail {
    display: inline;
    flex: 1;
  }

  .files-footer-secondary {
    display: none;
  }
}
</style>
