# Files

## Sidebar browser

Files stays beside the main tabs and Editor. Its compact view has File tree, Favorites, and Recent icon buttons,
one file actions menu, a Collapse control beside that menu, and a full-width
search field. The project selector
at the top of the sidebar sets the file scope. Files can collapse and resize;
main tab and sidebar structure belongs to
[workbench-design.md](workbench-design.md).

- Project uses 28 px rows, 12 px indentation per folder, and subtle vertical
  guides without horizontal row separators. Names keep their extension visible when shortened. Git state uses a
  small marker; metadata columns and permanent star buttons are omitted.
- Recent and Favorites replace the tree with path-labelled lists. Each view
  retains selection and scroll while switching views. Project folder expansion
  and the chosen view are remembered across project switches in the app session.
- One search field searches filenames first, then file contents automatically.
  Focusing it does not add controls or change the layout. Filename results use
  the native ranking: exact name, name prefix, name substring, then fuzzy path
  match, with modification time as a tie-breaker. Content results follow in
  recent-first order. Each file appears once; content-only results include a
  line location and excerpt. Literal matches are highlighted as safe text.
- Compact search covers the project even when started from Recent or Favorites.
  Clear and Escape restore the previous view, selection, and scroll. Each view
  button leaves search and opens that view. The clear control stays available
  during search. Up/Down enters the results; Enter in the field opens the first
  result. Result rows support Up/Down, Home/End, Enter to open, and Space to preview.
- `useFileSearch.js` owns query, results, request generation, and status for
  each presentation. After a 130 ms debounce it publishes filename hits, then
  appends content hits without moving or duplicating the filename results.
  Sidebar and File Manager results, errors, and loading states stay separate
  from each other and from Quick Open. Clear, query changes, workspace changes,
  and unmount invalidate late responses. A changed index reruns the active query.
  A failed content search retains filename results and offers Retry. Bounded
  searches report when results were omitted, including after an empty response.
- Native content search can return one location per file for this combined list.
  One file with many matching lines cannot consume the whole result budget.
  Other callers retain their existing multiple-location behavior. File count,
  byte, and result limits and token-scoped cancellation still apply.
- One file actions menu lists New file, New folder, Refresh,
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

- Search regression tests cover index loading after mount, independent panel
  queries, late responses, cancellation, retry, partial results, and return to
  browsing. Files and Editor integration tests cover match locations and
  preview/pin behavior. Native `file_index` tests cover ranking, search limits,
  cancellation, and workspace changes.
- `harness/files.html` mounts the real sidebar and File Manager with fixture
  native replies. Use it with the dev server to check 240, 280, and 400 px
  widths in light and dark themes. Search `alpha` or `beta` for matches,
  or search `limit`, `error`, and `slow` for partial results,
  failure, and cancellation. It does not test the native index.
- Before closing native-app verification, use a disposable workspace in the
  current Mimir build. Check filename and content search, opening a match at
  its line, Clear/Escape and all view buttons, and independent searches with
  File Manager open. Also check a workspace switch during search, an external
  file change, native file drops, and menu focus. Record the build and result;
  browser fixtures cannot establish this evidence. Open gaps live in
  [issues.md](issues.md).

Native development check, 2026-09-12 (0.3.2 working tree): a disposable
workspace returned filename hits before content hits, with one result per file.
Opening a content hit placed the cursor on its line. Sidebar and File Manager
queries stayed separate. The Files height survived collapse and restore. The
header Collapse control, full-height file list, and bottom rail restore icon
were checked in the current native window. Native file-drop and pending-search
workspace-switch checks remain open in [issues.md](issues.md).

## Managed Project Git

- A GitHub `origin` enables quiet managed sync. A new Mimir workspace starts
  as local Git and accepts only an existing empty GitHub repository URL.
- One local batch closes after five quiet minutes, thirty continuous minutes,
  or application close. Routine sync state stays out of the UI unless it fails.
- Automatic commits exclude ignored files, binaries, and files larger than
  10 MiB, including deletion of a tracked file that now meets an exclusion.
- A manual commit ahead of GitHub is pushed by the next sync. File History also
  works in manual and nested Git repositories.
