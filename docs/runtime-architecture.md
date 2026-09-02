# Runtime architecture

Bootstrap order, hydration constraints, and shutdown sequence.

## Authority map

| Concern | Authority | Renderer projection |
|---|---|---|
| PTYs, process exit, durable Activity records | `src-tauri/src/activities/supervisor.rs` | `src/stores/activityRuntime.js`, `src/stores/activities.js` |
| Activity navigation and pane geometry | `src/stores/workbench.js` | `src/mimir/WorkbenchApp.vue`, `src/mimir/components/WorkbenchShell.vue` |
| Tool definitions, aliases, providers, calls | `src-tauri/src/tool_registry.rs`, `tool_runtime.rs` | `src/services/toolRuntime.js`, app-provider relay |
| Tool-server socket lifetime | `src-tauri/src/tool_server.rs` | renderer client leases in `src/services/toolRuntime.js` |
| Routine definitions and scheduler | `src-tauri/src/routines.rs`, `routine_runtime.rs` | `src/stores/routines.js` |
| Workspace index and safe manager mutations | `src-tauri/src/file_index.rs`, `workspace_files.rs` | `src/stores/workspaceFiles.js` |
| Business graph Markdown, indexes, scopes, revisions | physical graph roots through `business_graph::GraphRuntime` | `src/stores/businessGraph.js`, built-in Business graph app |
| Tracker configuration, timeline, classifications, imports, background lifecycle | `tracker::TrackerRuntime` and `~/.mimir/tracker/tracker.sqlite` | `src/stores/tracker.js`, built-in Tracker app |
| Open buffers, dirty state, editor review state | renderer Pinia stores and `src/editor/App.vue` | native session/proposal coordination only where required |
| Settings snapshot | `~/.mimir/settings.json` through `local_settings.rs` ([settings.md](settings.md)) | `src/stores/settings.js` |
| Unsaved editor recovery | `~/.mimir/session.json` through `session.rs` | `sessionPersist.js`, `sessionRestore.js` |
| AI credentials and upstream transport | Rust keychain/transport modules | renderer builds requests and consumes streams |

Do not move authority into a convenient caller. In particular, renderer stores
may optimistically project native state but must reconcile native Activity,
Routine, proposal, and registry results.

## Native bootstrap

`src-tauri/src/lib.rs::run` constructs the registry, tool runtime, Activity
supervisor, Routine runtime, Tracker runtime, and managed Business graph runtime
before building Tauri. Setup then performs this order:

1. install `mimir` CLI and the Pi extension;
2. create the `main` window;
3. attach Activity and Routine event sinks;
4. start the Routine runtime and install Tracker; disabled Tracker starts no
   collection, while enabled Tracker restores its lifecycle and menu-bar item;
5. register renderer-backed core definitions and native Business graph tools,
   then begin registry revision observation;
6. install the native ConnectionManager, which projects currently connected
   providers into the same registry;
7. install ChatRuntime with app handle and tool registry;
8. queue startup file arguments.

The MCP HTTP listener is intentionally absent from this list. Core definitions
exist before the renderer, but `src/services/toolRuntime.js` starts the socket
only after its relay listeners exist. This prevents an accepted tool call from
arriving before the renderer can handle it.

Tracker is an optional bootstrap boundary. Failure to open its database,
including a deliberately unsupported newer schema, creates a managed
unavailable state instead of aborting `run()`. Tracker commands then expose a
disabled error projection or reject mutations, while the rest of Mimir starts
normally. Tracker installation errors are logged and projected but never
returned from Tauri setup. A disabled Tracker owns no polling thread.

Tauri state construction must remain independent of renderer mount/HMR.
Window destruction calls `ToolRuntime::disconnect_window`; destruction of
`main` additionally closes every tool-server lease.

## Renderer bootstrap

`src/main.js` selects either the workbench or standalone Editor by query
parameter. `WorkbenchApp.vue` composes three controllers:

- `useWorkspaceBootstrap.js` owns settings/layout/workspace startup and
  responsive projection;
- `useActivityLifecycle.js` owns close/archive/clear/restart transitions;
- `useWorkbenchKeyboardRouting.js` owns focus classification and shortcut
  dispatch.

The bootstrap path:

