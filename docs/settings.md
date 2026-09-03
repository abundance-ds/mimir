# Settings

`src/stores/settings.js` owns renderer settings. Desktop persistence stores one
complete snapshot under `editor` in `~/.mimir/settings.json`; defaults and valid
values remain canonical in the store and controls.

## Mutation and synchronization

- Only `settings.set(key, value)` persists a change. Direct or nested mutation
  changes reactive state but does not enter the save queue.
- `set` clones object values, debounces, and serializes complete snapshots.
  `flush()` waits for the current or pending snapshot.
- Each Workbench or standalone Editor owns a settings-sync lease. Install the
  cross-window listener before loading state; remove it only after the final
  lease ends.
- After a write, other windows flush their local snapshot, reload, and reapply
  theme. This is last-writer snapshot coordination, not per-key merging.
- Layout and navigation writes flush on unmount and confirmed Quit.

## Separate native settings

These are not part of the renderer snapshot:

- Scribe configuration and Keychain status: `~/.mimir/meetings.json`.
- Chat connection state and credentials: native chat storage and Keychain.
- Provider connections: native connection manager and Keychain.
- Team and Project Git: repository state plus the shared GitHub CLI login.
- Tracker configuration: Tracker SQLite.

Settings components project these native owners through their service commands.
They must not create a second renderer authority.

The private internal `settings.get` and `settings.update` registry handlers live
in `src/services/toolRuntime.js`. They expose only approved editor, AI, comment,
workspace, and workbench keys and are not public agent tools.

Native JSON ownership is `src-tauri/src/local_settings.rs` and
`persistence.rs`. Cross-window event ordering is in [ipc.md](ipc.md); Team and
workspace setup is in [business-graph.md](business-graph.md).
