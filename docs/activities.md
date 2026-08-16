# Activities

Activity is Mimir's universal execution and navigation record. Terminals, CLI
agents, process Apps, and routine runs occupy the Activity pane and sidebar
history. Files, Routines, and stable Apps are singleton Tools: they use the same
pane without duplicating themselves in Activities.

## Record

The shared Rust/renderer record in `src-tauri/src/activities/model.rs` contains:

- stable `id`, `kind`, title, workspace, timestamps, and status
- title provenance: `launcher`, `provisional`, or `manual`; old `agent` values
  remain readable
- `retention` (`ephemeral` or `durable`)
- origin metadata for a launcher, app, routine, schedule, or parent Activity
- a host description such as PTY, embedded app, process, window, or Rust helper
- an exact launch specification with command, argv, cwd, and environment
- optional run/session and exit metadata

Statuses are `ready`, `starting`, `working`, `needs-input`, `idle`, `done`,
`error`, `stopped`, and `interrupted`.

### Plain terminal status

A plain terminal uses `idle` for its complete live shell session. Process
existence alone does not mean that the terminal is doing work, and PTY output
does not supply reliable command boundaries. The shell changes to `done`,
`stopped`, `error`, or `interrupted` only when the session ends. Agent status is
tracked from supported CLI signals. Routine and process App Activities use
`working` while their process is live.

Command-aware terminal status is a possible future extension. It needs an
explicit shell integration contract that marks a foreground command start and
the next prompt. Output volume or silence must not control that state because a
quiet command can still be active.

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

New launcher-backed agent Activities begin with the launcher title. The shared
terminal input path reconstructs the first submitted prompt for Codex, Claude,
Pi, and Gemini without changing the bytes sent to the PTY. It discards paths,
logs, code blocks, URLs, credentials, and token-like values, then proposes a
bounded task title. This local fallback does not depend on a provider hook,
provider transcript format, or MCP call.

Native title provenance supplies the compare-and-set order: `launcher` ->
`provisional`. An explicit launch title or manual rename sets `manual` and
stays authoritative across resumed runs. Accepted changes use the ordinary
persisted Activity upsert path. The old `agent` source remains readable only
for stored records created before the agent title tool was removed. Legacy
eligibility records migrate conservatively so an old locked title remains
manual.

## Workspace projection

The Sidebar projects the active working set for the open workspace. Activities
launched with a workspace-cwd preset appear only for that workspace; home and
custom-cwd launchers and direct process Apps remain global. This is presentation
only: switching workspaces never stops, pauses, retargets, or removes a native
Activity. A visited terminal surface stays mounted and keeps its one xterm
model current while hidden.

Scope is captured in the Activity origin at launch; it does not change later
when a launcher preset is edited. `workspacePath` names the owning project,
while `launch.cwd` remains the process working directory.

