# Activities

Activity is Mimir's universal execution and navigation record. Terminals, CLI
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
bounded scrollback under `~/.mimir/activities/`. Retained scrollback defaults to
1 MB for terminals and 2 MB for durable agent/routine runs
(`DEFAULT_TERMINAL_SCROLLBACK_BYTES` / `DEFAULT_DURABLE_SCROLLBACK_BYTES` in
`supervisor.rs`); `ActivitySpawnRequest.scrollback_byte_cap` overrides the cap
per spawn. Durable records restore after relaunch; any process that was live
becomes interrupted because Mimir does not pretend that an old PTY is still
attached.

The renderer installs `mimir://activity-event` before calling `activity_list`.
Events project upsert/status/exit, while the initial list closes the startup
gap. Native persistence uses a single batching worker that keeps the latest
save/delete per Activity path; `activity_flush` and shutdown wait for its
acknowledgement. See [persistence.md](persistence.md) and [ipc.md](ipc.md).

## Terminal surface

`src/mimir/activities/TerminalActivity.vue` hosts xterm.js for terminal and
agent Activities. Non-obvious constraints are in
[gotchas.md](gotchas.md#terminal).

## Resume

Launcher detection, session identity, continuation adapters, and the respawn
contract are owned by [agent-setup.md](agent-setup.md). The supervisor's
`activity_respawn` replaces only ended PTY records; the terminal surface watches
`runId` to reset replay to the new session's first byte.

## Relevant code

- `src-tauri/src/activities/`
- `src-tauri/src/activity_commands.rs`
- `src-tauri/src/launchers.rs`
- `src/stores/activities.js`
- `src/stores/activityRuntime.js`
- `src/mimir/composables/useActivityLifecycle.js`
- `src/mimir/composables/useWorkbenchKeyboardRouting.js`
- `src/mimir/activities/TerminalActivity.vue`
- `src/mimir/components/WorkbenchSidebar.vue`

Primary tests are colocated native tests in `activities/model.rs`,
`scrollback.rs`, `status.rs`, and `supervisor.rs`, plus
`src/stores/activityRuntime.test.js`, `activities.test.js`, and Activity
surface/sidebar tests.
