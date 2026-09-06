# Apps

Apps are trusted local instruments. Built-ins include Today, Business Graph,
Scribe, and Tracker. User definitions live under `~/.mimir/apps/` as either
`<name>.toml` or `<name>/app.toml`.

- Stable Apps reopen one Tool Activity. Terminal and process Apps start a fresh
  PTY Activity.
- There is no marketplace, permission layer, generic Apps screen, or package
  trust model. Local App JavaScript has trusted file, HTTP, and tool access.
- Invalid definitions produce independent diagnostics and do not hide valid
  Apps.
- App id is stable identity for data, Activity records, and tool names. Changing
  a display title must not rename it.

## Manifest and launch modes

```toml
id = "notes"
title = "Notes"
mode = "embedded"
entry = "index.html"
```

| Mode | Required value | Result |
|---|---|---|
| `embedded` | `entry` | Local or HTTP UI in the Activity pane |
| `terminal` | `preset` | New PTY from a launcher preset |
| `process` | `command` | New exact-command PTY Activity |
| `window` | `entry` | Local or HTTP Tauri window |
| `rust-helper` | `helper` | Built-in native surface |
| `action` | `actionTool` | One internal registry call |

Local entries must remain inside the App directory and load through `app://`.
Terminal and process commands preserve argv boundaries. Rust helpers require
matching host code; they are not dynamic native modules.

## Embedded SDK and tools

The injected `window.mimir` SDK provides namespaced app data, trusted file
read/write, bounded HTTP, registry list/call/handle, and Editor file opening.
App data lives under `~/.mimir/app-data/<app-id>/`.

Manifest tools become internal names under `app.<app-id>.*`. Implementations
belong to one `(appId, instanceId)`; unmount or reload unregisters the old
provider and cancels pending calls. App tools and App-management commands are
not automatically public agent tools.

## Today

Today retains the historical `scratch` id and app-data key. It is an editable
Markdown day note with one optional Tomorrow draft.

- A date change snapshots the old day and files non-empty content into a
  private monthly Journal node.
- Failed Graph filing remains in a local retry queue and never blocks editing.
- Unchecked task blocks can carry to the new day; completed work and normal
  prose remain in Journal.
- Past days are read-only. Tomorrow is editable.
- `src/stores/today.js` owns live state, date changes, and serialized saves for
  both the UI and agent tools. Autosave drains edits made during a pending write.
  Appends preserve unsaved edits and use one Undo
  step when today's editor is displayed. Date navigation resets Undo.
  Closed-surface writes need no UI launch.
- Agent tool contract: [agent-interface.md](agent-interface.md).

Native catalog and protocol ownership is `src-tauri/src/apps.rs`. Renderer
ownership is the app catalog, Activity host, embedded/launch-plan hosts, and
`src/apps/sdk/`.
