# Gotchas

Only current, non-obvious constraints belong here. Known defects belong in
[issues.md](issues.md).

## Terminal and Activities

- Load WebGL after `terminal.open()`; context loss falls back to the DOM
  renderer.
- Unicode 11 requires xterm `allowProposedApi: true`.
- Advance terminal sequence only from the asynchronous `Terminal.write()`
  callback.
- Open xterm before replay and serialize initial attachment with resumed
  `runId` changes.
- Wait for fonts before measurement; keep pixel-snap around WebGL. Spawn with
  the last fitted PTY size to avoid zsh's stray `%`.
- `updatedAt` changes during output and is not a stable Sidebar sort key.

## UI and input

- Editor toolbar actions use `mousedown.prevent` to retain selection.
- WKWebView does not focus buttons on click. Focus routing retains the last
  pane from capture-phase pointer input.
- Container keyboard handlers must ignore editable descendants and IME input.
- Tauri intercepts OS file drops, so HTML5 drag-and-drop does not work in the
  webview. In-app drag uses pointer events.
- Do not commit inline edits on blur when the window lost focus or the field
  became hidden.

## IPC, tools, and settings

- `persistence.rs` uses atomic writers. Corrupt JSON is preserved before
  defaults replace it; asynchronous snapshots must be serialized.

## Graph and Git

- Managed Git fetches do not close a young local batch.
- Auto-commit exclusions inspect the `HEAD` blob for tracked deletions.
- An excluded local binary or oversized file survives an unrelated incoming
  change. If the remote changed that path too, stop before moving `HEAD`.
- Legacy issue Project and assignee values can be labels, not node ids.
- Validate only relations introduced by an edit; existing edges can point
  outside mounted scopes.
- Graph writes bind source path, id, and revision; two workspaces can hold
  legacy entries with the same id.

## Editor and files

- Capture diff content before awaiting `proposal_respond`; its event can clear
  the renderer store before the invoke resolves.
- Visible Editor tab indexes are projections; translate through stable file ids.
- Cancel superseded native content searches and ignore late generations.
- Tauri's macOS drop coordinates are already logical. Do not divide by device
  pixel ratio without rechecking wry behavior.

## Scribe and platform

- A silent terminal transcript is valid and does not start summary work.
- Summary lifecycle and default follow-up job commit in one transaction.
- Startup must not walk all historical audio or model files.
- Platform-only window and capture APIs require compile-time guards.
