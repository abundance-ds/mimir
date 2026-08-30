# Files

Files spans five state owners. Keep them separate when changing behavior:

| Projection | Canonical owner | Renderer owner/consumer |
|---|---|---|
| regular-file metadata, fuzzy path results, bounded content hits | `src-tauri/src/file_index.rs`, `file_index_commands.rs` | `src/services/fileIndex.js`, `src/stores/workspaceFiles.js` |
| immediate directory children and mutation safety | `src-tauri/src/workspace_files.rs` | `src/services/workspaceFileOperations.js`, `workspaceFiles.treeChildren` |
| open tabs and user-opened recents | — | `src/stores/files.js` |
| Project/Recent/Favorites composition, selection, inline actions, Git decoration | — | `src/mimir/activities/FilesActivity.vue`, `src/mimir/files/`, `src/mimir/components/FileTreeRow.vue`, `FileSortHeader.vue`, `FileSortMenu.vue` |
| Git change scopes, review snapshots, and index actions | `src-tauri/src/git.rs` | `src/services/gitReview.js`, `src/stores/gitReview.js`, `GitChangesList.vue` |

The metadata index and directory tree are intentionally different projections.
The index contains reviewable regular files, respects ignore/noise rules, and
is sorted recent-first. The tree lists one directory at a time, includes
directories, applies native workspace/symlink guards, and classifies each entry
for opening. Do not derive the tree from the index: ignored or unindexed
directory structure would disappear and expansion would require a full scan.

Project `graph/`, `skills/`, and `agents/` folders are ordinary repository
content. Files shows them through the normal tree and Git projections; their
special meaning belongs to the graph and agent runtimes.

## View composition

- Project flattens `treeChildren` according to `expandedDirectories`. Expanding
  a directory lazy-loads only that directory. A non-empty Project query
  switches to flat native index results rather than filtering the loaded tree.
- Recent is the active workspace subset of `files.recentFiles` from the Editor
  store, not index modification order. Indexed metadata enriches a path when
  available; a fallback row keeps an in-workspace editor recent visible when
  it is absent from the current index. Paths from another project are retained
  in history but do not appear as missing rows in the open project. Clear
  Recent removes only the active project's entries in the embedded Workbench.
- Favorites persist under
  `settings.workbenchFileFavorites[normalizedWorkspacePath]` as
  `{ relativePath, isDirectory }` records. They resolve against the loaded
  tree, then the file index, then a fallback. A loaded parent is what lets the
  UI prove a fallback is missing.
- Favorite directories can expose their loaded descendants. Renaming a
  directory rewrites favorites for the directory and every descendant.
- Files is an adaptive ledger. At the default Activity width each row aligns
  Name, Kind, Git, Modified, Size, and Favorite. Kind leaves first as the pane
  narrows, then Size, then Modified; the selected file's metadata moves to the
  footer at the minimum pane width. Modified uses the exact local
  `YYYY-MM-DD HH:mm` value, not a changing relative age. Directory time and
  size show `—` because a folder timestamp is not a reliable summary of its
  descendants. Favorite controls remain visible instead of appearing only on
  hover.
- Every visible ledger header is a sort control: Name, Kind, Git, Modified,
  Size, and Favorite. The first click selects the column with its useful
  default order; the next click reverses it. The active header shows one
  direction arrow. A secondary header menu exposes columns that responsive
  layout hides and restores Recent's `Recently opened` order. Project sorts
  each directory's immediate children and keeps folders before files, so
  sorting does not flatten or destabilize the tree. Selection and keyboard
  position follow the same file after rows move. Sort state persists per
  workspace and view under `settings.workbenchFileSort`.
- Paths filters names and relative paths. Contents runs the bounded native
  content search and shows file, line, column, and excerpt. The scope control
  remains visible, and Recent/Favorites content results stay inside their
  current projection.
- Git status is loaded independently by `FilesActivity.vue`; folders show a
  changed-descendant count rather than one inherited status. The footer count
  is a visible filter control. In Project it opens a complete flat Git-change
  queue with parent paths, including deleted or not-yet-loaded entries. The
  named `Git changes` filter composes with path/content search and clears from
  the surface.
- Changes is a separate review queue. It keeps staged and unstaged state
  distinct and filters the queue by All, Unstaged, or Staged. Selecting a row
  opens an immutable Git snapshot in the Editor. This does not open, edit, or
  replace the file buffer. A folder that is not a Git repository gets a quiet
  setup state instead of a native library error. The original Project Git
  filter remains available.

`FilesActivity.vue` composes ephemeral surface state while focused controllers
under `src/mimir/files/` own selection/navigation, context-menu lifetime,
favorites identity, path normalization, and filesystem mutations. Mutation
state and cleanup must stay in `useFileMutations.js`; tree rows remain
presentation-only.
`workspaceFiles.js` owns reusable index/search tokens and directory caches.
`FileTreeRow.vue`, `FileSortHeader.vue`, and `FileSortMenu.vue` own presentation
and ARIA only; moving file or sort authority into them creates per-row or
per-control authorities and breaks the Activity's shared ordering and keyboard
behavior.

