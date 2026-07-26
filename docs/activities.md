# Activities

Activity is Mim's universal execution and navigation record. Terminals, CLI
agents, app instances, and routine runs occupy the Activity pane and sidebar
history. Files and Routines remain stable launch surfaces; Apps owns a
collapsible launcher section rather than a synthetic core Activity row.

## Record

The shared Rust/renderer record in `src-tauri/src/activities/model.rs` contains:

- stable `id`, `kind`, title, workspace, timestamps, and status
- `retention` (`ephemeral` or `durable`)
- origin metadata for a launcher, app, routine, schedule, or parent Activity
- a host description such as PTY, embedded app, process, window, or Rust helper
- an exact launch specification with command, argv, cwd, and environment
- optional run/session and exit metadata

Statuses are `ready`, `starting`, `working`, `needs-input`, `idle`, `done`,
`error`, `stopped`, and `interrupted`.

## Lifecycle

`ActivitySupervisor` owns PTYs and child processes. The runtime store keeps one
ordered record subscription for upserts, status, and exit.

- PTY output is stored as raw byte chunks so split UTF-8 sequences survive.
- Replay uses monotonically increasing sequence numbers and can continue after
  the last renderer-seen chunk.
- Resize updates the native PTY.
- Stop is safe to repeat.
- Live agent status is inferred from output and silence without changing PTY
  ownership.
- Activity surfaces mount on first visit, not once per saved record.
- Only the active terminal surface owns an output subscription, resize
  observer, and theme observer. A hidden surface releases them and requests
  sequence-incremental native scrollback when selected again. A generation
  token prevents rapid active/inactive switching from stranding a surface
  without a listener.

Plain terminals are ephemeral. Agent and routine runs are durable and persist
bounded scrollback under `~/.mim/activities/`. Durable records restore after
relaunch; any process that was live becomes interrupted because Mim does not
pretend that an old PTY is still attached.

## Sidebar operations

- The Activities header `+` opens every enabled, available launcher that can
  create a dynamic row: CLI agent presets, Terminal, and installed Apps. Fixed
  Files/Routines surfaces and Chat are intentionally absent. The same compact
  control replaces the section marker in the collapsed rail.
- The creation menu uses source icons, separates CLI and App targets with one
  quiet rule, flips inside the viewport, and supports Arrow Up/Down, Home, End,
  Escape, Tab, and focus restoration.
- Every dynamic and archived row can be renamed from double-click, F2,
  right-click, or its always-discoverable actions button.
- Source metadata selects recognizable Codex/OpenAI, Claude/Anthropic, Pi,
  Terminal, App, and Routine marks in expanded and rail layouts.
- A process-backed live Activity can be stopped. A renderer-hosted app is not
  presented as a process merely because its stable status is `ready`.
- Durable non-running Activities can be archived and restored. Delete
  permanently removes a non-running record and its persisted scrollback.
- Manual pointer drag, Shift+Alt+Up/Down, and Move Up/Down actions update a
  stable-id order without rewriting record identity or status. New Activities
  appear above an established manual order.
- Manual, most-recent, needs-attention, and name sorts are available and the
  chosen mode/order persist in editor settings.

Option/Alt+Cmd/Ctrl+Left/Right switches the adjacent vertical Activity row when
the Activity pane or Sidebar owns focus. Sidebar focus moves with the selected
row. The same chord stays horizontal inside Editor tabs. Cmd/Ctrl+W on a
Sidebar Activity row targets that exact row, even when another Activity is
selected or the focused run ended in error. Durable rows archive (after a live
process stops); ephemeral terminal rows are cleared. The Activity pane rails
when its last closable row is gone. Editor focus closes its tab instead;
closing the last embedded tab rails Editor and never closes Mim. The macOS
native menu accelerator delegates through the same focus-aware path. Open
Settings, confirmation dialogs, and Quick Open consume close first. Collapsing
and restoring panes also hands focus to visible rail/header controls, so later
shortcuts never target aria-hidden content.

## Resume

Launcher detection associates Codex, Claude, and Pi with a continuation
strategy. Restarting an ended agent Activity resolves its current preset,
preserves exact argv, and adds the CLI-specific continuation flag. The new run
is a new Activity; the previous durable record remains reviewable until
archived or cleared.

Ended routine runs restart through the current routine definition. Ended plain
terminal, process-App, and terminal-App Activities rerun their exact stored
command, argv, cwd, environment, retention, kind, and source into a fresh
Activity; host-required Activity/MCP environment keys are regenerated once.

Terminal resolution performs no agent detection. Launcher Settings explicitly
refreshes the installed-agent catalog; repeated agent launches reuse that
refreshable cache, preserving exact command/argv/MCP flags without the former
login-shell and `--version` work on every click. Each launch records separate
resolve, supervisor-spawn, and total timing in
`activityRuntime.lastLaunchMetrics` and the `mim.activity.launch` performance
measure.

## Relevant code

- `src-tauri/src/activities/`
- `src-tauri/src/activity_commands.rs`
- `src-tauri/src/launchers.rs`
- `src/stores/activities.js`
- `src/stores/activityRuntime.js`
- `src/mim/activities/TerminalActivity.vue`
- `src/mim/components/WorkbenchSidebar.vue`
