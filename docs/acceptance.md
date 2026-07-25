# Product acceptance contract

This is the release behavior contract for Mim 0.1.0. Unit tests support these
requirements; they do not replace runtime verification.

## Workbench

- The main window is one edge-to-edge Sidebar / Activity / Editor workbench.
- Editor is mounted and visibly expanded on startup.
- The Sidebar starts expanded and can collapse to a 52px live rail without
  reordering rows or losing status.
- Apps and Activities disclose independently in the expanded Sidebar; the live
  rail continues to expose both lists regardless of disclosure state.
- Activity and Editor can each collapse to a mounted 44px rail.
- Activity and Editor cannot both remain railed; recovery always leaves a
  usable content surface.
- Activity and Editor each expose expand/restore-split and directional
  collapse controls in their own header.
- Railing Activity lets Editor reclaim all released width; no dead surface is
  left to its right.
- Both dividers use a persistent one-pixel rule inside a six-pixel resize
  target, and persisted widths restore on relaunch.
- Debounced pane widths, Activity order, and preferences flush in serialized
  snapshot order on Workbench teardown and before confirmed native quit.
- Changing Activity leaves Editor tabs, selection, unsaved state, and review
  state intact.
- Cmd/Ctrl+B toggles the Sidebar and Cmd/Ctrl+P opens workspace quick-open.
- Quick Open traps and restores focus, ignores stale async results, and
  contains workbench shortcuts; Escape or Cmd/Ctrl+W closes it first.
- Collapsing or restoring any pane transfers focus to visible chrome rather
  than leaving keyboard ownership in hidden content.

## Activities and agents

- Every terminal, agent, app instance, and routine run has a stable Activity.
- Native PTY launches preserve exact argv boundaries, cwd, and environment.
- Plain terminals are ephemeral. Agent and routine Activities persist bounded
  scrollback and final state across relaunch.
- Live output streams once, replay is ordered, resize reaches the PTY, and stop
  is idempotent.
- Durable ended Activities can be renamed, archived/restored, and cleared.
- Codex, Claude, and Pi detection reports precise unavailable states.
- Supported agents resume through their CLI-specific continuation command.
- Routine reruns resolve the current routine definition. Plain terminal and
  app-process reruns preserve their exact stored command, argv, cwd, and env.
- `mimx` is on PATH in every Mim-launched PTY.

## MCP

- The MCP endpoint binds to loopback and exposes `initialize`, `ping`,
  `tools/list`, and `tools/call`.
- One canonical registry backs MCP, Tauri callers, apps, and `mimx`.
- Tool calls validate object schemas and return structured, stable errors.
- Core tools cover files, editor, comments, shell, web search, Activities,
  Apps, Routines, and settings.
- Live app providers can add, update, remove, execute, and cancel tools without
  restarting the server.
- Mim-launched Codex, Claude, and Pi receive the endpoint automatically.

## Files

- Opening a workspace builds a native reviewable-file index sorted by most
  recently modified first with deterministic tie-breaking.
- Path filtering remains responsive and supports keyboard selection.
- Content search is cancellable and bounded by result, file, and byte limits.
- Enter opens the selected path in the existing Editor; a content hit opens
  its file.
- Recent is the default; Browse exposes directories and breadcrumbs without
  replacing the Editor.
- Visible controls and empty-surface actions create files and folders in the
  current directory.
- Right-click and Shift+F10 expose open/default-app, rename, duplicate, reveal,
  copy-path, and confirmed system-Trash actions.
- Cmd/Ctrl and Shift selection support safe bulk copy and Trash.
- Renames keep Editor paths coherent; dirty text survives user-initiated Trash.
- Native operations reject paths outside the indexed workspace.
- Refresh reflects additions, changes, and removals without changing workspace
  or polling full scans while Files is idle.

## Apps

- The Sidebar Apps section lists actual configured CLI agents and installed
  apps, not a generic Apps destination.
- The Apps-section gear opens Settings > Apps; the bottom Settings control
  remains visible in both Sidebar states and opens ordinary preferences.
- Settings > Apps is a searchable, keyboard-operable local instrument manager
  for built-ins and valid definitions from `~/.mim/apps`.
- It launches and reloads Apps, opens or reveals local definitions, creates a
  runnable starter app, duplicates local packages, updates display titles
  without changing stable ids, and moves exact definitions to Trash.
- App mutations update Sidebar launch rows immediately and expose the same safe
  operations through `apps_reload`, `apps_create`, `apps_duplicate`,
  `apps_update`, and `apps_trash`.
- Invalid TOML, duplicate IDs, missing entries, and invalid modes produce
  visible diagnostics without hiding valid apps.
- Embedded, terminal, process, window, Rust-helper, and action launch plans
  resolve explicitly.
- Terminal and process Apps create one real PTY Activity from Sidebar,
  Settings, or MCP; they never leave a duplicate launch-plan row.
- Embedded apps can use the host SDK for app data, files, HTTP, tools, and
  opening a file in the Editor.
- App-defined tools join the live registry and unregister with their instance.
- Reloading an already-mounted embedded App replaces its exact tool provider
  and reloads its frame without accumulating listeners.
- Changes and Scratch are functional built-in apps.

## Routines

- TOML definitions load from `~/.mim/routines` with per-file diagnostics.
- Five-, six-, and seven-field cron expressions and IANA timezones resolve
  deterministically.
- Scheduler state survives relaunch in `~/.mim/routines-state.json`.
- Enabled routines fire once per scheduled instant according to overlap and
  missed-fire policy.
- Every run resolves its current launcher preset and becomes a durable Activity.
- Run now uses the same runtime path and visible status as scheduled runs.
- A returned routine run opens as a terminal-backed Activity; the `Routines`
  singleton remains the manager surface.

## Editor and comments

- Markdown tabs, open/save/save-as, autosave, formatting, spellcheck, live
  in-editor rendering, and session restoration remain functional.
- Tabs expose the tablist contract, keyboard navigation, independent close
  controls, immediate overflow reveal, drag cancellation, and a stable New Tab
  landing page. Closing the final embedded tab yields the Editor pane instead
  of fabricating another document.
- Dirty named documents and untitled drafts survive a crash. Native
  close/Dock Quit confirms every dirty document, serializes the final session,
  and never resurrects an explicitly discarded draft.
- Cmd/Ctrl+K opens inline AI with or without a selection.
- Inline AI resolves `Auto` from the rewrite-model registry per request,
  explains missing provider configuration, and covers loading, tool, retry,
  cancel, follow-up, model-switch, accept, and reject states.
- AI edits open as full-document diffs and require explicit accept or reject.
  Proposal lifecycle failures remain visible and reviewable rather than
  silently dismissing the diff.
- Typing `++` requests ghost suggestions; keyboard acceptance, cycling,
  partial-word acceptance, cancellation, and error display work. Ordinary
  increment/C++ syntax and Enter keep their normal editor behavior.
- Comment storage remains pseudo-XML embedded in Markdown.
- Comment tags remain hidden/protected while anchor text stays editable and
  reviewable.
- Inline discussions support minimize/expand, reply editing/deletion,
  copy/paste or direct terminal agent prompt, resolve/reopen, delete, and
  remove-all.
- Resolve and reopen change stored status; delete preserves the anchored text.

## Release checks

- `npm test`, `npm run build`, Rust formatting, Rust tests, and Rust check pass.
- Product version is `0.1.0` in `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`; the package name is `mim-workbench`.
- Documentation references only current files and current local data paths.
