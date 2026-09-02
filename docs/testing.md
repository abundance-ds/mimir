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
| Managed Team and Project Git | `managed_git.rs`, `git.rs`; use temporary local bare remotes for pull/push/conflict tests |
| Tracker transitions/store/reports/import/lifecycle | `tracker/engine.rs`, `store.rs`, `report.rs`, `import.rs`, `runtime.rs`, `platform.rs` |
| Routine schema/planner/runtime | `routines.rs`, `routine_runtime.rs` |
| Persistence/recovery | `persistence.rs`, `session.rs`, `local_settings.rs`, `ai_models.rs` |
| Scribe lifecycle/store/capture/STT/jobs/tools | `meetings/`; `crates/mimir-meeting-audio`; `crates/mimir-meeting-detect` |

Rust command wrappers that only unwrap Tauri state can remain thin; the owning
helper/runtime must carry the behavior test.

## Verification layers

| Layer | Command | Proves | Does not prove |
|---|---|---|---|
| Renderer unit/component | `bun run test` | JS/Vue state, DOM contracts, mocked IPC | desktop integration or Rust |
| Renderer production build | `bun run build` | module graph, Vue/Tailwind/Rollup output | native behavior |
| Documentation integrity | `bun run docs:check` | local links/paths, `_MAP` coverage, version agreement | semantic accuracy |
| Scribe specification/packaging | `bun run check:meetings` | stable Gherkin contract, evidence manifest, development identity/TCC request wiring, purpose strings, entitlement, deployment target, complete lock/SBOM identity, license policy, release-artifact selection helpers | actual TCC grant, hardware capture, transcript accuracy, or a signed artifact |
| Rust format | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | formatting only | compilation |
| Rust unit/integration | `cargo test --manifest-path src-tauri/Cargo.toml` | native helpers/runtimes | real packaged webview |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | Linux-compilable command graph | macOS-only execution |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | lint-clean Rust | runtime behavior |
| Desktop runtime | `bun tauri dev` | actual IPC, PTY, window, keychain, dialogs; local Mimir bundle and responsible-process identity plus system-audio TCC on macOS arm64 | distribution signature, notarization, release provenance, or behavior on another machine |
| Local Scribe bundle | `bun run scribe:smoke-app` | ad-hoc bundled identity, purpose strings, entitlements, local TCC/audio smoke | distribution signature, notarization, or release provenance |
| Signing inputs | `bun run check:signing` | local `.env` completeness, aliases, permissions, Apple keychain identity | remote signing services |
| Release package | `bun tauri build` | one exact macOS arm64 signed/notarized DMG plus a clean-commit/source-tree manifest and staged SBOM/notices | behavior on another machine |

`.github/workflows/build.yml` runs frontend test/build and Rust
format/test/check/clippy on Ubuntu. Its manual packaging job produces the
signed, notarized macOS arm64 DMG. Linux packaging remains present but
explicitly parked. Keep [building.md](building.md) aligned with the workflow
and signing launcher.

CI triggers only on pull requests and manual `workflow_dispatch` — the push
trigger was removed deliberately (August 2026) to stop paying for a run on
every push to main; do not re-add it without an explicit decision to accept
the cost. The push-era failures were one CI-only flake: a component left
mounted under real timers fired its pending debounce inside a later
fake-timer test (`QuickOpen.test.js`). Test files that mount debouncing
components call `enableAutoUnmount(afterEach)` to prevent this.

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
| Managed Git setup, batching, or conflict policy | native `managed_git.rs` tests with temporary and two-clone bare remotes; invalid-root, non-empty-remote, and resource-limit tests; managed repository service/Settings/Files tests; signed-build system Git, GitHub CLI login, personal/organization repository URL setup, and private-repository smoke before release |
| Tracker collection/report/migration | native tracker modules and golden IPC fixtures; tracker service/store/app/settings/component tests; desktop permission/tray/sleep/import smoke |
| Routine planner/mutation | `routines.rs`, `routine_runtime.rs`, store/service/activity tests |
| File index/mutation | native index/workspace tests and workspace store/Files Activity tests |
| Settings/persistence | native persistence/settings test and renderer store test, including cross-window mock |
| AI model/provider transport | Rust model/provider/usage tests and renderer model/transport/InlineAI tests |
| Scribe domain/IPC/UI | `bun run check:meetings`; native meeting/audio/detection tests; meeting service/store/Scribe app tests; packaged hardware smoke |
| Scribe lifecycle/recovery/finalization | meeting runtime/store tests for ended-worker Stop ordering, staged-tail promotion, failure-intent restart, audio-derived stop time, terminal redelivery, atomic summary outbox, and retry generations |
| Scribe repair retention/deletion | meeting store/platform/runtime tests for collecting-repair holds, explicit and retention deletion, and missing-source retry refusal |
| Dependency, license, signing, or artifact selection | `bun run check:meetings`; `node --test scripts/supply-chain.test.mjs scripts/release-artifacts.test.mjs`; inspect generated vendor diff; clean-tree `bun tauri build` |

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
- Tracker report and query tests use exact milliseconds and explicit IANA
  timezones. Cover clipping and DST instead of asserting sample counts.
