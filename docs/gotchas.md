# Gotchas

Only current, non-obvious constraints belong here. Known defects belong in
[issues.md](issues.md).

## Terminal and Activities

- Load WebGL after `terminal.open()`; context loss falls back to the DOM
  renderer and is not a terminal failure.
- Unicode 11 requires xterm `allowProposedApi: true`.
- Advance terminal sequence only from the asynchronous `Terminal.write()`
  callback. Output and resize events share one ordered queue.
- Open xterm before replay and serialize initial attachment with resumed
  `runId` changes.
- Wait for fonts before measurement and keep the pixel-snap transform around
  WebGL. Spawn with the last fitted PTY size to avoid zsh's stray `%` line.
- Commands are exact argv arrays, never shell strings.
- Durable Activities retain records and terminal state, not live processes.
- Live Activities cannot be archived or cleared. Do not enforce this only in UI.
- `updatedAt` changes during output and is not a stable Sidebar sort key.
- `timezone = "local"` normally becomes UTC in a macOS GUI process; store an
  explicit IANA zone for local schedules.

## UI and input

- Keep the global button reset inside `@layer base`.
- Editor toolbar actions use `mousedown.prevent` to retain selection.
- WKWebView does not focus buttons on click. Focus routing must retain the last
  pane from capture-phase pointer input.
- Container keyboard handlers must ignore editable descendants and IME input.
- Do not commit inline edits on blur when the window lost focus or the field
  became hidden.
- Interface zoom is native webview zoom and uses capture-phase shortcuts.
- Tauri intercepts OS file drops, so in-app drag interactions use pointer
  events, not HTML5 drag-and-drop.

## IPC, tools, and settings

- Install renderer listeners before starting a native producer, then read its
  authoritative snapshot. Events are notifications, not durable state.
- Keep Codex's injected connection name `mimir_workbench`.
- Public agent tools are the explicit underscore-name allowlist. Internal
  dotted registry names are not public tools.
- App tool ownership is `(appId, instanceId)` and ends on unmount.
- Embedded local apps must use the validated `app://` route, not a file URL.
- Settings persist only through `settings.set`; direct assignment is reactive
  but not durable.
- Runtime state uses `persistence.rs` atomic writers. Corrupt JSON is preserved
  before defaults replace it, and asynchronous snapshots must be serialized.
- Native Quit waits for the renderer's dirty-document and session guards.
- Release credentials use Keychain. Plaintext `.env` and `keys.env` fallbacks
  are debug-only.
- Connections do not import another product's credentials. Managed Git is the
  exception: it uses installed `git` and the active GitHub CLI login.

## Graph and Git

- Managed Git fetches do not close a young local batch.
- Project auto-commit exclusions apply to tracked deletions by inspecting the
  `HEAD` blob, not only current worktree bytes.
- An excluded local binary or oversized file survives an unrelated incoming
  change. If the remote changed that path too, stop before moving `HEAD`.
- Unpublished markers are branch-bound. All mutating Git work shares one lock
  per repository.
- Sync errors are durable. Install the listener before activation sync and
  queue the error behind any diagnostic already visible.
- Legacy issue Project and assignee values can be labels, not node ids.
- Validate only relations introduced by an edit; existing edges can point
  outside mounted scopes.
- A rejected Graph save must clear queued navigation so the inspector remains
  escapable.

## Editor and files

- Hidden comment tags require decorations, atomic ranges, a change filter, and
  boundary key handlers. Deliberate tag mutations carry `commentMutation`.
- Capture diff content before awaiting `proposal_respond`; its event can clear
  the renderer store before the invoke resolves.
- Git stage and unstage verify the reviewed snapshot and never act on an
  unsaved matching Editor buffer.
- Visible Editor tab indexes are projections; translate through stable file ids.
- Ghost completion offsets become invalid after any edit or pointer move.
- Cancel superseded native content searches and ignore late generations.
- File-open events append to a native queue; listen before draining it.
- Tauri's macOS drop coordinates are already logical. Do not divide them by
  device pixel ratio without rechecking wry behavior.
- External move pairing by filesystem identity is conservative and best effort;
  direct UI mutations still need synchronous Editor reconciliation.

## Scribe and platform

- Microphone mute writes aligned silence; it is not pause.
- Capture callbacks only feed the realtime ring. Transcription consumes
  committed chunks and cannot backpressure capture.
- Scribe events invalidate snapshots; SQLite remains authority.
- Recovery keeps the transcription route and model recorded at Start.
- Repair is keyed by capture `runId`, stages output privately, and replaces the
  transcript only after a complete terminal pass.
- A silent terminal transcript is valid and does not start summary work.
- A user-written meeting title always wins over an automatic title.
- Meeting notes and transcripts are untrusted data, never commands.
- The summary lifecycle and default follow-up job commit in one transaction.
- An unresolved repair holds source audio even after job exhaustion.
- Local Scribe means in-process Whisper. Custom endpoints are public HTTPS and
  use endpoint-bound Keychain credentials.
- Scribe permission state belongs to the responsible Mimir app bundle. A bare
  terminal launch is not release evidence.
- Startup must not walk all historical audio or model files.
- Platform-only window and capture APIs require compile-time guards.
- Product version must match `package.json`, Cargo, and Tauri configuration.
