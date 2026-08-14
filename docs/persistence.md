# Persistence and recovery

This document records write ownership, ordering, and recovery behavior. The
paths alone are listed in [_MAP.md](_MAP.md); the important distinction here is
which state is authoritative, which writes are serialized, and what survives a
crash.

## Persistence inventory

| Artifact | Writer/loader | Non-obvious behavior |
|---|---|---|
| `~/.mimir/settings.json` | `local_settings.rs`, `stores/settings.js` | one top-level object; renderer settings live under `editor`; partial editor save preserves other top-level namespaces |
| `~/.mimir/session.json` | `session.rs`, `sessionPersist.js` | contains recovery content only for dirty named files and nonempty drafts |
| `~/.mimir/models.json` | `ai_models.rs` | embedded product defaults replace known model/provider metadata on version migration; unknown user models survive |
| `~/.mimir/launchers.json` | `launchers.rs` | versioned whole-file config; malformed/unsupported input recovers to defaults with diagnostics |
| `~/.mimir/activities/*.activity.json` | Activity persistence worker | only durable records; scrollback chunks and sequence state share the same snapshot |
| `~/.mimir/routines/*.toml` | user, Routine UI | source files are the database; mutation is revision-guarded |
| `~/.mimir/routines-state.json` | `routine_runtime.rs` | planner cursor only; definitions remain TOML authority |
| `~/.mimir/apps/*.toml`, `*/app.toml` | user, Apps UI | source definitions are authoritative; catalog diagnostics do not hide healthy definitions |
| `~/.mimir/app-data/<app-id>/<key>.json` | app SDK through `apps.rs` | namespaced by validated app id/key; value bytes are opaque to Rust |
| private/project/team `knowledge/*.md`, `issues/*.md` | user, GraphRuntime UI/tools | Markdown is canonical; every node retains physical scope/path/revision; the in-memory GraphStore is disposable |
| `~/.mimir/tracker/tracker.sqlite` | `tracker/store.rs`, `tracker/runtime.rs` | WAL database for configuration, exact activity intervals, rules/jobs, usage, nudges, and idempotent imports; disabled state retains data |
| `~/.mimir/keys.env` | `ai_keys.rs`, debug only | owner-only atomic plaintext fallback when keychain storage fails |

API keys in release builds are not file persistence: the OS keychain service
is `rs.shoulde.mimir`, keyed by the provider environment-variable name.

## Atomic writer

All durable writes go through `src-tauri/src/persistence.rs` helpers -- never
raw `fs::write`. The primitive serializes first, writes to a temp sibling,
flushes+syncs, then atomically renames. Existing file permissions survive
replacement; secret fallback writes apply owner-only permissions before bytes
enter the temp file. Parent-directory fsync is debounced (~2s); a crash inside
the window can lose the rename but never a synced file's contents.

## Corrupt-state quarantine

JSON loaders using `load_json_optional_quarantining` distinguish missing,
valid, and malformed state. Malformed bytes are renamed untouched to a unique
`.corrupt-*` sibling before defaults or a clean replacement are written.
Filesystem errors still fail the operation.

Quarantine currently applies to settings, session, model registry, launchers,
Activity snapshots, Routine planner state, and business-graph event logs
(`business_graph/runtime.rs`). Tracker separately runs SQLite `quick_check`;
an unreadable/damaged database and its WAL/SHM siblings move to a timestamped
`.corrupt-*` sibling before a clean database is created, while a newer schema
fails closed. User-authored App/Routine TOML
is not quarantined: each invalid definition remains in place and becomes a
catalog diagnostic so the user can repair its source.

Business graph Markdown follows the same source-respecting rule: malformed
files remain untouched and appear in graph diagnostics. Delete moves the exact
source to system Trash and keeps a bounded in-memory backup/undo token for
immediate restore; the operating system remains the durable recovery surface.

An unsupported Activity persistence version is quarantined even when its JSON
is valid. Restored live durable Activities are rewritten as interrupted because
process/PTY handles are intentionally not persisted.

## Write serialization

Atomic replacement prevents partial files; it does not prevent an older
snapshot from winning. Each high-frequency owner adds ordering:

- Settings: snapshot+chain semantics in renderer, `SETTINGS_IO` lock in Rust;
  see [settings.md](settings.md) and [ipc.md](ipc.md) for cross-window sync.
- `src/editor/sessionPersist.js` chains saves after a one-second debounce.
  Cleanup returns the current chain; explicit close flush appends the final
  snapshot.
- Activity persistence uses one native worker. It batches 20ms of commands and
  keeps only the latest save/delete per path. Delete and flush acknowledgements
  are issued only after that batch is applied.
- Routine planner updates are written atomically after calculation; TOML
  mutations require the caller's source revision to match current bytes.
- Graph updates compare an optional source revision and use same-directory
  atomic replacement. External source watchers rebuild the read model; they do
  not become a competing writer.
- Tracker has one mutex-serialized SQLite connection. Imports use one
  transaction; high-frequency intervals update rows in place; normal shutdown
  closes the current interval and checkpoints WAL before native exit.

Do not bypass these queues with a direct invoke or assignment.

## Editor recovery semantics

`createSessionSnapshot` stores:

- clean named files as path plus optional project owner;
- dirty named files as path + recovery content + `dirty: true` plus optional
  project owner;
- nonempty drafts as content + stable `draftId`;
- recent files, active persisted index, and zoom.

“Don't Save” is authoritative:

- a discarded named file remains path-only, so disk wins on restore;
- a discarded draft is omitted and cannot resurrect.

Files are matched by stable path/draft identity because Vue may expose a proxy
different from the raw confirmation object. On restore, missing clean files are
dropped; missing dirty named files become drafts containing their recoverable
text. Legacy duplicate entries are normalized before reactive persistence
starts, and a changed legacy snapshot is committed immediately.

The Editor must finish hydration before creating its fallback blank draft or
starting the persistence watcher. See `sessionRestore.js`, `sessionPersist.js`,
`windowCloseGuard.js`, and their tests.

## Shutdown durability

Activity worker flush must complete before native exit returns. Full shutdown
sequence is owned by [runtime-architecture.md](runtime-architecture.md).

## Change map

| Change | Read together | Tests |
|---|---|---|
| Atomic persistence primitive | `persistence.rs` and every caller needing special permissions | `persistence.rs` tests, caller recovery tests |
| Settings shape/write | `local_settings.rs`, `dataDir.js`, `stores/settings.js` | Rust settings tests, `settings.test.js`, `settings.tauri.test.js` |
| Session shape/recovery | `session.rs`, `sessionPersist.js`, `sessionRestore.js`, Editor hydration | corresponding Rust/JS tests and close-guard tests |
| Activity persisted record | `activities/model.rs`, `supervisor.rs`, `scrollback.rs` | supervisor restore/quarantine/shutdown tests |
| Routine planner state | `routines.rs`, `routine_runtime.rs` | planner corruption/restart tests |
| Business graph source/revision | `business_graph/markdown.rs`, `store.rs`, `runtime.rs` | golden round-trip, conflict, Trash/restore, watcher, migration-no-write tests |
| Tracker schema/timeline/import | `tracker/store.rs`, `engine.rs`, `report.rs`, `import.rs`, `runtime.rs` | reopen/quarantine, transitions, DST/range, import idempotence/transaction, shutdown tests |
| Model registry migration | embedded `resources/ai-models.json`, `ai_models.rs` | `ai_models.rs`, renderer model-control tests |

See [settings.md](settings.md), [runtime-architecture.md](runtime-architecture.md),
and [gotchas.md](gotchas.md).
