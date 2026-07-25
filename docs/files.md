# Files

Files is a recent-first review inbox and a complete workspace browser. Recent
keeps changed material close at hand; Browse exposes folders and file
operations without turning the Sidebar into a tree.

## Surfaces

The Files Activity starts in **Recent** and has two stable views:

- **Recent** lists indexed files by modification time with deterministic path
  tie-breaking.
- **Browse** lists the current folder, directories first, with an up control and
  workspace-relative breadcrumbs.

The header keeps New file, New folder, Refresh, path search, and text search
visible. Loading, inaccessible-workspace, empty-folder, empty-search, and
bounded-search states each explain the state and expose the relevant recovery
action.

Cmd/Ctrl+P remains the global quick-open path. It uses the same index and opens
the selected path in the mounted Editor.

## File operations

The toolbar, row context menu, and empty-surface context menu share the same
native operations:

- create a file or folder in the visible directory;
- open text in the Editor or open any file in its default system application;
- rename and duplicate files or folders;
- reveal an item in Finder/Explorer;
- copy its absolute or workspace-relative path;
- move one or several selected items to the system Trash after confirmation.

Open Editor paths follow folder and file renames. Trashing a clean open file
closes its tab; unsaved text survives as an untitled dirty document.

Every mutation is scoped by the native open-workspace index. Rust canonicalizes
the root and rejects traversal, symlink escapes, workspace-root mutation,
overwrites, separator-bearing rename input, and missing paths. Files and
folders go to the OS Trash rather than being hard-deleted.

The same workspace-safe native operations are available through the canonical
MCP registry:

| Canonical | Alias | Result |
|---|---|---|
| `files.browse` | `files_browse` | immediate directory entries and metadata |
| `files.create_folder` | `files_create_folder` | created folder entry |
| `files.rename` | `files_rename` | renamed entry |
| `files.duplicate` | `files_duplicate` | deterministic copy entry |
| `files.trash` | `files_trash` | exact paths moved to system Trash |

`files.create` and its `create` alias still mean “create a text file”; that
existing contract is unchanged. Manager mutations take explicit paths and go
through the same Rust root, traversal, symlink, overwrite, and workspace-root
guards as the Files UI. `files.trash` is deliberately named and described as a
destructive workspace-location change, while remaining recoverable from the
operating-system Trash.

## Keyboard and selection

The list supports Arrow Up/Down, Enter, Space, Shift-range selection,
Cmd/Ctrl-click toggles, and Cmd/Ctrl+A. Shortcuts operate only while Files owns
focus:

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+N | New file |
| Shift+Cmd/Ctrl+N | New folder |
| Cmd/Ctrl+F | Focus search |
| Cmd/Ctrl+R | Refresh |
| F2 | Rename focused item |
| Cmd/Ctrl+Backspace or Delete | Confirm move selection to Trash |
| Backspace | Go to the parent folder while browsing |
| Shift+F10 / Context Menu | Open the focused row menu |

Context menus use roving Arrow/Home/End navigation, Enter/Space activation, and
Escape return to the Files list.

## Index, search, and performance

`src-tauri/src/file_index.rs` walks the workspace with ignore-aware filtering
and keeps reviewable regular-file metadata in memory. Path filtering is native
and fuzzy-ranked. Text search is cancellable and bounded by result, file, total
byte, and per-file byte limits; results carry path, line, column, and excerpt.

Workspace scans and filesystem mutations run on blocking worker threads, never
the Tauri invoke thread. Files does not poll and rebuild the workspace every
1.2 seconds. It refreshes when the surface is reopened, when the user requests
it, and after its own mutations. This keeps terminal and editor interaction
quiet while still giving Files an explicit current-state path.

## Relevant code

- `src-tauri/src/file_index.rs`
- `src-tauri/src/file_index_commands.rs`
- `src-tauri/src/workspace_files.rs`
- `src/services/fileIndex.js`
- `src/services/workspaceFileOperations.js`
- `src/stores/workspaceFiles.js`
- `src/mim/activities/FilesActivity.vue`
- `src/mim/components/QuickOpen.vue`
- `src/services/fileSystem.js`
- `src/stores/files.js`
