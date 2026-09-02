# Settings

This document records persistence and synchronization behavior that is not
obvious from individual settings controls. Defaults and valid UI choices remain
canonical in `src/stores/settings.js` and the corresponding component; do not
mirror the full list here.

## Ownership

`src/stores/settings.js` is the renderer API. It creates one ref per key from
`DEFAULTS`; Pinia unwraps those refs for component consumers. Desktop
persistence stores the complete snapshot under the top-level `editor` key in
`~/.mimir/settings.json`.

| Layer | Files | Responsibility |
|---|---|---|
| Defaults/reactivity/write queue | `src/stores/settings.js` | known keys, theme application, debounced serialized snapshots |
| Native persistence | `src-tauri/src/local_settings.rs` | atomic JSON, corruption quarantine, serialized read-modify-write |
| Invoke wrapper | `src/services/dataDir.js` | unwrap diagnostics and select full/editor saves |
| Controls | `src/shared/ui/SettingsDialog.vue`, `settings/*.vue` | UI validation and calls to `settings.set` |
| Workbench projection | `src/mimir/WorkbenchApp.vue` | workspace, layout, Activity ordering |
| Editor projection | `src/editor/App.vue` | editor/AI behavior and cross-window sync lease |
| Private registry projection | `src/services/toolRuntime.js` | filtered keys and shape-compatible updates |

## Mutation invariant

Only `settings.set(key, value)` schedules persistence. Direct assignment changes
reactive state but does not enter the save queue. This is intentional: hydration
and cross-window reload assign refs without echoing a disk write.

`set` clones objects before storing them, debounces 300ms, and enqueues a
complete snapshot. `save()` cancels the debounce and appends the current
snapshot; `flush()` either saves the pending snapshot or awaits the existing
queue. Queue failure does not poison later writes.

Any code mutating nested objects must construct a new value and call `set`; a
deep mutation such as `settings.workbenchLayout.sidebar.width = …` is not a
persisting API.

## Cross-window synchronization

Each mounted Workbench/standalone Editor acquires a settings sync lease.
After a successful native write, the caller invokes `settings_changed`; Rust
emits `mimir://settings-changed` to every other window
(see [ipc.md](ipc.md)).

On receipt, a window:

1. flushes its latest local snapshot;
2. reloads the complete `editor` object;
3. reapplies the theme.

This protects unsaved local edits but remains snapshot-based last-writer
coordination, not per-key merging. Do not introduce another writer that updates
`settings.json` without the native `SETTINGS_IO` lock and cross-window event.

Overlapping HMR instances may briefly hold leases. The listener is removed only
when the lease count reaches zero; an async listener installation that finishes
after the final release immediately disposes itself.

## Workbench settings are editor settings

Workspace folder/history, pane layout, terminal size, Activity navigation, and
comment-gate state share the `editor` namespace for compatibility with the
single renderer store. Their names are not evidence that Rust or the Editor
component owns them.

Workbench layout persistence is debounced during resize/navigation but flushed
on unmount and guarded Quit. On startup the saved layout is restored, then
Editor is forcibly expanded and responsive constraints are reapplied. Persisted
desktop width is retained across narrow responsive zones.

`workbenchZoom` is whole-window interface zoom (50-200%), applied as native
webview zoom by `src/shared/workbenchZoom.js`. Window creation reads it
natively (`local_settings::initial_workbench_zoom_factor`) so startup paints
at the saved zoom (see [runtime-architecture.md](runtime-architecture.md)).
It is a third scaling layer above `editorFontSize` and session-persisted
content zoom.

Shared scope settings follow the same mutation invariant:

- Mimir owns the Team root at `~/.mimir/team-graph/`. Settings connects it to a
  GitHub repository; it does not ask the user to choose or maintain a folder.
  Mimir uses the installed Git and GitHub CLI login; it stores no GitHub token.
  The root is created only after a temporary clone validates and completes its
  first sync. Until setup, Team is absent and Private and Workspace continue to
  work. Saved Team-folder settings are ignored. **Change repository** moves the
  current Team history to a pasted empty repository URL and keeps the old
  remote intact.
- `businessGraphViewState` stores the active section, per-section projection,
  Board grouping/sort, project and priority filters, and collapsed status
  columns. It is local presentation state, never graph source data.

The scope inventory in Settings reports which component folders exist in each
root. Changing view state must use `settings.set` with a newly constructed
object.

