# Testing and verification

This document maps changes to verification layers and records where the test
environment differs materially from the desktop runtime.

## Frontend harness

`bun run test` runs `scripts/test.mjs`, which invokes Vitest with
`--no-experimental-webstorage`. Use the wrapper: calling Vitest directly can
exercise a different Node environment.

`vitest.config.js` uses happy-dom and `src/test/setup.js`. Before every test the
setup installs a fresh active Pinia and replaces Tauri core/event/window/dialog
modules with mocks.

Important limitations:

- no Rust command executes;
- no real Tauri event loop, window lifecycle, native dialog, keychain, PTY, or
  operating-system Trash exists;
- CodeMirror/xterm geometry and browser selection behavior are approximate;
- the default `invoke` mock returns `undefined`, so success paths requiring
  native data must install an explicit result;
- the command allowlist catches unknown names but must be kept synchronized
  manually with `src-tauri/src/lib.rs::generate_handler!`;
- global event mocks resolve listener installation immediately unless a test
  overrides them, so async mount/unmount races require explicit deferred mocks.

`bun run test:coverage` enforces the global floor in `vitest.config.js`
(lines 65 / statements 62 / functions 57 / branches 53).

## Rust tests

Native tests live beside their authority modules under `#[cfg(test)]`. Prefer
testing the non-command helper with an injected temporary directory/sink over
constructing a Tauri application.

| Native concern | Canonical tests |
|---|---|
| Activity transitions, persistence, PTY shutdown/replay | `activities/model.rs`, `scrollback.rs`, `status.rs`, `supervisor.rs` |
| Launcher validation/detection/injection | `launchers.rs` |
| Tool schemas, aliases, cancellation/providers/MCP | `tool_registry.rs`, `tool_bridge.rs`, `tool_runtime.rs`, `tool_server.rs` |
| Workspace indexing/mutations | `file_index.rs`, `workspace_files.rs`, `file_index_commands.rs` |
| App manifests/protocol/mutations | `apps.rs` |
| Business graph parsing/index/scopes/mutations/context/migration | `business_graph/markdown.rs`, `store.rs`, `runtime.rs`, `context.rs`, `migration.rs`, `tools.rs` |
| Routine schema/planner/runtime | `routines.rs`, `routine_runtime.rs` |
| Persistence/recovery | `persistence.rs`, `session.rs`, `local_settings.rs`, `ai_models.rs` |

Rust command wrappers that only unwrap Tauri state can remain thin; the owning
helper/runtime must carry the behavior test.

## Verification layers

| Layer | Command | Proves | Does not prove |
|---|---|---|---|
| Renderer unit/component | `bun run test` | JS/Vue state, DOM contracts, mocked IPC | desktop integration or Rust |
| Renderer production build | `bun run build` | module graph, Vue/Tailwind/Rollup output | native behavior |
| Documentation integrity | `bun run docs:check` | local links/paths, `_MAP` coverage, version agreement | semantic accuracy |
| Rust format | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | formatting only | compilation |
| Rust unit/integration | `cargo test --manifest-path src-tauri/Cargo.toml` | native helpers/runtimes | real packaged webview |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | Linux-compilable command graph | macOS-only execution |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | lint-clean Rust | runtime behavior |
| Desktop runtime | `bun tauri dev` | actual IPC, PTY, window, keychain, dialogs | packaged bundle |
| Signing inputs | `bun run check:signing` | local `.env` completeness, aliases, permissions, Apple keychain identity | remote signing services |
| Release package | `bun tauri build` | macOS signed/notarized DMG | behavior on another machine |

`.github/workflows/build.yml` runs frontend test/build and Rust
format/test/check/clippy on Ubuntu. Its manual packaging job produces the
signed, notarized macOS arm64 DMG. Linux packaging remains present but
explicitly parked. Keep [building.md](building.md) aligned with the workflow
and signing launcher.

## Change-to-test routing