- Tracker desktop smoke begins disabled. Confirm no menu-bar item, TCC prompt,
  notification, AI call, or new interval before exercising opt-in.
- `GraphSelect.test.js` encodes the no-native-dropdown contract and keyboard
  behavior shared by Board, inspector, and create flows.
- `features/meetings/*.feature` is the Scribe behavior authority. Every
  scenario has one stable `MTG-*` id and one evidence class. The manifest maps
  automated selectors and keeps packaged/hardware/manual claims separate; a
  happy-dom or fake-audio pass cannot satisfy a TCC, device-route, soak, or
  signing claim.

### Scribe focused gates

Run the portable automated layer:

```bash
bun run check:meetings
bun run test -- src/services/meetings.test.js src/stores/meetings.test.js src/mimir/apps/ScribeApp.test.js
cargo test --manifest-path src-tauri/Cargo.toml meetings::
cargo test --manifest-path src-tauri/crates/mimir-meeting-audio/Cargo.toml
cargo test --manifest-path src-tauri/crates/mimir-meeting-detect/Cargo.toml
```

Release verification also scans both lockfiles against current advisory
databases:

```bash
cargo install cargo-audit --version 0.22.2 --locked
bun run check:advisories
```

The audit fails on RustSec vulnerabilities or Bun production advisories.
RustSec informational warnings remain visible for review; parked-platform
bindings and unmaintained transitive APIs are not silently reclassified as
vulnerabilities.

For crash-boundary changes, run the full `meetings::runtime::tests` and
`meetings::store::tests` groups rather than filtering to one happy path.
Lifecycle recovery, transcript repair, default-hook outbox, retention holds,
and deletion intentionally share invariants across those two authorities.

The focused checker fails closed when a Cargo/Bun lock identity is absent from
the committed SPDX file, a generated inventory is stale, a third-party license
is unknown or has no permitted policy choice, or release selection could fall
back to an arbitrary DMG. These are static and deterministic claims. They do
not replace the manual review of license obligations or prove that an artifact
was built, signed, notarized, or run.

Before a release, the evidence manifest must also point to current macOS arm64
results for: clean-install microphone and system-audio prompts, denial and
repair, real dual-channel call, route/device change, sleep/wake, forced kill
and relaunch, local-model install and inference, custom WSS interoperability,
Stop through title/summary and KG proposal, eight-hour capture, 24-hour
detection, and the signed/notarized DMG. Manual evidence records the exact app
version, commit, OS, hardware/routes, model/provider identity, result, and
timestamp.

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

Scribe pins its bounded public projections with fixtures for
`meetings_snapshot`, `meetings_library_page`, `meetings_transcript_page`,
`meetings_issue_start_consent`, `meetings_start`, and `meetings_export`.
`src/services/meetings.ipc-contract.test.js` consumes all six and asserts the
renderer normalization plus consent, pagination, start, and export call
contracts.

## Release behavior

`docs/acceptance.md` is the runtime behavior contract covering native focus,
file association, process lifetime, Trash, keychain, and macOS titlebar.
