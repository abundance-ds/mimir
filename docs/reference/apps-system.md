# Apps

Apps are local instruments. Mimir ships Today and Business graph as built-ins;
additional definitions live under `~/.mimir/apps/`.

There is no generic Apps Activity or launcher row. The Sidebar places stable
Apps under Tools and terminal/process Apps under New activity beside configured
CLI launchers. Settings > Apps is the catalog: inspect, reload, diagnose,
search, launch, open or reveal definitions, duplicate them, rename their
display title, or move them to the operating-system Trash.

Sidebar order is local presentation state, not catalog order. Pointer drag or
Shift+Alt+Up/Down updates `sidebarToolOrder` for Tools and
`sidebarNewActivityOrder` for fresh-run sources. Newly discovered entries
follow the established order until placed manually.

“App” describes a packaging and capability boundary, not a Sidebar group.
Embedded, Rust-helper, window, and action Apps reopen one stable `app:<id>`
Tool Activity; terminal/process Apps launch a fresh PTY Activity. CLI launchers
are exact external-process presets. Stable Tool Activities stay out of
Activities history.

This is deliberately a personal/small-team local instrument manager. There is
no marketplace, install workflow, trust gate, permission approval, enable
switch, package origin, or team policy layer. Put code in `~/.mimir/apps`, reload,
and run it.

App manifests and frames are trusted local extension code. Manifest/path
validation protects catalog/protocol integrity; it does not sandbox SDK
filesystem, HTTP, or registry calls. See [security.md](security.md).

## Settings workflow

`Settings > Apps` is the management surface; Tools and New activity are the
fast access surfaces.

- Search matches title, id, description, host mode, and declared tool metadata.
  Arrow keys move the selected row; Enter launches it.
- **New** creates a working embedded app rather than an empty folder. Its
  starter note autosaves through the SDK and implements a live `read` MCP tool.
- Reload reparses external edits and shows per-definition diagnostics without
  hiding healthy apps.
- Open definition sends `app.toml` to the right-hand Editor. Reveal opens the
  local definition in Finder/file manager.
- Duplicate copies a directory app and its assets under a new stable id.
  Symlinks and packages above 512 entries/32MB are rejected rather than followed
  blindly.
- Rename changes only the human display title. The id is intentionally stable:
  it owns app data, Activity identity, and generated tool names.
- Trash moves one exact local manifest or package to the operating-system
  Trash. Namespaced app data is retained.

Mutations return the fresh catalog, so Sidebar launch rows update immediately.
Built-ins are visible and launchable but never mutated.

Today is a full-pane durable top-priority editor with minimal Markdown source
highlighting and no preview layer. It retains the former Scratch app's stable
`scratch` id, `scratch` app-data key, and `scratch_read` MCP alias, so saved
text and integrations survive the presentation change.

Business graph is the native first-party graph, Issue Board, portfolio, and CRM
instrument. Its `rust-helper = "business-graph"` route mounts a Vue Activity
surface over the managed Rust `GraphRuntime`; it is not an iframe and does not
use app-data JSON as canonical storage. The app composes physically separate
private, project, and optional team Markdown roots. See
[business-graph.md](business-graph.md).

## Discovery

The native catalog accepts either:

- `~/.mimir/apps/<name>/app.toml`
- `~/.mimir/apps/<name>.toml`

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
| `terminal` | `preset` | launch a configured preset with optional `args` and `env` |
| `process` | `command` | start an exact command/argv Activity |
| `window` | `entry` | open local or HTTP UI in a Tauri window |
| `rust-helper` | `helper` | invoke a host-implemented native surface |
| `action` | `actionTool` | call one canonical registry tool |

Common optional fields are `description`, `args`, `env`, `launchOnly`, and
`tools`. A local `entry` must remain inside its app directory. HTTP and HTTPS
entries are accepted explicitly.

`rust-helper` names require matching host code; they are not dynamically loaded
Rust libraries. Business graph uses `business-graph`.

