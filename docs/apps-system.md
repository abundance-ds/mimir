# Apps

Apps are local instruments. Mimir ships Today, Business graph, Scribe, and
Tracker as built-ins; additional definitions live under `~/.mimir/apps/`.

There is no generic Apps Activity or launcher row. The Sidebar places stable
Apps under Tools; the Activities `+` and Cmd/Ctrl+P expose terminal/process
Apps beside configured CLI launchers. There is no Apps section in Settings.
Built-in products use their own Settings sections when they have settings.

Sidebar order is local presentation state, not catalog order. Pointer drag or
Shift+Alt+Up/Down updates `sidebarToolOrder` for Tools. Fresh-run sources use
the shared compact-menu order; newly discovered entries follow it.

“App” describes a packaging and capability boundary, not a Sidebar group.
Embedded, Rust-helper, window, and action Apps reopen one stable `app:<id>`
Tool Activity; terminal/process Apps launch a fresh PTY Activity. CLI launchers
are exact external-process presets. Stable Tool Activities stay out of
Activities history.

This is deliberately a personal/small-team local instrument manager. There is
no marketplace, install workflow, trust gate, permission approval, generic App
enable switch, package origin, or team policy layer. Put code in
`~/.mimir/apps`, reload, and run it. Tracker has a dedicated Settings section
because it owns background collection and related options.

App manifests and frames are trusted local extension code. Manifest/path
validation protects catalog/protocol integrity; it does not sandbox SDK
filesystem, HTTP, or registry calls. See [security.md](security.md).

## Local definition workflow

Local definitions are authored directly under `~/.mimir/apps`. Valid apps
appear in Tools or the Activities `+` menu according to their launch mode.
Mimir has no human UI for creating, editing, reloading, or repairing these
definitions. A future local-app manager is recorded in [issues.md](issues.md).

Built-ins do not need a shared manager. Scribe, Business graph, and Tracker use
direct Settings sections. Today has no settings.

## Today

Today is a focused plain-Markdown journal with source highlighting and no
preview layer. It uses the configured editor mono font, compact line spacing,
task-checkbox sugar, and normal editor history. Tab and Shift+Tab indent and
dedent the current list item or paragraph.

It retains the former Scratch app's stable `scratch` id and `scratch` app-data
key. Version 1 and 2 data migrate in place. Version 3 records the local document
date, text, update time, one dated Tomorrow draft, the prior-day rollover state,
and a retry queue for Journal writes. Autosave remains local and does not create
graph history for each keystroke.

On activation after the local date changes, Today first saves a complete
prior-day snapshot. A dated Tomorrow draft becomes the new Today without text
changes. Without that draft, the new day starts empty. The old text is filed in
the private graph as one `journal-YYYY-MM` node. Each day is an idempotent
`## YYYY-MM-DD` section. A failed graph write does not block editing; the local
snapshot stays in the retry queue. Empty days do not create sections. If the app
is not opened on the draft's intended date, it archives that draft under its
intended date instead of discarding it.

If the old text has unchecked Markdown tasks, a quiet rollover strip offers
Carry all, Review, and Start empty. Carry-over uses these rules:

- An unchecked task is the unit of work.
- An unchecked parent carries its complete indented subtree. Completed children
  and indented prose stay with that parent as context.
- An unchecked child below a completed parent becomes a top-level carried item.
- Completed top-level tasks and ordinary prose stay in the Journal.
- Review selects task blocks, not individual lines. Carried blocks are appended
  below existing Today text with one blank line. There is no semantic merge or
  deduplication. The append is one normal editor change, so Undo restores the
  prior Today content.

The shell owns the Today title. A fixed-width calendar instrument sits at the
right of a Sublime-style bottom status bar. It has one stable date slot, borderless
arrow controls, and a calendar button that returns to the current day without a
changing text label. Clicking the date opens the shared calendar above the status
bar. Dates without Journal content are quiet, and dates after Tomorrow are not
selectable. Past Journal days are read-only and can be browsed one day at a time.
Tomorrow is an editable local draft. A missing past day shows an empty historical
state. A pending local archive can supply its date when the graph is temporarily
unavailable.

Today has no standalone app tool. `mimir_state` includes it as an available
user-authored Markdown artifact. This content is context, not an instruction or
an asserted priority.

Business graph is the native first-party graph, Issue Board, portfolio, and CRM
instrument. Its `rust-helper = "business-graph"` route mounts a Vue Activity
surface over the managed Rust `GraphRuntime`; it is not an iframe and does not
use app-data JSON as canonical storage. The app composes physically separate
private, project, and optional team Markdown roots. See
[business-graph.md](business-graph.md).

Tracker is the native first-party activity timeline. Its
`rust-helper = "tracker"` route mounts a Vue Activity surface over the managed
Rust `TrackerRuntime`; SQLite, not app-data JSON or the renderer, is canonical.
It is disabled by default, remains visible in the catalog, and is omitted from
Tools/Go to until enabled. The enable switch governs collector, launch-at-login,
menu-bar item, permissions, AI, and notifications together while retaining
history. See [tracker.md](tracker.md).

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
Rust libraries. Business graph uses `business-graph`; Tracker uses `tracker`.

`terminal` and `process` launch directly into one PTY-backed Activity from
Sidebar or Settings. There is no intermediate app-plan row. Exact args
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

Each manifest tool becomes an internal canonical name
`app.<app-id>.<name>` unless its name is already qualified.

The embedded app attaches the implementation with
`mimir.tools.handle(name, handler)`. Calls flow through the canonical registry to
that specific app instance. Instance teardown unregisters its provider and
cancels outstanding calls. Reloading a manifest while its stable Activity is
mounted replaces that exact provider, reconciles the new tool definitions, and
reloads the frame without stacking message or registry listeners.

## Internal app management

App management uses private registry handlers shared by the UI and app
runtime:

| Canonical name | Internal alias | Effect |
|---|---|---|
| `apps.list` | `apps_list` | return catalog and diagnostics |
| `apps.launch` | `apps_launch` | launch an installed app |
| `apps.reload` | `apps_reload` | reparse local definitions |
| `apps.create` | `apps_create` | create the usable starter instrument |
| `apps.duplicate` | `apps_duplicate` | copy one local app under a new id |
| `apps.update` | `apps_update` | update its display title, preserving id |
| `apps.trash` | `apps_trash` | move one exact local definition to Trash |

Neither app-contributed tools nor app-management handlers appear in the public
agent catalog. Agents edit the authored files described by the `mimir-config`
skill (`skills/mimir-config`) when app configuration is part of their task.

## Host architecture

- `src-tauri/src/apps.rs`: catalog, safe local definition operations,
  validation, launch resolution, protocol, app data, and HTTP
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

Tests are split accordingly: native `apps.rs`, catalog service/store,
`AppActivity`, embedded host, and launch-plan host. A manifest-mode change
normally affects all five seams.