| Change | Minimum focused verification |
|---|---|
| Workbench pane/focus/shortcuts | shell/sidebar/workbench component test, responsive/key router test, desktop narrow/wide smoke |
| Activity lifecycle or resume | activity store/service tests plus native supervisor/launcher tests; live PTY smoke |
| Editor tab/session/close | relevant composable/store test plus session/close tests; dirty Quit smoke |
| External edit synchronization | external-file-sync and file-store race tests; desktop CLI edit of one clean and one dirty open file |
| CodeMirror extension | extension unit test and EditorSurface integration; real focus/selection smoke |
| MCP definition/alias | Rust runtime/registry/server tests and `services/toolRuntime.test.js`; `mimir tools/call` smoke |
| App manifest/SDK/provider | `apps.rs`, app catalog service/store, embedded host tests; local app smoke |
| Business graph source/tool/projection | native graph modules and golden fixtures; graph service/store/app/projection/CLI tests; desktop board/inspector smoke |
| Routine planner/mutation | `routines.rs`, `routine_runtime.rs`, store/service/activity tests |
| File index/mutation | native index/workspace tests and workspace store/Files Activity tests |
| Settings/persistence | native persistence/settings test and renderer store test, including cross-window mock |
| AI model/provider transport | Rust model/provider/usage tests and renderer model/transport/InlineAI tests |

## Test seams that encode architecture

- `src/test/setup.js` command names are a second registration seam. Update it
  whenever `generate_handler!` changes.
- Workbench tests commonly stub heavy Activity surfaces. A passing shell test
  does not prove xterm listener/resize cleanup; use `TerminalActivity.test.js`.
- Terminal component tests cover WebGL initialization failure, context loss,
  teardown, and device-grid snap math. Release smoke still checks the native
  WebGL surface at 100%, 125%, and 150% zoom because happy-dom cannot validate
  GPU rasterization or font sharpness.
- Store tests use a fresh Pinia but module-level singleton counters/listeners
  still need explicit cleanup.
- Async component mounts require an unmounted/disposed guard after each await
  before installing listeners. Tests should resolve deferred promises after
  unmount to cover this.
- Proposal tests must cover native-report failure; UI-only accept/reject is not
  a completed proposal lifecycle.
- Files tests must distinguish index refresh from direct manager mutation.
  They are separate native authorities sharing one workspace.
- Business graph compatibility is fixture-backed. Add representative Markdown
  under `src-tauri/tests/fixtures/business-graph/` for a new ontology or legacy
  shape, then verify parse/serialize/parse identity and the dry-run migration
  report before changing writers.
- `business_graph/performance.rs` uses loose debug budgets to catch accidental
  quadratic work. Treat measurements as regression guards, not production
  benchmark claims.
- `GraphSelect.test.js` encodes the no-native-dropdown contract and keyboard
  behavior shared by Board, inspector, and create flows.

### Golden IPC fixtures

`scripts/check-tauri-commands.mjs` only synchronizes command *names*; response
*shapes* are pinned by golden fixtures under `src-tauri/tests/fixtures/ipc/`
(one `<command>.json` per command). `src-tauri/src/ipc_fixtures.rs` constructs
a representative response from the real Rust types for each fixture'd command,
and its `ipc_fixtures_match_serialization` test fails when serde output stops
matching the committed JSON (or when a stray fixture file has no builder).
After an intentional shape change, regenerate with
`UPDATE_IPC_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_fixtures`
and rerun without the variable to verify.

Renderer tests load the same files through `src/test/ipcFixtures.js`
(`loadIpcFixture(name)`, or `ipcFixture(name, overrides)` for a shallow-merged
variant) instead of hand-writing Rust payload shapes in `invoke`/service
mocks, so a rename on either side fails a test instead of drifting silently.
When adding or reshaping a high-traffic command with a stable struct response,
add a fixture and consume it from the renderer tests; commands returning unit,
streams, or trivial scalars do not need one.

## Release behavior

`docs/acceptance.md` is the runtime behavior contract covering native focus,
file association, process lifetime, Trash, keychain, and macOS titlebar.
