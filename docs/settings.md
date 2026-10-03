# Settings

`src/stores/settings.js` owns renderer settings. Desktop persistence saves a
complete snapshot as the `editor` section in `~/.mimir/settings.json`; defaults
and valid values are canonical in the store and controls.

## Mutation and synchronization

- Only `settings.set(key, value)` persists. Direct mutation changes reactive
  state but skips the save queue.
- `set` clones object values, debounces (300ms), and serializes complete
  snapshots. `flush()` waits for the current or pending snapshot.
- Each Workbench or standalone Editor owns a settings-sync lease. Install the
  cross-window `mimir://settings-changed` listener before loading state; remove
  it only after the final lease ends.
- After a write, other windows flush, reload, and reapply theme. This is
  last-writer snapshot coordination, not per-key merging.
- Layout and navigation writes flush on unmount and confirmed Quit.

## Separate native settings

Not part of the renderer snapshot:

| Owner | Storage |
|---|---|
| Scribe | `~/.mimir/meetings.json` + Keychain |
| Chat | Native chat storage + Keychain |
| Connections | Native connection manager + Keychain |
| Team/Project Git | Repository state + shared GitHub CLI login |
| Tracker | Tracker SQLite |

Settings components project these native owners through service commands. They
must not create a second renderer authority.

The `settings.get` and `settings.update` tool handlers
(`src/services/toolRuntime.js`) expose only approved keys and are not public
agent tools.

Native JSON ownership: `src-tauri/src/local_settings.rs` and `persistence.rs`.
Cross-window ordering is in [ipc.md](ipc.md); Team and workspace setup is in
[business-graph.md](business-graph.md).
