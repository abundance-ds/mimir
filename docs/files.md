# Files

Files is a recent-first review inbox for the open workspace.

## Index

`src-tauri/src/file_index.rs` walks the workspace with ignore-aware filtering,
keeps reviewable regular files, and orders them by modification time with a
deterministic path tie-breaker. Entries include absolute and relative paths,
name, size, and modification time.

Opening a workspace replaces the current index. The renderer polls a cheap
native refresh and reloads entries only when files were added, removed, or
changed.

## Navigation

The Files Activity has two modes:

- **Paths** fuzzy-ranks the in-memory native index, using recency as the
  tie-breaker.
- **Content** runs cancellable bounded search and shows path, line, column, and
  excerpt.

Arrow keys move path selection and Enter opens the selected file in the
existing Editor. Double-click also opens a path. Content hits open their file
directly.

Cmd/Ctrl+P opens `src/mim/components/QuickOpen.vue` over the workbench. It uses
the same workspace index and sends the chosen path to the mounted Editor.

## Bounds and cancellation

Content search has explicit limits for results, files, bytes, and per-file
reads. Starting another search cancels the previous token. The UI reports when
results were truncated so the user can narrow the query.

## Relevant code

- `src-tauri/src/file_index.rs`
- `src-tauri/src/file_index_commands.rs`
- `src/services/fileIndex.js`
- `src/stores/workspaceFiles.js`
- `src/mim/activities/FilesActivity.vue`
- `src/mim/components/QuickOpen.vue`
- `src/services/fileSystem.js`
- `src/stores/files.js`