## Open and tab semantics

`WorkspaceEntry.openBehavior` is native classification:

| Value | Editor behavior |
|---|---|
| `directory` | toggle the Files tree; never create an Editor tab |
| `text` | read through `read_text_file` and mount CodeMirror |
| `pdf` | read bytes and render the PDF preview |
| `external` | mount metadata/default-app actions without reading as text |

`src/editor/App.vue::mimirOpen` trusts a supplied entry only when it already has
`openBehavior`; every other caller is classified by
`workspace_file_inspect`. Keep that inspection on any new open path so binary
files are not sent through the UTF-8 command.

Single-click requests `preview: true` (reuses an existing clean preview tab).
Enter/double-click pins. Editing a preview or reopening it pinned clears
preview status. Preview reuse is limited to the visible workspace projection,
so switching projects does not replace a hidden preview. Resource previews
bypass CodeMirror and inline AI.

For Editor reconciliation, preview lifecycle, and save semantics see
[editor-system.md](editor-system.md).

Files mutations reconcile open Editor state before refreshing projections:

- rename waits for pending writes, performs the native move, then rewrites
  Editor paths and affected favorite paths;
- Trash waits for pending writes, uses the OS Trash, then lets the Editor close
  clean tabs or preserve dirty text as drafts;
- after confirmation, Trash hides the affected rows and closes the dialog
  immediately. This is a presentation-only optimistic state: native Trash and
  Editor reconciliation remain authoritative. A failure reloads the affected
  parents, restores entries that still exist, and reports the error on the
  Files surface;