1. installs core renderer-only Activity records (`files`, `routines`);
2. installs global key/focus/resize handlers;
3. awaits settings before restoring layout;
4. forcibly expands Editor so stale layout cannot boot without it;
5. concurrently loads launchers, native Activities, MCP relay, and Apps;
6. opens the saved workspace only after those independent systems settle;
7. restores the selected Activity if it still exists.

The four concurrent initializers fail independently. A launcher failure does
not prevent native Activity restoration; an App failure does not tear down MCP.
Preserve that isolation rather than replacing it with one all-or-nothing
bootstrap promise.

Opening or switching a workspace mounts the Business graph separately through
`useWorkspaceBootstrap.js`: the local Private root, current Workspace root,
and optional managed `~/.mimir/team-graph/` root are normalized into one
`GraphRuntime`. Native filesystem watchers
rebuild the disposable index after an external Markdown change and emit
`mimir://graph-changed`; the renderer reloads its projection. An unavailable
managed Team root does not change the physical meaning of the Private or
Workspace source.

`useEditorSessionLifecycle.js` owns a second hydration transaction inside the
mounted Editor. Ordering constraints: session restore must complete before
the blank draft is created; persistence must start before listener
installation. See [editor-system.md](editor-system.md) for detail.

Async lifecycle controllers independently reject or tear down late listener
registration after disposal; `App.vue` keeps ordering guards after awaited
steps.

## Renderer/native boundary

Service boundary convention: see [ipc.md](ipc.md).

Core singleton Activities are renderer records; process-backed Activities are
native records. `activityRuntime.js` therefore treats non-PTY rename/archive/
clear locally but delegates PTY records to Rust. Changing a host type can
change which side is authoritative even when the Activity shape is unchanged.

The Editor deliberately stays renderer-owned because CodeMirror, dirty buffers,
and proposal presentation must survive Activity navigation. Native proposal
state coordinates callers and cross-window application; it is not a second
editor store.

## Shutdown

Normal window close and application Quit are guarded differently but converge
before native exit:

1. Rust intercepts an application `ExitRequested`, prevents it, emits
   `mimir://quit-requested`, and focuses `main`.
2. `src/editor/appQuit.js` runs the editor close guard without closing the
   native window.
3. The guard awaits hydration, flushes CodeMirror, asks about every dirty
   document, and writes a session snapshot that honors discarded files.
4. Settings are flushed after the session.
5. Only then does `app_quit_confirmed` call `app.exit(0)`.
6. Rust disconnects Chat; stops Tracker, closes its live interval, persists
   shutdown time, and checkpoints SQLite; then stops the Routine background
   loop, interrupts live Activities, persists their final state, and flushes
   the Activity SQLite store.

Direct window close uses `windowCloseGuard.js`; its `allowNativeClose` flag
permits exactly the close initiated after confirmation. Reentrant close
requests share one promise.

Unmount cleanup is still required for HMR and destroyed child windows:
Workbench flushes layout/settings and releases runtime leases; Editor flushes
CodeMirror before canceling persistence and unregisters its proposal snapshot.

## Change map

| Change | Read together | Primary tests |
|---|---|---|
| Tauri setup or managed state | `src-tauri/src/lib.rs`, relevant runtime constructor | Rust module tests; frontend smoke/build |
| Graph roots, watcher, or source refresh | `business_graph/runtime.rs`, `store.rs`, `WorkbenchApp.vue`, graph store/service | native scope/watcher/mutation tests; graph store/app tests |
| Tracker lifecycle or sampling | `tracker/runtime.rs`, `engine.rs`, `platform.rs`, `WorkbenchApp.vue`, tracker store/service | native tracker tests; store/app/settings tests; desktop permission/tray/sleep smoke |
| Workbench initialization | `useWorkspaceBootstrap.js`, `WorkbenchApp.vue`, `activityRuntime.js`, `toolRuntime.js` | Workbench controller/integration and store/service tests |
| Editor hydration/recovery | `useEditorSessionLifecycle.js`, `sessionRestore.js`, `sessionPersist.js` | Editor lifecycle, session restore/persist, and Settings tests |
| Window/application close | `windowCloseGuard.js`, `appQuit.js`, `lib.rs` exit handler | `windowCloseGuard.test.js`, `appQuit.test.js` |
| Runtime teardown/HMR | component unmount hooks, tool-server lease code | `toolRuntime.test.js`, `WorkbenchApp.test.js` |

See [ipc.md](ipc.md), [persistence.md](persistence.md), and
[gotchas.md](gotchas.md) before changing ordering across these boundaries.
