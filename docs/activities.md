# Activities

An Activity is the execution record for terminals, CLI agents, process Apps,
and Routine runs. Files, Routines, Chats, and stable Apps are singleton Tools
that do not appear in Activity history.

## Authority

- Native Rust owns PTY-backed records, processes, persistence, status, and
  lifecycle constraints. The renderer owns singleton navigation and surfaces.
- Inspect host and origin, not `kind`, to determine authority.
- Commands retain exact argv, working directory, and environment boundaries.
- Plain terminals start ephemeral; closing or archiving promotes them to durable
  History. Agents and Routine runs are durable from launch.

## Plain terminal status

A live plain shell is `idle`. PTY output cannot prove that a foreground command
started or ended. Only process exit changes it to done, stopped, error, or
interrupted. Do not infer command state from output or silence.

## Agent status signals

Native `activities/status.rs` reads CLI terminal control sequences. Codex
launches set a one-run `tui.terminal_title` override (Codex configuration is
not edited) so Mimir receives explicit word
states (Starting, Working, Thinking, Waiting, Ready, Action Required) even with
`tui.animations=false`. Resume refreshes this integration. Ordinary PTY
redraws never replace an explicit CLI status signal. Already running processes
need a new launch or resume to receive the override.

## Terminal links

`mimir://graph/<id>` links in terminal output open Graph Details. Links work
across line wraps and up to two indented continuation lines (consistent
indentation required). Recovery needs one matching ID in the loaded Graph; it
uses an in-memory index and does not read files or request data on hover.
Unloaded records, ambiguous matches, and table-border continuations are not
recovered.

## Workspace projection

Workspace switching hides other Project Activities but never stops or retargets
them. Home/custom-cwd Activities stay global. Scope is captured at launch and
does not change. Restoring an Activity from another workspace opens that
workspace first. Activities do not add folders to the project switcher. Each
workspace remembers its selected Activity and visible Editor tab for the app
session only.

## PTY lifecycle and recovery

- PTY bytes remain binary. Output and resize share one ordered sequence.
- xterm is the terminal state engine. One mounted run owns one xterm model,
  which keeps consuming output while hidden.
- Keep macOS background throttling disabled; batch output without crossing
  resize events, and reveal only after catch-up.
- Checkpoints and a bounded event tail live in
  `~/.mimir/activities/activities.sqlite3`.
- Checkpoint writes use run, revision, durable-sequence, and renderer-lease
  checks; a stale WebView cannot trim newer output.
- Never checkpoint a failed terminal model; clear its queued events before
  resume.
- Restored live processes become `interrupted`; Mimir never claims an old PTY
  survived application exit.
- Install the Activity listener before the initial native list and terminal
  restore calls.
- Stop is idempotent. Archive and clear require an ended Activity; native code
  enforces this, not only the UI.

Interrupted agents can resume their exact CLI session when their workspace
becomes active. One attempt per app session; explicit error after 45 s without
output. Deliberately stopped Activities do not resume.

Native ownership is `src-tauri/src/activities/` and `activity_commands.rs`.
Renderer ownership is the Activity stores, Workbench lifecycle composables,
main tabs, and Activity surfaces. Launcher and continuation details are in
[agent-setup.md](agent-setup.md).

## Terminal resize position

Resizing keeps the view at the bottom if already there. Otherwise a temporary
anchor follows the first visible logical line through wrapping changes; a
cleared-and-redrawn history falls back to saved scroll percentage.

The anchor lasts one second after the latest resize event. User input (wheel,
pointer, keyboard, paste), hiding the Activity, changing terminal buffers, or
starting a new run cancels it. Alternate screens keep the CLI's own behavior.
The anchor is not saved in checkpoints. Text
that has left scrollback cannot be recovered.

`terminalResizeAnchor.test.js` checks the real xterm buffer.
`scripts/check-terminal-resize.mjs` checks display scroll timing (Node +
Puppeteer Core; `PUPPETEER_MODULE` and `CHROME_PATH` select installations).
These checks do not establish macOS WebView behavior.
