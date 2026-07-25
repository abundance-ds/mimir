# Product Acceptance Contract

This is the completion contract for the product defined in
[synthesis.md](synthesis.md). It is intentionally end-to-end. Passing a narrow
unit test does not prove a product requirement unless the relevant runtime
behavior is also exercised.

## Product-wide invariants

- The product has one calm three-pane shell: Sidebar, Activity, Editor.
- Capabilities may be deep; permanent UI concepts stay few.
- All execution is represented as an Activity.
- MCP is the shared capability layer for `mimx`, agents, apps, and routines.
- Switching Activity never destroys or unexpectedly replaces Editor state.
- Comment storage remains the existing pseudo-XML model in Markdown.
- No removed domain or administration system is reintroduced through another
  name.
- There are no placeholders, inert controls, demo-only data, or unreported
  incomplete paths in a release build.

## A. Workbench

### Expanded layout

- Sidebar defaults to a dense expanded tray with workspace, launchers, apps,
  and Activities.
- Activity is flexible and never becomes narrower than its usable minimum.
- Editor opens at a useful review width and retains its existing tab/editor
  behavior.
- Both dividers resize smoothly, persist their widths, and expose an instant
  accent hover affordance over a generous hit target.

### Collapse model

- Sidebar collapses to a permanent 52px rail using the same mounted component.
- Activity and Editor collapse to mounted 44px rails with title and state.
- Stable launchers keep icons; dynamic Activities use deterministic monograms
  with status overlays and native title tooltips.
- Rows do not shift vertically between expanded and collapsed Sidebar states.
- At least one content pane remains expanded.
- Activity and Editor are never intentionally left as two simultaneous rails.
- The first expanded pane owns restore controls for rails to its left.
- `Cmd/Ctrl+B` toggles Sidebar; pane controls share one interaction grammar.
- Widths, rails, active Activity, and the relevant mounted state survive
  ordinary navigation and restart.

### Navigation and recovery

- Selecting a Sidebar launcher or Activity changes Activity only.
- Editor tabs, selection, dirty buffers, undo state, and scroll remain stable.
- Empty, missing, failed, and corrupt Activity states explain what happened and
  expose a direct recovery action.
- Close, archive, clear, and quit never silently discard dirty Editor state or
  running agent work.

## B. Activity lifecycle

- `terminal`, `agent`, `files`, `app`, and `routine` are first-class Activity
  kinds behind one stable identity and status contract.
- Activity statuses cover idle, working, needs input, done, stopped, and error.
- Status is visible in both expanded Sidebar rows and collapsed rail overlays.
- Dynamic Activities can be selected, renamed where meaningful, stopped,
  dismissed or cleared, and restored where the kind supports it.
- Ended Activities remain reviewable according to their persistence policy and
  do not accumulate as unexplained sidebar debris.
- Concurrent Activities keep independent processes, status, input, scroll, and
  view state.

## C. MCP capability spine

- One registry owns tool identity, description, JSON schema, discovery, and
  execution.
- MCP `tools/list`, MCP `tools/call`, `mimx`, app calls, and routine/agent calls
  reach the same registered actions.
- Invalid or missing schemas fail loudly during development.
- Core tools cover Editor state and control, comments, files, search, shell,
  web access, apps, routines, and runtime awareness.
- Apps can register and unregister named tools dynamically without rebuilding
  a separate catalog.
- Tool discovery reflects live app availability.
- Mim-launched Codex, Claude, and Pi sessions connect automatically without
  manual per-session setup.
- External local clients have a documented discovery path.
- A failed, timed-out, or cancelled tool call cannot hang the registry or leave
  an unresolved renderer request.
- Unsaved Editor state is represented honestly to callers.
- The broad registry does not require permission-review, audit, trace, Team, or
  capability-group UI.

## D. Terminals and CLI agents

### Terminals

- A Terminal launcher creates a new PTY-backed Activity in the workspace.
- Multiple terminals run concurrently and remain independent.
- Terminal resize, Unicode streaming, paste, links, zoom, focus, and process
  exit behave correctly.
- Plain terminals are intentionally ephemeral and quit cleanly.
- `mimx` is available inside Mim-spawned terminals without global installation.

### Agent catalog and presets

- Codex, Claude, and Pi binaries are detected from the real login environment.
- Missing and incompatible binaries produce useful launcher/settings states.
- A hackable configuration defines named presets with agent, flags,
  environment, and working directory behavior.
- Several presets may target the same agent.
- User flags survive restart and are passed without unsafe shell-string
  reconstruction.

### Agent sessions

- Each launch creates an independent Activity and PTY.
- Working, needs-input, idle, done, stopped, and error status are derived from
  real terminal signals with tested fallbacks.
- Bounded scrollback is captured even while the Activity is not mounted.
- Ended scrollback remains replayable after restart.
- Stop and application quit classify sessions correctly and clean up processes.
- Native resume restores the same agent session where the CLI supports it.
- Unsupported resume is explained and never faked.
- Restart reconciles stale running records without calling them failures.
- Completion and needs-input notifications are noticeable but restrained.

## E. Files

