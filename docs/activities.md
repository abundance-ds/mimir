# Activities

Activity is Mimir's universal execution and navigation record. Terminals, CLI
agents, process Apps, and routine runs occupy the Activity pane and sidebar
history. Files, Routines, and stable Apps are singleton Tools: they use the same
pane without duplicating themselves in Activities.

## Record

The shared Rust/renderer record in `src-tauri/src/activities/model.rs` contains:

- stable `id`, `kind`, title, workspace, timestamps, and status
- an automatic-title eligibility bit consumed by the first generated or
  explicit rename
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

New launcher-backed agent Activities begin with the launcher title and expose
the scoped `mimir_title` tool to Codex, Claude, Pi, and Gemini. The connected
agent calls it once on the first substantive user turn with a concise task
title. Native compare-and-set semantics accept it only while the launcher title
is still eligible; an explicit launch title or manual rename wins atomically.
The accepted rename is persisted and projected through the ordinary Activity
upsert path.

## Workspace projection

The Sidebar projects the active working set for the open workspace. Activities
launched with a workspace-cwd preset appear only for that workspace; home and
custom-cwd launchers and direct process Apps remain global. This is presentation
only: switching workspaces never stops, pauses, retargets, or removes a native
Activity. Hidden terminal surfaces stay mounted and recover incremental native
scrollback when selected again.

Scope is captured in the Activity origin at launch; it does not change later
when a launcher preset is edited. `workspacePath` names the owning project,
while `launch.cwd` remains the process working directory.

For the current app session, each workspace remembers its active Activity, its
selected chat when Chats is active, and its active open Editor tab. Returning
to a workspace restores the available parts of that view and opens Files when
the Activity is no longer available. Each switch resets Activity Back/Forward
navigation, so it cannot cross projects implicitly. This memory is not
persisted. Closed History browses the open project only; a search term reaches
all projects, open-project matches first. Explicitly restoring an Activity
from another workspace opens that workspace first. The
project switcher reports retained Activity counts and `needs-input` work for
recent workspaces.

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
- `src/mimir/activityWorkspace.js`
- `src/mimir/composables/useActivityLifecycle.js`
- `src/mimir/composables/useWorkbenchKeyboardRouting.js`
- `src/mimir/activities/TerminalActivity.vue`
- `src/mimir/components/WorkbenchSidebar.vue`

Primary tests are colocated native tests in `activities/model.rs`,
`scrollback.rs`, `status.rs`, and `supervisor.rs`, plus
`src/stores/activityRuntime.test.js`, `activities.test.js`, and Activity
surface/sidebar tests.