Settings > Graph also owns the compact Current workspace editor for its
optional semantic Project link and Team/Workspace write default. The durable
descriptor, local registry, setup prompt, and agent behavior are specified in
[Business graph](business-graph.md#workspaces-and-projects).
Project repositories with a GitHub HTTPS or SSH `origin` use managed Git
automatically. GitHub identity comes from the local GitHub CLI, not renderer
settings. For repositories without an origin, Settings connects an existing
empty GitHub repository from its pasted URL; repository creation, ownership,
and visibility stay on GitHub.

Files presentation state is also workspace-scoped. `workbenchFileFavorites`
stores favorite paths, and `workbenchFileSort` stores the Project, Recent, and
Favorites sort key and direction under each normalized workspace path. Both
use `settings.set` with a new top-level object.

`sidebarChatsCollapsed` and `chatNotifications` are local presentation/preference
state; they do not affect chat-server behavior. The Show Chats switch updates
native `chat.json` `enabled`, controlling the connection and native tool
registration before renderer startup; disabling preserves credentials.

## Chat connection settings

Chat identity is outside the renderer settings snapshot; the native chat runtime
owns `~/.mimir/chat.json` and credentials. See [security.md](security.md) and
[chat.md](chat.md).

## Scribe settings

Scribe configuration is also outside the renderer settings snapshot. The
native meeting platform owns `~/.mimir/meetings.json` because detection,
retention, and recovery must be available before any renderer mounts. The
Scribe settings component is a projection mutated only through
`meetings_update_config`.

The custom transcription secret is never part of that JSON or returned to the
renderer. `meetings_set_api_key` and `meetings_clear_api_key` address the
macOS Keychain entry directly; snapshots expose only
`apiKeyConfigured: boolean`. Detection changes propagate immediately to the
owned native monitor. Local model progress comes from the managed installation
state, not from optimistic renderer state. See [meetings.md](meetings.md).

## Connection settings

Connections are outside the renderer settings snapshot. The native connection
manager owns credentials in the OS keychain. The Settings section calls native
connect and disconnect commands and projects only provider state and account
labels. Tool registration changes in the same operation, without a restart.

Team graph, resource, skill, and agent content lives under the fixed managed
root `~/.mimir/team-graph/`. It is not renderer setting state. GitHub appears in
Connections and reports the local GitHub CLI login used by Team and Project
sync. **Manage** explains that this login is shared with Terminal and other
tools. Signing out removes the active account from GitHub CLI; it does not
delete local files or edit a Mimir configuration file.

## Internal settings handler

`settings.get` and `settings.update` are implemented in
`src/services/toolRuntime.js`, not Rust. They are private UI/runtime registry
handlers, not public agent tools. Their allowed keys match the prefixes
`editor`, `ai`, `comment`, `mimirWorkspace`, or `workbench`.

Updates enforce only:

- the key exists in the current store;
- the prefix is eligible for this private handler;
- the top-level value shape matches the current value.

They do not enforce component ranges or enum membership. `settings.update`
calls `set` for each key and then awaits an immediate complete save.

`activityNavigator`, `sidebarToolOrder`, `sidebarNewActivityOrder`,
`recentAppIds`, and `recentWorkspaceFolders` are excluded because their
prefixes do not match the filter.

## Change map

| Change | Required files/checks |
|---|---|
| Add setting | add default; use `set`; decide private-registry visibility; add persistence test; add control only if needed |
| Change object shape | migration/normalization at load site; update responsive/workbench consumers; test old stored shape |
| Add settings window | acquire/release sync lease and handle async installation after disposal |
| Change persistence namespace | `local_settings.rs`, `dataDir.js`, store hydration, recovery tests |
| Change private settings handler | `toolRuntime.js` validation and `toolRuntime.test.js` |
| Change theme | `AppearanceSection.vue`, `themes.css`, `DARK_THEMES`, terminal/app observers |
| Change Business graph settings | `stores/settings.js`, `GraphSettingsSection.vue`, graph app/Workbench mount watchers; settings and graph app tests |
| Change Chat connection settings | `ChatSettingsSection.vue`, `services/chat.js`, native `chat/`; credential/reconnect and UI tests |
| Change Scribe settings | `ScribeSettings.vue`, meetings service/store, native `meetings/platform.rs`; config corruption, Keychain, detector propagation, and UI tests |
| Change Connections | `ConnectionsSettingsSection.vue`, native `connections.rs`, public tool projection; status, credential, and live registration tests |

See [persistence.md](persistence.md), [workbench-design.md](workbench-design.md),
and [gotchas.md](gotchas.md).
