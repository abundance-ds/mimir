# Activities

An Activity is Mimir's execution record for terminals, CLI agents, process
Apps, and Routine runs. Files, Routines, Chats, and stable Apps are singleton
Tools and do not duplicate themselves in Activity history.

## Authority

- Native Rust owns PTY-backed records, processes, persistence, status, and
  lifecycle constraints.
- The renderer owns singleton navigation and embedded surfaces.
- Do not infer authority from Activity `kind`; inspect its host and origin.
- Commands retain exact argv, working directory, and environment boundaries.
- Plain terminals start ephemeral. Closing or archiving promotes them to
  durable History; agents and Routine runs are durable from launch.

## Plain terminal status

A live plain shell is `idle`. PTY output cannot prove that a foreground command
started or ended. Only process exit changes it to done, stopped, error, or
interrupted. Do not infer command state from output or silence.

## Workspace projection

The Sidebar shows the active working set for the current workspace. Workspace
switching hides other Project Activities but never stops or retargets them.
Home/custom-cwd Activities stay global. Scope is captured at launch and does
not change when a launcher preset changes.

Each workspace remembers its selected Activity and visible Editor tab for the
current app session. Restoring an Activity from another workspace opens that
workspace first. Activities do not add missing folders to the project switcher.

## PTY lifecycle and recovery

- PTY bytes remain binary. Output and resize share one ordered sequence.
- xterm is the terminal state engine. One mounted run owns one xterm model,
  which keeps consuming output while hidden.
- Keep macOS background throttling disabled; batch output without crossing
  resize events, and reveal only after catch-up.
- A versioned checkpoint plus a bounded event tail lives in
  `~/.mimir/activities/activities.sqlite3`.
- Checkpoint writes use run, revision, durable-sequence, and renderer-lease
  checks so a stale WebView cannot trim newer output.
- Never checkpoint a failed terminal model; clear its queued events before resume.
- Restored live processes become `interrupted`; Mimir never claims that an old
  PTY survived application exit.
- Install the Activity listener before the initial native list and terminal
  restore calls.
- Stop is idempotent. Archive and clear require an ended Activity.

Interrupted agent rows can resume their exact CLI session when their workspace
becomes active. Restore is limited to one attempt per app session, keeps startup
output quiet, and becomes an explicit error after 45 seconds without output.
Deliberately stopped Activities do not resume.

Native ownership is `src-tauri/src/activities/` and `activity_commands.rs`.
Renderer ownership is the Activity stores, Workbench lifecycle composables,
Sidebar, and Activity surfaces. Launcher and continuation details are in
[agent-setup.md](agent-setup.md).

Cmd+Up/Down scroll; Cmd+Left/Right send Ctrl-A/E; Cmd+Delete sends Ctrl-E,U; Shift+Enter sends Ctrl-J.
