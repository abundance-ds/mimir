# Files

## Architecture

- `file_index.rs` owns a recent-first index of reviewable regular files for
  path and bounded content search.
- `workspace_files.rs` owns the lazy directory tree, file classification, and
  mutation boundary. The tree includes directories and must not be derived
  from the index.
- `stores/files.js` owns open tabs and recents. `workspaceFiles.js` owns index
  results, searches, and loaded tree children.
- Project `graph/`, `skills/`, and `agents/` directories are ordinary files in
  this surface. Their special behavior belongs to their own runtimes.

## Non-obvious contracts

- Inspect an entry before opening it. Text, PDF, and external files use
  different Editor paths; binary content must not enter the text command.
- Native path checks reject traversal, symlink escape, root mutation, and
  overwrite. The index is not a permission boundary.
- Rename, move, and Trash must settle pending Editor writes before they change
  paths. Dirty text survives Trash as a draft.
- Outside drag-and-drop uses Tauri file-drop events and copies files. Internal
  pointer drag moves files. Browser drag events are not authoritative.
- External moves preserve open tabs only when the native index can pair their
  filesystem identity safely.

## Managed Project Git

- A GitHub `origin` enables quiet managed sync. A new Mimir workspace starts
  as local Git and accepts only an existing empty GitHub repository URL.
- One local batch closes after five quiet minutes, thirty continuous minutes,
  or application close. Routine sync state stays out of the UI unless it fails.
- Automatic commits exclude ignored files, binaries, and files larger than
  10 MiB, including deletion of a tracked file that now meets an exclusion.
- A manual commit ahead of GitHub is pushed by the next sync. File History also
  works in manual and nested Git repositories.