- Files opens as one stable Activity.
- The default recursive list is sorted by last modification descending.
- Agent, routine, app, terminal, and external writes update the list promptly.
- Ignored/build/cache noise is filtered without hiding relevant project work.
- Filename/path filtering is immediate.
- Rust-backed content search is cancellable, bounded, and responsive on a large
  workspace.
- Arrow keys move selection; Return opens; standard range/multi-selection
  behavior is consistent where offered.
- `Cmd/Ctrl+P` opens a global fuzzy file jump from every surface.
- Opening a supported text file adds or activates an Editor tab without
  changing Activity.
- Missing, renamed, deleted, unreadable, and externally changed files recover
  without blanking either pane.

## F. Apps

- App definitions are owned, local, and hackable.
- The host supports the real modes required by shipped apps: embedded UI,
  terminal/TUI, spawned process or bundled binary, separate window, and Rust
  helper capability.
- An app can open an Activity, perform a launch-only action, or do both.
- Apps can call the MCP registry and contribute live named tools.
- App lifecycle, output, cancellation, reload, process cleanup, and error
  reporting are observable without administrative ceremony.
- Embedded app UI receives the shared visual tokens and keyboard/focus behavior
  needed to feel native while remaining free to be bespoke.
- Developer reload and diagnostics make app iteration fast.
- At least two useful, materially different apps prove the host is reusable.

## G. Routines

- A routine is a file-defined schedule, agent preset, and prompt.
- Definitions are validated with precise file/field diagnostics.
- The scheduler calculates next fires correctly across restart, sleep/wake, and
  timezone/DST boundaries.
- A firing launches a headless CLI agent through the normal session substrate.
- Every run is a normal durable Routine Activity with live status and bounded
  scrollback.
- Routine agents receive the full MCP capability catalog.
- Overlap, cancellation, failure, missed fires, disabled presets, and missing
  binaries have deterministic behavior.
- Editing a definition refreshes the schedule without a separate routine
  management application.
- The UI exposes only the small controls needed to understand and operate the
  scheduler.

## H. Editor and review

- CodeMirror remains the document engine for Markdown, text, and supported code.
- Tabs, autosave, session restore, dirty state, conflict handling, formatting,
  live in-editor Markdown rendering, and keyboard commands remain reliable.
- Cmd/Ctrl+K supports selection and cursor insertion, follow-up refinement,
  project reads/search, automatic diff activation, and accept/reject.
- Ghost completion remains responsive, cancellable, configurable, and visually
  subordinate to authored text.
- Diff review preserves exact content, presents meaningful deltas, and handles
  stale edits honestly.
- MCP/`mimx` can open, inspect, reveal, edit, save, and understand dirty Editor
  state without corrupting selection or comments.
- Pseudo-XML comments and replies parse, render, edit, resolve, and round-trip
  without changing their storage model.
- The final comments presentation handles dense discussions, minimization,
  active-anchor navigation, replies, resolution, keyboard focus, and overlap
  with excellent micro-interactions.
- Citations/references, DOCX, export, PreviewPane, and Outline are absent.

## I. Visual and interaction quality

- The workbench uses IBM Plex Sans, Serif, and Mono according to semantic role.
- Chrome, chrome-high, surface, ink hierarchy, one accent, and hairline rules
  create depth without shadows or card clutter.
- The permanent rails are the visual signature and read as an instrument panel,
  not a generic dashboard.
- All supported themes retain hierarchy, contrast, syntax readability, and
  status legibility.
- Clickable controls have instant hover background affordances and native arrow
  cursors; links alone use pointer cursors.
- Keyboard focus is visible through `:focus-visible` and absent for ordinary
  pointer focus.
- Reduced motion, zoom, narrow windows, native traffic lights, scroll
  containment, menus, dialogs, and context menus behave coherently.
- Copy is declarative, compact, technically accurate, and free of promotional
  filler.

## J. Performance, reliability, and release

- PTY output and status parsing remain smooth under concurrent noisy sessions.
- File indexing/search and Activity events do not stall Editor typing.
- Editor performance remains stable for large Markdown documents and many
  comments.
- Persisted records use atomic writes and corrupt state cannot prevent launch.
- Child processes, listeners, timers, watchers, and servers are released on
  Activity close, workspace change, and application quit.
- Frontend tests, Rust tests, production build, Rust check, and packaged Tauri
  build pass without unexplained warnings.
- A packaged app can launch terminals and agents, find bundled resources,
  connect MCP, run a routine, search files, and preserve Editor AI behavior.
- Current-state documentation and the codebase map match the delivered system.

## Required completion evidence

Completion requires all of the following, plus focused tests for each subsystem:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Manual/runtime evidence must exercise the complete golden loop:

1. Open a workspace and a Markdown document.
2. Launch two different agent presets.
3. Observe independent live status and switch between their Activities.
4. Have one agent inspect the active Editor and comments through MCP.
5. Have it modify or create a workspace file.
6. See the file rise immediately to the top of Files.
7. Open and review it without losing the prior Editor tab state.
8. Run inline AI, review its diff, and preserve comment annotations.
9. Launch each shipped app mode and exercise a dynamic app tool.
10. Fire a scheduled routine and review its durable Activity after restart.
