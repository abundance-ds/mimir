# Apps System

Apps are trusted, local instruments launched from the Apps Activity. They extend
the workbench without adding permanent core navigation or administration UI.
Apps may be polished, temporary, or deliberately hacky. There is no marketplace,
permission review, audit surface, setup wizard, or team-management layer.

## Product shape

- Apps is a core launcher Activity.
- Opening an app creates or selects one durable singleton Activity named
  `app:<app-id>`.
- The app Activity occupies the middle pane. The editor remains mounted.
- App definitions live below `~/.mim/apps`; two useful built-ins ship in the
  catalog even when that directory does not exist.
- Invalid definitions remain visible as diagnostics instead of making the whole
  catalog fail.
- Apps may call regular Tauri commands through the injected SDK and may
  contribute named tools to the canonical MCP registry.

This is a trusted local system for one person and a few teammates. The host pins
data calls and tool-provider ownership to the active app identity, but it does
not pretend local apps are untrusted third-party packages.

## Definition

Create either `~/.mim/apps/<id>/app.toml` or a TOML file directly below
`~/.mim/apps`.

```toml
id = "ledger"
title = "Ledger"
description = "Inspect the current research ledger."
mode = "embedded"
entry = "index.html"

[[tools]]
name = "total"
description = "Read the current ledger total."
mcpAlias = "ledger_total"
inputSchema = { type = "object", properties = {} }
```

Common fields:

| Field | Meaning |
|---|---|
| `id` | Stable ASCII identifier: letters, numbers, `_`, or `-` |
| `title` | Activity and catalog label |
| `description` | One-line catalog description |
| `mode` | One of the launch modes below |
| `tools` | Optional manifest-declared tools owned by this app |

Mode fields:

| Mode | Required fields | Host behavior |
|---|---|---|
| `embedded` | `entry` | Renders local HTML or an HTTP URL in the Activity pane |
| `terminal` | `preset`, optional `args` | Hands a terminal preset to the workbench runtime |
| `process` | `command`, optional `args`, `env`, `launchOnly` | Hands a local process plan to the runtime |
| `window` | `entry` | Hands a separate-window plan to the runtime |
| `rust-helper` | `helper` | Opens a compiled native helper surface |
| `action` | `actionTool` | Hands one canonical tool call to the runtime |

Relative embedded entries must remain inside the app directory. Rust resolves
them to files, and the renderer converts them to
`app://localhost/<app-id>/<entry>`. The custom protocol injects the SDK and base
theme into HTML responses.

## Activity and launch lifecycle

`app_catalog` returns built-ins, installed definitions, and diagnostics.
`app_resolve` validates a selected app and returns one typed launch plan.
`src/services/appsCatalog.js` converts that pair into a serializable Activity:

```js
{
  id: 'app:ledger',
  kind: 'app',
  retention: 'durable',
  source: { type: 'app', appId: 'ledger', app: definition },
  host: { type: 'app', mode: 'embedded' },
  launch: { plan: resolvedPlan }
}
```

`AppsActivity.vue` emits `{ app, launch, activity }`. The workbench upserts the
record and opens it. `AppActivity.vue` then selects the correct host:

- `ChangesApp.vue` for the `git-changes` Rust helper
- `ScratchApp.vue` for the built-in scratchpad
- `EmbeddedAppHost.vue` for general embedded apps
- `LaunchPlanHost.vue` for terminal, process, window, action, and other native
  helper plans

External execution is callback-based. `LaunchPlanHost` emits
`{ app, plan, activity, onStarted, onComplete, onError }`. It automatically
dispatches a fresh selected Activity once, but never replays a restored external
side effect. Restored Activities require an explicit launch click.

## Dynamic tools

Manifest tools become canonical registry tools:

```
app.<app-id>.<tool-name>
```

The optional `mcpAlias` is the short MCP name. Without one, the renderer uses
`<app-id>_<tool-name>`.

The host installs relay listeners before calling
`tool_app_provider_reconcile`. Tool ownership includes both the app id and
Activity instance id. A tool call arrives over `mim://tool-relay-request`; its
response returns through `tool_relay_response`. Cancellation arrives over
`mim://tool-relay-cancel`. Unmounting the host removes listeners and calls
`tool_app_provider_unregister`, which also clears in-flight calls.

