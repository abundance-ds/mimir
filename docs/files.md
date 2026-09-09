# Files

## Sidebar browser

Files stays beside the main tabs and Editor. Its compact view has File tree, Favorites, and Recent icon buttons,
one file actions menu, and a full-width search field. The project selector
at the top of the sidebar sets the file scope. The Sidebar Tools group can collapse to make
more room. Main tab and sidebar structure belongs to
[workbench-design.md](workbench-design.md).

- Project uses 28 px rows, 12 px indentation per folder, and subtle vertical
  guides without horizontal row separators. Names keep their extension visible when shortened. Git state uses a
  small marker; metadata columns and permanent star buttons are omitted.
- Recent and Favorites replace the tree with path-labelled lists. Each view
  retains selection and scroll while switching views. Project folder expansion
  and the chosen view are remembered across project switches in the app session.
- Compact search covers the project even when started from Recent or Favorites.
  Names / Contents controls appear on focus and while a query is active.
  Clear and Escape restore the previous view, selection, and scroll, and reset
  the scope to Names. Each view button leaves search and opens that view.
  The clear control stays available while a search is in progress.
- `useFileSearch.js` owns query, scope, results, request generation, and status
  for each file presentation. Path searches read their native response directly;
  they do not use Quick Open's shared query. Sidebar and File Manager results,
  errors, and loading states are separate. Clear, scope changes, workspace
  changes, and unmount invalidate late responses. A changed index reruns the
  active query. Cancelled and failed searches show a retry control, not an
  empty result. Partial searches describe only the files searched.
- One file actions menu lists New file, New folder, Collapse all, Refresh,
  and Open File Manager. Right-click exposes file commands, including Favorites.
  Hover shows the relative path. There is no selected-path footer.
  Native drops apply only to an active file surface.
- File previews and search matches open in the Editor without replacing the
  main session or collapsing a manually expanded sidebar. Content matches
  reveal their line and column; a single click previews and a double click pins.
- Open File Manager provides the wide ledger in a unique main tab for metadata
  comparison and file organization. Its Return control selects the session
  that was active before opening it. Both presentations use the same file
  stores and mutation commands.

## Architecture

- `file_index.rs` owns a recent-first index of reviewable regular files for
  path and bounded content search.
- `workspace_files.rs` owns the lazy directory tree, file classification, and
  mutation boundary. The tree includes directories and must not be derived
  from the index.
- `stores/files.js` owns open tabs and recents. `workspaceFiles.js` owns the
  index, Quick Open's path filter, loaded tree children, and the queue that
  keeps each presentation's native content search separate.
- Project `graph/`, `skills/`, and `agents/` directories are ordinary files in
  this surface. Their special behavior belongs to their own runtimes.

## Non-obvious contracts

- `harness/files.html` mounts the real sidebar and File Manager with fixture
  native replies. Use it with the dev server to check 240, 280, and 400 px
  widths in light and dark themes. Search `alpha` or `beta` for matches,
  or use Contents with `limit`, `error`, and `slow` for partial results,
  failure, and cancellation. It does not test the native index.

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
