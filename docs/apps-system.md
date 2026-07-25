# Apps

Apps are local instruments launched from the Apps Activity. Mim ships Changes
and Scratch; additional definitions live under `~/.mim/apps/`.

## Discovery

The native catalog accepts either:

- `~/.mim/apps/<name>/app.toml`
- `~/.mim/apps/<name>.toml`

Definitions are loaded independently. Invalid TOML, bad fields, missing
entries, and duplicate IDs appear as diagnostics while valid apps remain
launchable.

## Manifest

An embedded app directory can be as small as:

```toml
id = "notes"
title = "Notes"
description = "A local note instrument."
mode = "embedded"
entry = "index.html"

[[tools]]
name = "read"
mcpAlias = "notes_read"
description = "Read the current note."
inputSchema = { type = "object", properties = {} }
```

Supported modes and required fields:

| Mode | Required field | Behavior |
|---|---|---|
| `embedded` | `entry` | host local or HTTP UI in the Activity pane |
| `terminal` | `preset` | launch a configured preset with optional `args` |
| `process` | `command` | start an exact command/argv Activity |
| `window` | `entry` | open local or HTTP UI in a Tauri window |
| `rust-helper` | `helper` | invoke a host-implemented native surface |
| `action` | `actionTool` | call one canonical registry tool |

Common optional fields are `description`, `args`, `env`, `launchOnly`, and
`tools`. A local `entry` must remain inside its app directory. HTTP and HTTPS
entries are accepted explicitly.

`rust-helper` names require matching host code; they are not dynamically loaded
Rust libraries. The built-in Changes app uses `git-changes`.

## Embedded SDK

Local HTML is served through Mim's `app://` protocol. The host injects
`src/apps/sdk/theme-base.css` and `src/apps/sdk/mim-sdk.js`, exposing:

```js
window.mim.app
window.mim.data.load(key)
window.mim.data.save(key, value)
window.mim.data.delete(key)
window.mim.fs.readText(path)
window.mim.fs.writeText(path, content)
window.mim.fs.exists(path)
window.mim.http.fetch(url, options)
window.mim.tools.list()
window.mim.tools.call(name, input)
window.mim.tools.handle(name, handler)
window.mim.workspace.openFile(path)
```

App data is namespaced below `~/.mim/app-data/<app-id>/`.

## App-contributed tools

Each manifest tool becomes a canonical name `app.<app-id>.<name>` unless its
name is already qualified. Its default MCP alias is `<app-id>_<name>`.

The embedded app attaches the implementation with
`mim.tools.handle(name, handler)`. Calls flow through the canonical registry to
that specific app instance. Instance teardown unregisters its provider and
cancels outstanding calls.

## Host architecture

- `src-tauri/src/apps.rs`: catalog, validation, launch resolution, protocol,
  app data, and HTTP
- `src/mim/activities/AppsActivity.vue`: catalog UI
- `src/mim/activities/AppActivity.vue`: instance surface routing
- `src/mim/apps/EmbeddedAppHost.vue`: iframe and dynamic tool relay
- `src/mim/apps/LaunchPlanHost.vue`: non-embedded launch feedback
- `src/services/appsCatalog.js`: frontend bridge
- `src/apps/sdk/mim-sdk.js`: injected app API
