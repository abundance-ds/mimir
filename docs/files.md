# Files

## Sidebar browser

Sidebar has File tree, Favorites, and Recent views, a file actions menu, and
a search field. Below 192 px, one view menu replaces the three view buttons.
Layout and sizing belong to
[workbench-design.md](workbench-design.md) and
[design-system.md](design-system.md).

- Each view keeps selection and scroll across view switches. Folder expansion
  and the chosen view persist across project switches in the app session.
- `useFileSearch.js` owns query, results, and status per presentation. After a
  130 ms debounce it publishes filename hits, then appends content hits without
  moving or duplicating filename results. Each file appears once.
  Sidebar, File Manager, and Quick Open searches stay independent. Clear, query
  changes, workspace changes, and unmount invalidate late responses. A changed
  index reruns the active query. A failed content search keeps filename
  results. Bounded searches report omitted results.
- Search covers the project from any view. Clear and Escape restore the
  previous view, selection, and scroll.
- Native content search returns one location per file in the combined list so
  one file cannot consume the result budget. Other callers keep multi-location
  behavior. Limits and token-scoped cancellation apply to both.
- File actions menu: New file, New folder, Name, Modified, Refresh, Collapse
  all, Open File Manager. Name and Modified are sort rows; selecting the active
  row reverses it. Folders stay first in either direction. Sort settings are
  saved per project and view. Name and Modified orders are shared with File
  Manager; its other sort fields fall back to the view default in the sidebar.
  Recent defaults to recently-opened order with no row checked. Sort rows are
  disabled during search. No Created field (file data has no creation date).
- Collapse all applies to the sidebar and File Manager. A folder load started
  before collapse must not reopen the folder.
- Single click or Space previews a file (focus stays in Files). Double-click
  opens and moves focus to Editor. Editing a preview keeps its tab. Later
  previews replace only an unchanged preview tab. Previews and search matches
  do not replace the main session or collapse the sidebar.
- Return renames on macOS (Command+Down opens); F2 renames on other platforms.
  In search, Enter opens. Click elsewhere confirms a rename; window blur or a
  hidden field does not. IME composition and key repeat neither start nor
  confirm rename. These rules apply to both sidebar and File Manager.
- Native drops apply only to an active file surface.
- File Manager opens as a unique main tab. Both presentations use the same
  stores and mutation commands.

## Architecture

- `file_index.rs` owns a recent-first index of regular files for path and
  bounded content search. A `text_readable` flag marks content-searchable
  entries; non-text files remain in the index for path search.
- `workspace_files.rs` owns the lazy directory tree, file classification, and
  mutation boundary. The tree includes directories and must not be derived
  from the index.
- `stores/files.js` owns open tabs and recents. `workspaceFiles.js` owns the
  index, Quick Open's path filter, loaded tree children, and the queue that
  keeps each presentation's native content search separate.
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

## Verification

- `WorkbenchFiles.integration.test.js` mounts Files with the real Editor.
  Native I/O is mocked; check focus sequences in the native macOS app before
  release.
- `harness/files.html` mounts sidebar and File Manager with fixture native
  replies. Check 120, 240, 280, and 400 px in light and dark. Search `alpha`/`beta`
  for matches; `limit`, `error`, `slow` for partial results, failure, and
  cancellation. It does not test the native index.
- Native-app checks require a disposable workspace in a current build. Open
  gaps live in [issues.md](issues.md).

## Managed Project Git

- A GitHub `origin` enables quiet managed sync. A new Mimir workspace starts
  as local Git and accepts only an existing empty GitHub repository URL.
- One local batch closes after five quiet minutes, thirty continuous minutes,
  or application close. Routine sync state stays out of the UI unless it fails.
- Automatic commits exclude ignored files, binaries, and files larger than
  10 MiB, including deletion of a tracked file that now meets an exclusion.
- A manual commit ahead of GitHub is pushed by the next sync. File History also
  works in manual and nested Git repositories.
