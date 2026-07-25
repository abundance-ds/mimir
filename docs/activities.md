# Activities

Activity is Mim's universal execution and navigation record. Terminals, CLI
agents, Apps, Files, and Routines all occupy the same Activity pane and sidebar
history.

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

`ActivitySupervisor` owns PTYs and child processes. The renderer subscribes to
one ordered event stream for record upserts, output, status, and exit.

- PTY output is stored as raw byte chunks so split UTF-8 sequences survive.
- Replay uses monotonically increasing sequence numbers and can continue after
  the last renderer-seen chunk.
- Resize updates the native PTY.
- Stop is safe to repeat.
- Live agent status is inferred from output and silence without changing PTY
  ownership.

Plain terminals are ephemeral. Agent and routine runs are durable and persist
bounded scrollback under `~/.mim/activities/`. Durable records restore after
relaunch; any process that was live becomes interrupted because Mim does not
pretend that an old PTY is still attached.

## Sidebar operations

Live Activities can be selected, renamed, or stopped. Durable ended Activities
can be archived and restored. Clear permanently removes an ended record and its
persisted scrollback.

Core Files, Apps, and Routines records are renderer-hosted destinations and do
not use the native PTY lifecycle.

## Resume

Launcher detection associates Codex, Claude, and Pi with a continuation
strategy. Restarting an ended agent Activity resolves its current preset,
preserves exact argv, and adds the CLI-specific continuation flag. The new run
is a new Activity; the previous durable record remains reviewable until
archived or cleared.

## Relevant code

- `src-tauri/src/activities/`
- `src-tauri/src/activity_commands.rs`
- `src-tauri/src/launchers.rs`
- `src/stores/activities.js`
- `src/stores/activityRuntime.js`
- `src/mim/activities/TerminalActivity.vue`
- `src/mim/components/WorkbenchSidebar.vue`