For the current app session, each workspace remembers its active Activity, its
selected chat when Chats is active, and its active visible Editor tab. Returning
to a workspace restores the available parts of that view and opens Files when
the Activity is no longer available. Each switch resets Activity Back/Forward
navigation, so it cannot cross projects implicitly. This view memory is not
persisted. Editor tab projection is owned by
[editor-system.md](editor-system.md). Closed History browses the open project
only; a search term reaches all projects, open-project matches first.
Explicitly restoring an Activity from another workspace opens that workspace
first. Project-switcher presentation and search behavior are owned by
[workbench-design.md](workbench-design.md#rail-contract).

## Lifecycle

`ActivitySupervisor` owns PTYs and child processes. The runtime store keeps one
ordered record subscription for upserts, status, and exit.

- PTY output stays as raw bytes so split UTF-8 sequences survive transport.
- Output and resize operations share one monotonically increasing event
  sequence. Replay therefore restores the geometry in which output occurred.
- The native journal is the recovery transport. xterm.js is the terminal state
  engine; Mimir does not implement a second VT parser.
- Stop is safe to repeat.
- Live agent status is inferred from output and silence without changing PTY
  ownership.
- Activity surfaces mount on first visit, not once per saved record. Each
  mounted PTY run owns exactly one xterm model. It continues to apply output
  while hidden; only its layout and theme observers stop.
- xterm write completion advances the applied event watermark. It never
  advances when output is only queued.
- After a quiet period, xterm's serializer produces a versioned terminal
  checkpoint. Native compare-and-set revision checks, run checks, durable
  sequence checks, and a single-owner lease prevent stale WebViews from
  overwriting or trimming newer state.

Plain terminals start ephemeral. Archive or Close (Cmd/Ctrl+W) promotes a
terminal to durable retention and preserves it in History. Agent and routine
runs are durable from launch. `~/.mimir/activities/activities.sqlite3` stores
compact Activity metadata, binary terminal events, and terminal checkpoints.
The uncheckpointed event tail defaults to 1 MB for terminals and 2 MB for
durable agent/routine runs
(`DEFAULT_TERMINAL_SCROLLBACK_BYTES` / `DEFAULT_DURABLE_SCROLLBACK_BYTES` in
`supervisor.rs`); `ActivitySpawnRequest.scrollback_byte_cap` overrides the cap
per spawn. Durable records restore after relaunch; any process that was live
becomes interrupted because Mimir does not pretend that an old PTY is still
attached.

The renderer installs `mimir://activity-event` before calling `activity_list`.
Events project upsert/status/output/resize/exit, while the initial list closes
the startup gap. A terminal surface also listens before it atomically acquires
its checkpoint lease and durable restore state. It opens xterm before replay,
and serializes run attachments so an initial attach cannot race a resumed
`runId` update. `activity_flush` and shutdown
wait for the SQLite worker. See [persistence.md](persistence.md) and
[ipc.md](ipc.md).

## Sidebar presentation

The Sidebar presents observable conversation state, not every supervisor
status. It deliberately does not distinguish `done` from `idle`:

- `starting` or `working`: animated 3×3 working grid;
- a blocking `needs-input` request on an inactive Activity: orange `attn` dot
  and relative time; transient prompt-ready states and the selected Activity
  show relative time only;
- output received while another Activity is selected: pale blue `info` dot
  and relative time, cleared when selected;
- any exposed process, surface/API, provider/authentication, or resume error:
  red `rem` dot and relative time;
- all other states: relative time only.

Activity icons remain clean. The right meta position is the only status
instrument. Compact time uses `now` for the first minute, then whole minutes,
hours, days, weeks, months, or years, refreshed by one minute ticker.

## Terminal surface

`src/mimir/activities/TerminalActivity.vue` hosts xterm.js for terminal and
agent Activities. The xterm core, serializer, Unicode, Fit, Web Links, and WebGL
packages use exact compatible versions because a checkpoint records its format,
engine, and Unicode versions. History search uses normalized xterm buffer text
from the last checkpoint plus the uncheckpointed event tail; overwritten raw
TUI redraws are not the durable search model. Non-obvious constraints are in
[gotchas.md](gotchas.md#terminal).

## Resume

Launcher detection, session identity, continuation adapters, and the respawn
contract are owned by [agent-setup.md](agent-setup.md). The supervisor's
`activity_respawn` replaces only ended PTY records; the terminal surface watches
`runId` to reset replay to the new session's first byte.

Mimir resumes unarchived interrupted agent rows whenever a project becomes
active, including app startup. It scans that project only and excludes History,
global Activities, other projects, process Apps, terminals, and routines. Two
exact-session restores run at once across the app, with no total limit. Each row
gets one attempt per app session.

Session restoration is not conversation activity. It does not show the working
indicator, create unread state, or change the row's last conversation time. The
restore stays pending until the new run produces terminal output; selecting it
meanwhile shows `Restoring session…` and blocks terminal input. Restoration
output stays silent until the user's next submitted turn. Native persistence
holds `updatedAt` across app interruption, respawn, startup output, and status
signals, then releases it only after that submitted turn reaches the PTY. A run
that produces no terminal output within 45 seconds becomes an explicit error
instead of loading forever. A missing continuation requirement or spawn failure
leaves the row interrupted; every failure records its exact cause. Deliberately
stopped Activities never enter this flow.

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
`scrollback.rs`, `store.rs`, `status.rs`, and `supervisor.rs`, plus
`src/stores/activityRuntime.test.js`, `activities.test.js`, and Activity
surface/sidebar tests.
