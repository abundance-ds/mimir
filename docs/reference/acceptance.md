# Product acceptance contract

This is the release behavior contract for Mim 0.1.0. Unit tests support these
requirements; they do not replace runtime verification.

## Workbench

- The main window is one edge-to-edge Sidebar / Activity / Editor workbench.
- Editor is mounted and visibly expanded on startup.
- The Sidebar starts expanded and can collapse to a 52px live rail without
  reordering rows or losing status.
- New activity and Activities disclose independently in the expanded Sidebar;
  the live rail continues to expose both lists regardless of disclosure state.
- Tools contains stable singleton surfaces, New activity contains sources that
  create a fresh run, and Activities contains the active working set.
- The project switcher shows the current folder, recent folders, and an
  explicit native folder-picker action in both Sidebar states.
- The Sidebar has no Archived list. Closed durable work is searchable and
  restorable through Cmd/Ctrl+P History.
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
- Cmd/Ctrl+B toggles the Sidebar and Cmd/Ctrl+P opens the compact Go to panel.
- Empty Go to shows Tools, one expandable New activity row, recent files, and
  Reopen last closed. `/` scopes files, `@` scopes closed History, and `+`
  scopes fresh-run sources; live Activities stay on the cycle shortcut.
- Go to traps and restores focus, ignores stale async results, and contains
  workbench shortcuts; Escape or Cmd/Ctrl+W closes it first. Its fixed top
  edge does not move when New activity expands downward.
- Unmodified Arrow Up/Down and Home/End move Sidebar row focus without
  activation. Option/Alt+Cmd/Ctrl+Left/Right cycles active Activity rows.
- Collapsing or restoring any pane transfers focus to visible chrome rather
  than leaving keyboard ownership in hidden content.

## Activities and agents

- Every terminal, agent, app instance, and routine run has a stable Activity.
- The Activities `+` menu launches every enabled dynamic Activity type,
  including Terminal, without offering a built-in Chat; it remains available
  in the collapsed Sidebar and is fully keyboard-operable.
- Native PTY launches preserve exact argv boundaries, cwd, and environment.
- Plain terminals are ephemeral. Agent and routine Activities persist bounded
  scrollback and final state across relaunch.
- Live output streams once, replay is ordered, resize reaches the PTY, and stop
  is idempotent.
- Durable ended Activities can be renamed, archived/restored, and cleared.
- Cmd/Ctrl+W on a focused Sidebar Activity archives that exact durable row,
  including failed rows that are not currently selected; live rows stop before
  archival.
- Codex, Claude, and Pi detection reports precise unavailable states.
- Settings > CLI tools uses compact detected-agent rows, launcher-visibility
  switches, shell-like flag editing, progressive cwd/command/environment
  details, and no kind/agent/cwd select maze.
- Disabled or unavailable CLI presets do not clutter the Sidebar; they remain
  diagnosable and configurable in Settings.
- Supported agents resume through their CLI-specific continuation command
  inside the same Activity row; resume never creates a second record.
- Routine reruns resolve the current routine definition. Plain terminal and
  app-process reruns preserve their exact stored command, argv, cwd, and env.
- `mimx` is on PATH in every Mim-launched PTY.

## MCP

- The MCP endpoint binds to loopback and exposes `initialize`, `ping`,
  `tools/list`, and `tools/call`.
- One canonical registry backs MCP, Tauri callers, apps, and `mimx`.
- Default agent discovery contains only `mim_state`, `mim_reveal`, and
  `mim_propose`; optional domains require explicit CLI discovery.
- Tool calls validate object schemas and return structured, stable errors.
- Core tools cover files, editor, comments, shell, web search, Activities,
  Apps, Routines, settings, and the native Business graph domains.
- Live app providers can add, update, remove, execute, and cancel tools without
  restarting the server.
- Mim-launched Codex, Claude, and Pi receive the endpoint automatically.
- Codex uses the app-specific `mcp_servers.mim_workbench` HTTP entry so an
  existing stdio server named `mim` cannot make one-run configuration invalid.

## Files

- Opening a workspace builds a native reviewable-file index sorted by most
  recently modified first with deterministic tie-breaking.
- Path filtering remains responsive and supports keyboard selection.
- Content search is cancellable and bounded by result, file, and byte limits.
- Project is the default and exposes a lazy expandable directory tree; Recent
  follows Editor-open history, and Favorites persists relative paths per
  workspace.
- A Project query uses the complete native file index rather than only loaded
  tree branches.
- Single-click opens or reuses a clean preview tab; Enter/double-click pins the
  tab. Text mounts CodeMirror, PDFs render in the Editor, and unsupported
  resources expose metadata plus default-app/reveal actions.
- Visible controls and empty-surface actions create files and folders inline
  under the selected directory.
- Right-click and Shift+F10 expose open/default-app, rename, duplicate, reveal,
  favorite, copy-path, and confirmed system-Trash actions.
- Cmd/Ctrl and Shift selection support safe bulk copy and Trash.
- Renames keep Editor and descendant favorite paths coherent; dirty text
  survives user-initiated Trash.
