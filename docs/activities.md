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

## Agent status signals

Native `activities/status.rs` reads the CLI's terminal control sequences.
Codex launches use a one-run `tui.terminal_title` override with `app-name`,
`status`, and `activity`. The title gives Mimir an explicit word state even
when Codex has `tui.animations=false`, which removes its title spinner.
Starting, Working, Thinking, Waiting, and Ready drive the Activity record;
Action Required retains its blocking-input meaning. Existing spinner and
progress signals remain supported for other clients.

The override does not edit Codex configuration or enable its animations.
Exact resume refreshes this status integration while retaining recorded model,
permission, and tool flags. Already running CLI processes need a new launch or
resume to receive the override. Ordinary PTY redraws never replace an explicit
CLI status signal.

## Terminal links

Click a `mimir://graph/<id>` link in terminal or agent output to open Graph
Details in the Editor. Plain text, Markdown targets, and explicit CLI
hyperlinks use the same action. Links remain active across visual line wraps
and indented continuations after a slash. Graph targets use the same ID rules
as Editor links. File links and web links retain their existing actions.

## Workspace projection

The main tab strip shows the active working set for the current workspace. Workspace
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
- The live tab close/context action uses
  “Stop and archive”: request process closure, then archive after the native
  ended state arrives. AI CLI headers have no separate Stop button. Plain
  terminal header controls retain Ctrl-C interrupt.
  Ended session tabs show Archive; unique tool tabs show Close.

Interrupted agent rows can resume their exact CLI session when their workspace
becomes active. Restore is limited to one attempt per app session, keeps startup
output quiet, and becomes an explicit error after 45 seconds without output.
Deliberately stopped Activities do not resume.

Native ownership is `src-tauri/src/activities/` and `activity_commands.rs`.
Renderer ownership is the Activity stores, Workbench lifecycle composables,
main tabs, and Activity surfaces. Launcher and continuation details are in
[agent-setup.md](agent-setup.md).

Cmd+Up/Down scroll; Cmd+Left/Right send Ctrl-A/E; Cmd+Delete sends Ctrl-E,U; Shift+Enter sends Ctrl-J.

## Terminal resize position

Resizing keeps the view at the bottom if it was already there. When reading
earlier output, a temporary marker follows the first visible logical line
through changes to line wrapping. If the CLI clears history and redraws it,
the saved scroll percentage gives an approximate position instead.

The anchor remains active for one second after the latest resize request or
applied resize event. Output restoration is limited to once per display frame;
output alone does not extend this period. The anchor is not saved in checkpoints.
Wheel, pointer, touch, keyboard, and paste input cancel it. Hiding the Activity,
changing terminal buffers, or starting a new run also cancels it. Alternate
screens retain the CLI's own behavior. Text that has left scrollback cannot be
recovered by an anchor.

`terminalResizeAnchor.test.js` checks the real xterm buffer. The browser check
in `scripts/check-terminal-resize.mjs` also checks display scroll timing through
width and height changes and split redraws. Run it with Node and Puppeteer Core;
`PUPPETEER_MODULE` and `CHROME_PATH` can select local installations. These checks
do not establish installed macOS WebView behavior.
