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
emits `mimir://settings-changed` to every other window.

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

`workbenchZoom` is whole-window interface zoom as a percent, normalized to
50–200 in the store on both `set` and load, and applied as native webview zoom
by a store watcher (`src/shared/workbenchZoom.js`). Window creation also reads
it natively (`local_settings::initial_workbench_zoom_factor`) so startup
paints at the saved zoom instead of flashing 100%. It is a third scaling layer
above `editorFontSize` and the editor's session-persisted content zoom, which
scale only editor text.

Business graph settings follow the same mutation invariant:

- `mimirTeamGraphFolder` is the optional physical `team:main` source configured
  in Settings > Graph. An empty value mounts only private and project scopes.
- `businessGraphViewState` stores the active section, per-section projection,
  Board grouping/sort/priority filter, and visible status columns. It is local
  presentation state, never graph source data.

Changing the team root remounts GraphRuntime against the current workspace;
changing view state must use `settings.set` with a newly constructed object.

`sidebarChatsCollapsed` is local presentation state for the Chats disclosure.
The header toggles it through `settings.set`, so the choice survives restarts
without becoming chat-server state.

`chatNotifications` is the local on/off preference for focused DM and @mention
alerts. System notification permission remains owned by the OS. Turning the
preference off does not alter server delivery, unread counts, or the dock
badge.

The Show Chats switch is not an ordinary renderer setting. It updates the
native `chat.json` `enabled` field because it must take effect before renderer
startup and atomically control the connection plus native tool registration.
Disabling preserves credentials and cached history.

## Chat connection settings

Chat connection identity is intentionally outside the renderer settings
snapshot. `src/shared/ui/settings/ChatSettingsSection.vue` calls the native
chat runtime, which owns `~/.mimir/chat.json`, the platform credential store,
connection status, and reconnect. The same surface changes the ordinary local
`chatNotifications` preference and requests OS permission deliberately.
Changing only display name reuses the saved credential; changing endpoint or
account requires a passphrase. See [chat.md](chat.md).

## File-first top-level namespaces

The CLI also reads two intentionally file-first top-level namespaces that the
renderer store preserves:

```json
{
  "connections": {
    "google": { "enabled": true, "account": "default" },
    "slack": { "enabled": true, "account": "default" },
    "granola": { "enabled": true }
  },
  "skills": {
    "catalogRoot": "/absolute/shared/catalog"
  }
}
```

The catalog root must be absolute. Missing connection accounts fall back to
the predecessor’s credential-free defaults and then `default`.

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

See [persistence.md](persistence.md), [workbench-design.md](workbench-design.md),
and [gotchas.md](gotchas.md).
