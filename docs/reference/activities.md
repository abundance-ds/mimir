# Activities

Activity is Mim's universal execution and navigation record. Terminals, CLI
agents, process Apps, and routine runs occupy the Activity pane and sidebar
history. Files, Routines, and stable Apps are singleton Tools: they use the same
pane without duplicating themselves in Activities.

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

## Authority split

`files` and `routines` are renderer-installed singleton navigation records.
Embedded, Rust-helper, window, and action Apps are stable Tool records and are
renderer-hosted until their plan delegates to a process. PTY-backed terminal,
agent, Routine run, and terminal/process App records are native-authoritative.

This distinction controls mutations:

- `src/stores/activityRuntime.js` handles rename/archive/clear locally for a
  non-PTY host;
- PTY mutations invoke `activity_commands.rs`, which enforces live/retention
  constraints and persistence;
- core singleton records are never restored from native Activity persistence;
- stable Tool records are omitted from active and archived Activities lists;
- a Routine run has `kind=routine` and `host.type=pty`; the manager singleton
  also has `kind=routine` but is renderer-only.

Do not infer authority from `kind`; inspect `host.type` and the record origin.

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
bounded scrollback under `~/.mim/activities/`. Retained scrollback defaults to
1 MB for terminals and 2 MB for durable agent/routine runs
(`DEFAULT_TERMINAL_SCROLLBACK_BYTES` / `DEFAULT_DURABLE_SCROLLBACK_BYTES` in
`supervisor.rs`); `ActivitySpawnRequest.scrollback_byte_cap` overrides the cap
per spawn. Durable records restore after relaunch; any process that was live
becomes interrupted because Mim does not pretend that an old PTY is still
attached.

The renderer installs `mim://activity-event` before calling `activity_list`.
Events project upsert/status/exit, while the initial list closes the startup
gap. Native persistence uses a single batching worker that keeps the latest
save/delete per Activity path; `activity_flush` and shutdown wait for its
acknowledgement. See [persistence.md](persistence.md) and [ipc.md](ipc.md).

## Terminal surface

`src/mim/activities/TerminalActivity.vue` hosts xterm.js for terminal and
agent Activities. Its non-defaults are deliberate:

- The WebGL renderer is loaded after `terminal.open()` for GPU-composited
  output; `customGlyphs` draws box-drawing and powerline characters
  pixel-perfect. A missing WebGL2 context or a later context loss disposes the
  addon and keeps xterm's DOM renderer.
- The Unicode 11 addon supplies correct emoji/wide-character cell widths and
  requires `allowProposedApi: true`; without the flag the addon throws at load
  and the surface shows an attach error instead of a terminal.
- Shift+Enter sends LF (`\n`, Ctrl+J) instead of CR. Claude and Codex document
  Ctrl+J as insert-newline; shells bind LF to accept-line, identical to Enter,
  so plain terminals lose nothing.
- Each fit pass clears and re-applies a sub-pixel `translate()` on the surface
  so the canvas origin lands on a whole device pixel. Pane splits produce
  fractional positions, and a bitmap canvas composited at a fractional offset
  is resampled into uniform blur. DOM-rendered text never shows this, so the
  regression is invisible until the WebGL renderer is active.

Spawn size comes from `src/services/activities.js`, which remembers the last
pane-fitted cols/rows and applies them to `spawnActivity`/`respawnActivity`
(fallback 64×20 before any fit). The first prompt is printed before the
surface mounts and reports its real size, and zsh pads its partial-line mark
to the PTY width: spawning wider than the eventual pane strands that padding
as a wrapped `%` line at the top of scrollback, while spawning narrower is
corrected invisibly by the first fit resize. Undershoot is safe; overshoot is
visible.

## Sidebar operations

- New activity and the Activities header `+` expose every enabled, available
  source that creates a dynamic row: CLI agent presets, Terminal, and
  terminal/process Apps. Stable Tools and Chat are intentionally absent. The
  same compact control replaces the section marker in the collapsed rail.
- The creation menu uses source icons, separates CLI and App targets with one
  quiet rule, flips inside the viewport, and supports Arrow Up/Down, Home, End,
  Escape, Tab, and focus restoration.
- Every visible dynamic row can be renamed from double-click, F2, right-click,
  or its always-discoverable actions button.
- Source metadata selects recognizable Codex/OpenAI, Claude/Anthropic, Pi,
  Terminal, App, and Routine marks in expanded and rail layouts.
- A process-backed live Activity can be stopped. A renderer-hosted app is not
  presented as a process merely because its stable status is `ready`.
- Durable non-running Activities can be archived. Cmd/Ctrl+P History searches
  closed task/workspace metadata and lazily searches ANSI-stripped bounded
  scrollback; selecting a result restores and opens that Activity. Delete
  permanently removes a restored non-running record and its persisted
  scrollback.
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

Cmd/Ctrl+W on a stable Tool rails the Activity pane rather than archiving or
deleting the singleton.

## Resume

Launcher detection associates Codex, Claude, and Pi with a continuation
strategy. Resuming an ended agent Activity resolves its current preset,
preserves exact argv, and adds the CLI-specific continuation flag, then
respawns the new session inside the same Activity record: id, creation time,
and manual sidebar position survive while the session, launch spec, and
scrollback restart. The supervisor's `activity_respawn` only replaces ended
PTY records — live sessions and unknown ids are rejected — and the terminal
surface watches the session `runId` to reset its replay watermark to the new
session's first byte. Agents without a continuation strategy start over as a
fresh Activity.

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

Inactive optional surfaces are split at the Activity boundary: terminal/agent
and App hosts load on first use, then `ActivityHost` retains them for instant
subsequent switching. Native durable output remains byte-bounded and persists
the first output, status transitions, and final exit immediately; noisy output
snapshots are capped at four per second so a PTY read cannot repeatedly clone
the complete retained scrollback.

## Relevant code

- `src-tauri/src/activities/`
- `src-tauri/src/activity_commands.rs`
- `src-tauri/src/launchers.rs`
- `src/stores/activities.js`
- `src/stores/activityRuntime.js`
- `src/mim/composables/useActivityLifecycle.js`
- `src/mim/composables/useWorkbenchKeyboardRouting.js`
- `src/mim/activities/TerminalActivity.vue`
- `src/mim/components/WorkbenchSidebar.vue`

Primary tests are colocated native tests in `activities/model.rs`,
`scrollback.rs`, `status.rs`, and `supervisor.rs`, plus
`src/stores/activityRuntime.test.js`, `activities.test.js`, and Activity
surface/sidebar tests.