- the Editor's explicit discard command has a separate confirmed-buffer
  contract; see [Editor](editor-system.md#files-and-tabs);
- successful mutations immediately force-reload only their affected parent
  directories; the native watcher reconciles the metadata index;
- explicit user refresh rebuilds the metadata index and force-reloads every
  directory that has already entered `treeChildren`; unopened subtrees remain
  lazy.

Do not refresh the UI before the Editor reconciliation methods complete:
path-based tab ownership and dirty-buffer recovery depend on seeing the old
paths.

## Dropping files in from outside

Tauri intercepts OS drags before the webview sees them.
`src/mimir/files/useFileDrop.js` subscribes to the webview drag-drop event
(real filesystem paths, not HTML `drop`). Hit-testing converts position to CSS
pixels and walks up to `[data-file-row]` inside `[data-files-list]`.

Platform coordinate conversion is the silent failure point -- see
[gotchas.md](gotchas.md#physicalposition-on-a-drag-drop-event-is-not-physical).

Import contract:

- `workspace_file_import` copies, never moves (drop must not remove the
  original).
- Dropped aliases are canonicalized; symlinks inside dropped folders are
  skipped (`ImportReport.skippedLinks`).
- Per-item atomicity: each source lands completely or not at all. Failures
  recorded in `ImportReport.failures`; one bad item never discards the rest.
  Partial copies are cleaned up (destination name is always fresh).
- Batch-level problems (no sources, unusable destination) are hard errors.
- `FilesActivity.vue` reconciles the destination on every outcome including
  rejected invokes; skipping it on error would leave arrivals invisible.

## Moving rows between folders

Dragging rows within the Project tree moves them (`workspace_file_move`),
unlike an outside drop, which copies. Internal drags are pointer-driven
through `src/mimir/files/useFileTreeDrag.js` — HTML5 DnD never fires inside
the webview (see
[gotchas.md](gotchas.md#html5-drag-and-drop-is-dead-inside-the-webview)) —
and reuse the external drop path's hit-testing, spring-open, and edge-scroll
behavior.

- Only the plain Project tree offers dragging. Filtered, Recent, and
  Favorites rows are projections whose position says nothing about where a
  drop would land.
- Dragging a selected row carries the whole selection; descendants of another
  dragged folder are dropped from the batch because they travel with their
  parent.
- A drop that would move nothing (same parent, or a target inside a dragged
  folder) offers no drop target rather than a highlight a drop would ignore.
- The native move refuses overwrites and keeps a same-parent drop a no-op;
  per-item failures report themselves without discarding the rest.
- Moves reconcile like renames: pending Editor writes are awaited first, then
  open-tab paths and favorites are rewritten, then source parents and the
  destination force-reload.

## Index/search concurrency

The index is an in-memory projection and not a permission boundary. Its native
watcher debounces filesystem events. Ordinary edits and deletes update the
touched index entries in place; creates, renames, directory changes, and
ignore-rule changes fall back to an ignore-aware scan for correctness.
Replacing the workspace increments a workspace generation and invalidates
every outstanding search. Path queries also carry a renderer generation so
late fuzzy results cannot overwrite a newer query.

Content search clones the metadata snapshot before disk reads and never holds
the index lock while scanning. It has native result/file/total-byte/per-file
limits and token-scoped cancellation. Exact bounds and exclusions are
canonical constants in `src-tauri/src/file_index.rs`. Content search remains a
store/index capability; do not infer that every Files view exposes it. Known
source/document extensions are classified without opening their contents;
only unknown extensions receive the bounded binary/UTF-8 probe.

Workspace scans and mutations use blocking workers rather than Tauri invoke
threads. The watcher sends changed-entry metadata for ordinary edits, so the
renderer patches that file and reloads only its loaded parent directory.
Structural changes send one authoritative index snapshot. Files does not poll
while idle, and Activity navigation never starts a workspace scan.

A structural rescan also pairs disappeared and appeared paths that share a
filesystem identity and reports them as `moves`: an external `mv`, `git mv`,
or Finder drag repoints open Editor tabs, drafts, recents, and file favorites
instead of orphaning them. Pairing is deliberately conservative — same volume,
identity unique on both sides — so a copy-then-delete or a cross-volume move
stays a delete plus create, and a favorite naming a moved *directory*
(directories have no index identity) stays behind as missing, as before. See
[gotchas.md](gotchas.md#external-move-recognition-is-identity-based-and-best-effort).

## Native and MCP boundary

`workspace_files.rs` canonicalizes the indexed root and rejects traversal,
symlink escapes, workspace-root mutation, overwrite, separator-bearing rename
input, and missing paths. Index exclusions are search/performance policy, not
authorization.

The same guarded mutation implementation backs these registry tools:

| Canonical | Alias | Distinct contract |
|---|---|---|
| `files.browse` | `files_browse` | immediate directory entries, not index results |
| `files.create_folder` | `files_create_folder` | directory creation |
| `files.rename` | `files_rename` | one exact workspace entry |
| `files.duplicate` | `files_duplicate` | deterministic non-overwriting copy name |
| `files.trash` | `files_trash` | recoverable OS Trash move |

`files.create`/`create` remains the core text-file tool, not an alias for
`files.create_folder`. Top-level generic file commands and the embedded App SDK
are broader trusted APIs and do not inherit the indexed-workspace boundary.
See [security.md](security.md).

These registry tools are internal plumbing for the embedded App SDK and UI
runtime — they are not the agent surface, and their existence here says
nothing about what agents can call. Which file capability agents get, and
why, is owned solely by [agent-interface.md](agent-interface.md).
Registry-relayed `files.rename` and `files.trash` reconcile open Editor
buffers the way the Files panel does: pending writes settle first, then tabs
repoint or release.

## Change map

| Change | Inspect together | Focused verification |
|---|---|---|
| scan, ordering, ignore, path/content query | `file_index.rs`, `file_index_commands.rs`, `fileIndex.js`, `workspaceFiles.js`, Quick Open | native index tests; store and Quick Open tests |
| tree load/expand/refresh | `workspace_files.rs`, `workspaceFileOperations.js`, `workspaceFiles.js`, `FilesActivity.vue` | native workspace-file, service, store, Files Activity tests |
| row ledger, metadata formatting, sorting, focus, selection, context actions | `FilesActivity.vue`, `mimir/files/fileLedger.js`, `mimir/files/useFileSelection.js`, `useFileContextMenu.js`, `FileTreeRow.vue`, `FileSortHeader.vue`, `FileSortMenu.vue` | Files Activity, ledger, and file-controller tests |
| favorites | `mimir/files/useFileFavorites.js`, `stores/settings.js`, settings persistence | file-controller, Files Activity, and settings tests |
| Git queue, snapshot review, stage/unstage | `git.rs`, `gitReview.js` service/store, `GitChangesList.vue`, Editor Git review surface, Workbench agent handoff | native Git tests; Git service/store/components; Files Activity, Editor tab, and Workbench bridge tests |
| open classification/preview tabs | `workspace_files.rs`, `workspaceFileOperations.js`, `editor/App.vue`, `stores/files.js`, `FilePreviewPage.vue`, `PdfPreview.vue`, `fileSystem.js` | workspace-file/service, Editor, file-store, preview tests |
| external edit refresh | `file_index_commands.rs`, `useExternalFileSync.js`, `stores/files.js`, `EditorSurface.vue` | native index, external-sync, file-store, and EditorSurface tests; desktop CLI-edit smoke |
| external move/rename reconciliation | `file_index.rs` (identity pairing), `file_index_commands.rs`, `stores/workspaceFiles.js`, `stores/files.js`, favorites in `stores/settings.js` | native index move tests; workspaceFiles store tests |
| rename/Trash/move with open buffers | `mimir/files/useFileMutations.js`, `stores/files.js`, `workspace_files.rs` | file-controller, Files Activity, file-store, native mutation tests |
| drag and drop from outside | `mimir/files/useFileDrop.js`, `FilesActivity.vue`, `FileTreeRow.vue`, `workspace_files.rs` | drop-composable, Files Activity, native import tests |
| drag rows between folders | `mimir/files/useFileTreeDrag.js`, `useFileMutations.js`, `FilesActivity.vue`, `workspace_files.rs` | tree-drag composable, file-controller, Files Activity, native move tests |
| MCP mutation surface | `tool_runtime.rs`, renderer file tool handlers, `workspace_files.rs` | tool runtime and native mutation tests |