- Native operations reject paths outside the indexed workspace.
- Refresh rebuilds index metadata and reloads already visited tree directories
  without changing workspace or polling while Files is idle.

## Apps

- Stable Apps appear under Tools; terminal/process Apps and configured CLI
  presets appear under New activity. There is no generic Apps destination.
- Tools and New activity each support persistent manual ordering by pointer or
  Shift+Alt+Up/Down.
- The bottom Settings control remains visible in both Sidebar states; Settings
  > Apps is the catalog and management surface.
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
- Stable Apps reopen one singleton Tool Activity and do not duplicate
  themselves in Activities. Terminal and process Apps create one real PTY
  Activity from Sidebar, Settings, or MCP.
- Embedded apps can use the host SDK for app data, files, HTTP, tools, and
  opening a file in the Editor.
- App-defined tools join the live registry and unregister with their instance.
- Reloading an already-mounted embedded App replaces its exact tool provider
  and reloads its frame without accumulating listeners.
- Today is a durable single-priority editor that restores former Scratch text,
  highlights Markdown source without a preview layer, autosaves, and exposes
  the live value through `scratch_read`.
- Today and Business graph are functional built-in Tools.
- Git state remains available through Files decorations and summaries; there
  is no separate Changes built-in.

## Business graph

- Knowledge and Issue Markdown remain canonical and dual-read through one
  Rust-owned GraphStore without mandatory source rewrites.
- Private, current-project, and optional team roots compose into projections
  without losing scope, source path, source revision, or legacy metadata.
- A query limited to project or team scopes never returns private nodes,
  backlinks, counts, or context.
- The bounded ontology accepts business and HEOR kinds, normalizes legacy
  `org` to `company`, and diagnoses malformed sources, duplicate ids, dangling
  relations, and unresolved identities.
- Issue Board behavior includes status/project grouping, drag-and-drop and
  keyboard-equivalent movement, visible columns, filters, sorting, due and
  attention states, revision-aware updates, and Trash/undo.
- Kanban cards keep fixed geometry and persistent priority/status/due controls.
  No Business Graph surface uses colored left edges, content-revealing hover,
  hover transforms, scaling, filters, or shadows.
- Projects, People, Companies, Knowledge, and All expose useful Portfolio,
  CRM, directory, timeline, list, and relationship graph projections over the
  same nodes. Portfolio is an operational table rather than presentation
  tiles.
- Project and assignee controls resolve visible graph entities. Focus also
  authors the bounded business relation vocabulary without exposing a generic
  schema editor.
- Every dropdown and date/datetime control uses a styled Vue
  listbox/combobox or calendar with keyboard navigation and visible focus,
  never the platform's native `select`, `datalist`, date, or datetime UI.
- The app follows Scan → Peek → Focus: projections remain scannable, Peek is
  read-first with quick issue properties and a relationship sentence, and
  Focus uses one spacious scroll with syntax-aware Markdown and auto-growing
  text fields.
- The inspector preserves a context trail, commits drafts before every
  replacing navigation or scope refresh, opens sources and deliverables in the
  Editor, shows related Activities, and reports revision conflicts rather than
  overwriting them.
- `graph.context` bounds bodies and node count, preserves provenance and
  selected scopes, filters hidden relations, and redacts `record` or
  `sensitive: true` content by default.
- Start Work first presents an editable objective and explains the selected
  scopes and bounded context. Explicit confirmation creates a durable agent
  Activity with explicitly untrusted graph context and associates that
  Activity with the focus node.
- Semantic commands can move/assign/complete work, link project companies and
  contacts, record decisions, attach deliverables, create next actions, and
  capture HEOR evidence.
- `graph.migration_report` never writes; explicit project/assignee resolution
  is kind-checked; compatibility facades and golden round trips preserve
  legacy capability and unknown metadata.
- The 5,000-node index and 600-source startup, query, search, traversal,
  mutation, and refresh performance contracts stay within the debug budgets
  documented in [business-graph.md](business-graph.md).

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
- The Markdown formatting toolbar is mounted in the Editor, preserves
  CodeMirror selection/focus, responds to narrow widths, and can be hidden in
  Settings > Editor.
- Optional line numbers use a transparent paper gutter with aligned tabular
  digits and reconfigure live without recreating the document. The current-line
  tint sits on the number cell when visible and moves to the editor row when
  line numbers are hidden.
- Tabs expose the tablist contract, keyboard navigation, independent close
  controls, immediate overflow reveal, drag cancellation, and a stable New Tab
  landing page. Closing the final embedded tab yields the Editor pane instead
  of fabricating another document.
- Dirty named documents and untitled drafts survive a crash. Native
  close/Dock Quit confirms every dirty document, serializes the final session,
  and never resurrects an explicitly discarded draft.
- Clean open workspace text documents refresh automatically after an external
  disk write, including edits from a CLI agent. Only matching open paths are
  read; an unsaved dirty buffer remains authoritative.
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

- `npm test`, `npm run build`, `npm run docs:check`, Rust formatting, Rust
  tests, and Rust check pass.
- Product version is `0.1.0` in `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`; the package name is `mim-workbench`.
- Documentation references only current files and current local data paths.
