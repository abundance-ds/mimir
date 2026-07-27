# Files

Files spans four state owners. Keep them separate when changing behavior:

| Projection | Canonical owner | Renderer owner/consumer |
|---|---|---|
| regular-file metadata, fuzzy path results, bounded content hits | `src-tauri/src/file_index.rs`, `file_index_commands.rs` | `src/services/fileIndex.js`, `src/stores/workspaceFiles.js` |
| immediate directory children and mutation safety | `src-tauri/src/workspace_files.rs` | `src/services/workspaceFileOperations.js`, `workspaceFiles.treeChildren` |
| open tabs and user-opened recents | — | `src/stores/files.js` |
| Project/Recent/Favorites composition, selection, inline actions, Git decoration | — | `src/mim/activities/FilesActivity.vue`, `src/mim/files/`, `src/mim/components/FileTreeRow.vue` |

The metadata index and directory tree are intentionally different projections.
The index contains reviewable regular files, respects ignore/noise rules, and
is sorted recent-first. The tree lists one directory at a time, includes
directories, applies native workspace/symlink guards, and classifies each entry
for opening. Do not derive the tree from the index: ignored or unindexed
directory structure would disappear and expansion would require a full scan.

## View composition

- Project flattens `treeChildren` according to `expandedDirectories`. Expanding
  a directory lazy-loads only that directory. A non-empty Project query
  switches to flat native index results rather than filtering the loaded tree.
- Recent is `files.recentFiles` from the Editor store, not index modification
  order. Indexed metadata enriches a path when available; a fallback row keeps
  an editor recent visible when it is absent from the current index.
- Favorites persist under
  `settings.workbenchFileFavorites[normalizedWorkspacePath]` as
  `{ relativePath, isDirectory }` records. They resolve against the loaded
  tree, then the file index, then a fallback. A loaded parent is what lets the
  UI prove a fallback is missing.
- Favorite directories can expose their loaded descendants. Renaming a
  directory rewrites favorites for the directory and every descendant.
- Git status is loaded independently by `FilesActivity.vue`; directory status
  is a derived descendant marker and is not stored in either file projection.

`FilesActivity.vue` composes ephemeral surface state while focused controllers
under `src/mim/files/` own selection/navigation, context-menu lifetime,
favorites identity, path normalization, and filesystem mutations. Mutation
state and cleanup must stay in `useFileMutations.js`; tree rows remain
presentation-only.
`workspaceFiles.js` owns reusable index/search tokens and directory caches.
`FileTreeRow.vue` is presentation plus ARIA only; moving operational state into
the row creates per-row authorities and breaks keyboard/multi-select behavior.

## Open and tab semantics

`WorkspaceEntry.openBehavior` is native classification:

| Value | Editor behavior |
|---|---|
| `directory` | toggle the Files tree; never create an Editor tab |
| `text` | read through `read_text_file` and mount CodeMirror |
| `pdf` | read bytes and render the PDF preview |
| `external` | mount metadata/default-app actions without reading as text |

`src/editor/App.vue::mimOpen` trusts a supplied entry only when it already has
`openBehavior`; every other caller is classified by
`workspace_file_inspect`. Keep that inspection on any new open path so binary
files are not sent through the UTF-8 command.

A single-click Files activation requests `preview: true`; an existing clean
preview tab is reused. Enter/double-click requests a pinned tab. Editing a text
preview or reopening it pinned clears its preview status. Resource previews
are non-editable/non-saveable and bypass CodeMirror, inline AI, the formatting
toolbar, and the editor footer.

Files mutations reconcile open Editor state before refreshing projections:

- rename waits for pending writes, performs the native move, then rewrites
  Editor paths and affected favorite paths;
- Trash waits for pending writes, uses the OS Trash, then lets the Editor close
  clean tabs or preserve dirty text as drafts;
- successful mutations immediately force-reload only their affected parent
  directories; the native watcher reconciles the metadata index, avoiding a
  second whole-workspace scan;
- explicit user refresh rebuilds the metadata index and force-reloads every
  directory that has already entered `treeChildren`; unopened subtrees remain
  lazy.

Do not refresh the UI before the Editor reconciliation methods complete:
path-based tab ownership and dirty-buffer recovery depend on seeing the old
paths.

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

## Change map

| Change | Inspect together | Focused verification |
|---|---|---|
| scan, ordering, ignore, path/content query | `file_index.rs`, `file_index_commands.rs`, `fileIndex.js`, `workspaceFiles.js`, Quick Open | native index tests; store and Quick Open tests |
| tree load/expand/refresh | `workspace_files.rs`, `workspaceFileOperations.js`, `workspaceFiles.js`, `FilesActivity.vue` | native workspace-file, service, store, Files Activity tests |
| row visuals, focus, selection, context actions | `FilesActivity.vue`, `mim/files/useFileSelection.js`, `useFileContextMenu.js`, `FileTreeRow.vue` | Files Activity and file-controller tests |
| favorites | `mim/files/useFileFavorites.js`, `stores/settings.js`, settings persistence | file-controller, Files Activity, and settings tests |
| open classification/preview tabs | `workspace_files.rs`, `workspaceFileOperations.js`, `editor/App.vue`, `stores/files.js`, `FilePreviewPage.vue`, `PdfPreview.vue`, `fileSystem.js` | workspace-file/service, Editor, file-store, preview tests |
| external edit refresh | `file_index_commands.rs`, `useExternalFileSync.js`, `stores/files.js`, `EditorSurface.vue` | native index, external-sync, file-store, and EditorSurface tests; desktop CLI-edit smoke |
| rename/Trash with open buffers | `mim/files/useFileMutations.js`, `stores/files.js`, `workspace_files.rs` | file-controller, Files Activity, file-store, native mutation tests |
| MCP mutation surface | `tool_runtime.rs`, renderer file tool handlers, `workspace_files.rs` | tool runtime and native mutation tests |
