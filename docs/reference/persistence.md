# Persistence and recovery

This document records write ownership, ordering, and recovery behavior. The
paths alone are listed in [_MAP.md](_MAP.md); the important distinction here is
which state is authoritative, which writes are serialized, and what survives a
crash.

## Persistence inventory

| Artifact | Writer/loader | Non-obvious behavior |
|---|---|---|
| `~/.mim/settings.json` | `local_settings.rs`, `stores/settings.js` | one top-level object; renderer settings live under `editor`; partial editor save preserves other top-level namespaces |
| `~/.mim/session.json` | `session.rs`, `sessionPersist.js` | contains recovery content only for dirty named files and nonempty drafts |
| `~/.mim/models.json` | `ai_models.rs` | embedded product defaults replace known model/provider metadata on version migration; unknown user models survive |
| `~/.mim/launchers.json` | `launchers.rs` | versioned whole-file config; malformed/unsupported input recovers to defaults with diagnostics |
| `~/.mim/activities/*.activity.json` | Activity persistence worker | only durable records; scrollback chunks and sequence state share the same snapshot |
| `~/.mim/routines/*.toml` | user, Routine UI/MCP | source files are the database; mutation is revision-guarded |
| `~/.mim/routines-state.json` | `routine_runtime.rs` | planner cursor only; definitions remain TOML authority |
| `~/.mim/apps/*.toml`, `*/app.toml` | user, Apps UI/MCP | source definitions are authoritative; catalog diagnostics do not hide healthy definitions |
| `~/.mim/app-data/<app-id>/<key>.json` | app SDK through `apps.rs` | namespaced by validated app id/key; value bytes are opaque to Rust |
| private/project/team `knowledge/*.md`, `issues/*.md` | user, GraphRuntime UI/tools | Markdown is canonical; every node retains physical scope/path/revision; the in-memory GraphStore is disposable |
| `~/.mim/keys.env` | `ai_keys.rs`, debug only | owner-only atomic plaintext fallback when keychain storage fails |

API keys in release builds are not file persistence: the OS keychain service
is `com.mim.terminal`, keyed by the provider environment-variable name.

## Atomic writer

`src-tauri/src/persistence.rs` is the shared replacement primitive:

1. validate the destination has a filename;
2. serialize before touching the destination;
3. create a unique temporary sibling;
4. write, flush, and `sync_all` the temporary file;
5. preserve existing permissions for ordinary replacement;
6. close before rename for Windows compatibility;
7. atomically rename on the same filesystem;
8. sync the parent directory where supported.

Document writes use the same byte writer, so an existing file's permissions
survive replacement and a read-only destination is rejected. Secret fallback
writes apply owner-only permissions before secret bytes enter the temporary
file.

Do not replace this with a temporary directory or generic `fs::write`; both
lose guarantees relied on by session recovery and runtime state.

## Corrupt-state quarantine

JSON loaders using `load_json_optional_quarantining` distinguish missing,
valid, and malformed state. Malformed bytes are renamed untouched to a unique
`.corrupt-*` sibling before defaults or a clean replacement are written.
Filesystem errors still fail the operation.

Quarantine currently applies to settings, session, model registry, launchers,
Activity snapshots, and Routine planner state. User-authored App/Routine TOML
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

- `src/stores/settings.js` captures complete immutable snapshots and chains
  saves; `flush()` includes a pending debounce and every earlier queued save.
- `src-tauri/src/local_settings.rs` serializes settings load/read-modify-write
  operations with `SETTINGS_IO`, preserving non-editor top-level namespaces.
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

Do not bypass these queues with a direct invoke or assignment.

## Editor recovery semantics

`createSessionSnapshot` stores:

- clean named files as path only;
- dirty named files as path + recovery content + `dirty: true`;
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

Application Quit is renderer-authorized so dirty-document decisions can affect
the final session. The order is:

```text
flush CodeMirror
  -> confirm dirty files
  -> flush final session snapshot
  -> flush settings snapshot
  -> confirm native exit
  -> interrupt Activities and persist final exit/scrollback
  -> flush Activity worker
```

Workbench unmount also snapshots layout and settings for HMR/window teardown,
but it is not a substitute for the guarded Quit path.

## Change map

| Change | Read together | Tests |
|---|---|---|
| Atomic persistence primitive | `persistence.rs` and every caller needing special permissions | `persistence.rs` tests, caller recovery tests |
| Settings shape/write | `local_settings.rs`, `dataDir.js`, `stores/settings.js` | Rust settings tests, `settings.test.js`, `settings.tauri.test.js` |
| Session shape/recovery | `session.rs`, `sessionPersist.js`, `sessionRestore.js`, Editor hydration | corresponding Rust/JS tests and close-guard tests |
| Activity persisted record | `activities/model.rs`, `supervisor.rs`, `scrollback.rs` | supervisor restore/quarantine/shutdown tests |
| Routine planner state | `routines.rs`, `routine_runtime.rs` | planner corruption/restart tests |
| Business graph source/revision | `business_graph/markdown.rs`, `store.rs`, `runtime.rs` | golden round-trip, conflict, Trash/restore, watcher, migration-no-write tests |
| Model registry migration | embedded `resources/ai-models.json`, `ai_models.rs` | `ai_models.rs`, renderer model-control tests |

See [settings.md](settings.md), [runtime-architecture.md](runtime-architecture.md),
and [gotchas.md](gotchas.md).