This lifecycle means the MCP catalog advertises a tool only while a real handler
is attached.

### Embedded handler

An embedded app attaches the implementation by local name:

```html
<script>
  mim.tools.handle('total', async (input, { signal }) => {
    const ledger = await mim.data.load('ledger')
    return {
      value: { total: ledger?.total || 0 },
      displayText: String(ledger?.total || 0),
    }
  })
</script>
```

The injected SDK receives correlated tool calls from the parent, supplies an
`AbortSignal`, and sends the result or structured error back to the host.

## Embedded SDK

Every local HTML entry receives `src/apps/sdk/mim-sdk.js` and
`theme-base.css`. The global API is intentionally small:

```js
mim.app.id
mim.app.instanceId
mim.app.workspacePath

await mim.data.load(key)
await mim.data.save(key, serializableValue)
await mim.data.delete(key)

await mim.fs.readText(path, encoding)
await mim.fs.writeText(path, content)
await mim.fs.exists(path)

const response = await mim.http.fetch(url, options)
await mim.ui.alert(message)
await mim.ui.confirm(message)
await mim.ui.openFile(options)
await mim.ui.saveFile(options)

const removeHandler = mim.tools.handle(name, handler)
const tools = await mim.tools.list()
const value = await mim.tools.call('files.read', { path: 'README.md' })
await mim.workspace.openFile(path)
```

Inside an iframe, the SDK uses correlated `postMessage` calls. In a standalone
Tauri webview it invokes Tauri directly. Data commands are pinned by the parent
to the hosted app id. Tool-provider commands cannot be invoked through the
generic SDK bridge; tool registration and responses always use the owned host
relay.

App data is atomically persisted as JSON text below
`~/.mim/app-data/<app-id>/<key>.json`. `mim.data` performs JSON serialization.
The lower-level Tauri commands intentionally read and write raw strings.

## Built-ins

### Changes

Changes is a native Git worktree ledger backed by `git_status`. It includes:

- all, modified, added, deleted, and renamed filters with counts
- keyboard selection and Return to open
- absolute workspace-path resolution
- safe non-opening rows for deleted files
- active-only refresh polling, manual refresh, clean and error states

### Scratch

Scratch is a durable native Vue scratchpad. It restores and atomically saves its
text, reports honest loading/unsaved/saving/saved states, focuses when selected,
and contributes the live tool `app.scratch.read` (`scratch_read` over MCP).
The tool returns text, character count, line count, and the last persisted time.

These built-ins are deliberately different: Changes proves native workspace
helpers; Scratch proves durable app data and a live app-owned tool.

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/apps.rs` | Catalog, validation, resolution, custom protocol, data, window, HTTP |
| `src/services/appsCatalog.js` | Invoke adapters, Activity creation, SDK command bridge, tool relay |
| `src/stores/appsCatalog.js` | Catalog state, selection, launch preparation |
| `src/mim/activities/AppsActivity.vue` | Catalog and launcher |
| `src/mim/activities/AppActivity.vue` | Dynamic app Activity router |
| `src/mim/apps/ChangesApp.vue` | Built-in Git changes helper |
| `src/mim/apps/ScratchApp.vue` | Built-in scratchpad and tool handler |
| `src/mim/apps/EmbeddedAppHost.vue` | iframe lifecycle, SDK bridge, dynamic tool relay |
| `src/mim/apps/LaunchPlanHost.vue` | External-plan handoff and lifecycle feedback |
| `src/apps/sdk/mim-sdk.js` | Injected embedded-app SDK |
| `src/apps/sdk/theme-base.css` | Injected token palette and element defaults |

## Deliberate omissions

- no standard-UI agent runner or app-specific AI model API
- no setup-form schema
- no permissions, trust review, audit, or telemetry UI
- no marketplace, bundling profile, seeder, MRU ceremony, or version updater
- no DOCX-, knowledge-, issues-, or graph-specific app runtime
- no per-project app-data hierarchy

Apps that need intelligence launch a CLI agent or call the shared MCP capability
layer. Domain systems belong in apps and tools, not in app-platform chrome.
