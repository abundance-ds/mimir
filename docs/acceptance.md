# Product acceptance contract

This is the release behavior contract for Mim 0.1.0. Unit tests support these
requirements; they do not replace runtime verification.

## Workbench

- The main window is one edge-to-edge Sidebar / Activity / Editor workbench.
- The Sidebar starts expanded and can collapse to a 52px live rail without
  reordering rows or losing status.
- Activity and Editor can each collapse to a mounted 44px rail.
- Activity and Editor cannot both remain railed; recovery always leaves a
  usable content surface.
- Both dividers resize smoothly and persisted widths restore on relaunch.
- Changing Activity leaves Editor tabs, selection, unsaved state, and review
  state intact.
- Cmd/Ctrl+B toggles the Sidebar and Cmd/Ctrl+P opens workspace quick-open.

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
- Refresh reflects additions, changes, and removals without changing workspace.

## Apps

- Apps lists built-ins and valid local definitions from `~/.mim/apps`.
- Invalid TOML, duplicate IDs, missing entries, and invalid modes produce
  visible diagnostics without hiding valid apps.
- Embedded, terminal, process, window, Rust-helper, and action launch plans
  resolve explicitly.
- Embedded apps can use the host SDK for app data, files, HTTP, tools, and
  opening a file in the Editor.
- App-defined tools join the live registry and unregister with their instance.
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

## Editor and comments

- Markdown tabs, open/save/save-as, autosave, formatting, spellcheck, live
  in-editor rendering, and session restoration remain functional.
- Cmd/Ctrl+K opens inline AI with or without a selection.
- AI edits open as full-document diffs and require explicit accept or reject.
- Typing `++` requests ghost suggestions; keyboard acceptance, cycling,
  partial-word acceptance, cancellation, and error display work.
- Comment storage remains pseudo-XML embedded in Markdown.
- Comment tags remain hidden/protected while anchor text stays editable and
  reviewable.
- Inline discussions support minimize/expand, reply, copy/paste agent prompt,
  resolve/reopen, delete, and remove-all.
- Resolve and reopen change stored status; delete preserves the anchored text.

## Release checks

- `npm test`, `npm run build`, Rust formatting, Rust tests, and Rust check pass.
- Product version is `0.1.0` in `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`; the package name is `mim-workbench`.
- Documentation references only current files and current local data paths.