`terminal` and `process` launch directly into one PTY-backed Activity from
Sidebar, Settings, or MCP. There is no intermediate app-plan row. Exact args
and app env are preserved, while the new Activity id and Mimir MCP endpoint
remain host-authoritative. Window/action plans keep an inspectable renderer
host for completion, failure, and explicit relaunch feedback.

## Embedded SDK

Local HTML is served through Mimir's `app://` protocol. The host injects
`src/apps/sdk/theme-base.css` and `src/apps/sdk/mimir-sdk.js`, exposing:

```js
window.mimir.app
window.mimir.data.load(key)
window.mimir.data.save(key, value)
window.mimir.data.delete(key)
window.mimir.fs.readText(path)
window.mimir.fs.writeText(path, content)
window.mimir.fs.exists(path)
window.mimir.http.fetch(url, options)
window.mimir.tools.list()
window.mimir.tools.call(name, input)
window.mimir.tools.handle(name, handler)
window.mimir.workspace.openFile(path)
```

App data is namespaced below `~/.mimir/app-data/<app-id>/`.

## App-contributed tools

Each manifest tool becomes a canonical name `app.<app-id>.<name>` unless its
name is already qualified. Its default MCP alias is `<app-id>_<name>`.

The embedded app attaches the implementation with
`mimir.tools.handle(name, handler)`. Calls flow through the canonical registry to
that specific app instance. Instance teardown unregisters its provider and
cancels outstanding calls. Reloading a manifest while its stable Activity is
mounted replaces that exact provider, reconciles the new tool definitions, and
reloads the frame without stacking message or registry listeners.

## App catalog through MCP

App management expands the same canonical registry used by the UI, `mimir`,
launched agents, routines, and apps:

| Canonical name | MCP alias | Effect |
|---|---|---|
| `apps.list` | `apps_list` | return catalog and diagnostics |
| `apps.launch` | `apps_launch` | launch an installed app |
| `apps.reload` | `apps_reload` | reparse local definitions |
| `apps.create` | `apps_create` | create the usable starter instrument |
| `apps.duplicate` | `apps_duplicate` | copy one local app under a new id |
| `apps.update` | `apps_update` | update its display title, preserving id |
| `apps.trash` | `apps_trash` | move one exact local definition to Trash |

Reveal/open-folder remain UI-local because they are navigation effects, not
useful automation capabilities.

## Host architecture

- `src-tauri/src/apps.rs`: catalog, safe local definition operations,
  validation, launch resolution, protocol, app data, and HTTP
- `src/shared/ui/settings/AppsSettingsSection.vue`: searchable management UI
- `src/shared/ui/settings/AppSettingsSectionRows.vue`: keyboard catalog rows
- `src/mimir/activities/AppActivity.vue`: instance surface routing
- `src/mimir/apps/EmbeddedAppHost.vue`: iframe and dynamic tool relay
- `src/mimir/apps/LaunchPlanHost.vue`: window/action and restored-plan feedback
- `src/services/appsCatalog.js`: frontend bridge
- `src/apps/sdk/mimir-sdk.js`: injected app API

## Change map

Launch resolution crosses native and renderer owners:

- `apps.rs` validates the manifest and returns an explicit launch plan;
- `stores/appsCatalog.js` constructs a stable renderer Activity proposal;
- `WorkbenchApp.vue` sends terminal/process plans directly through the native
  Activity runtime, avoiding a duplicate plan Activity;
- `AppActivity.vue` routes embedded/window/action/Rust-helper/restored plans;
- `EmbeddedAppHost.vue` owns frame handshake and tool-provider lifetime;
- `LaunchPlanHost.vue` owns inspectable window/action completion and retry.

App `id` is the stable key for definition collision, app data, Activity
identity, and generated tool names. Display-title mutation must never rename
it. Runtime tool ownership additionally includes `instanceId`; replacing an
instance retires the prior provider before registering the new one.

Tests are split accordingly: native `apps.rs`, catalog service/store, Settings
catalog, `AppActivity`, embedded host, and launch-plan host. A manifest-mode
change normally affects all six seams.
