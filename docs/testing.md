# Testing and verification

## Standard checks

```bash
bun run test
bun run build
bun run docs:check
bun run check:commands
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Use Bun wrappers rather than invoking Vitest or Vite directly. Native tests
normally live beside their Rust authority. Renderer tests normally sit beside
the service, store, component, or composable.

## Important limits

- Renderer tests use happy-dom and mocked Tauri modules. They do not prove Rust,
  native windows, PTYs, dialogs, Keychain, Trash, capture, or GPU geometry.
- The default invoke mock returns `undefined`; tests that consume native data
  must provide a representative result.
- `src/test/setup.js` and Rust `generate_handler!` are separate command-name
  seams; `bun run check:commands` checks them.
- Golden IPC fixtures under `src-tauri/tests/fixtures/ipc/` pin important Rust
  response shapes used by renderer tests. Regenerate an intentional change with:

```bash
UPDATE_IPC_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_fixtures
```

- Component tests cannot prove macOS permissions, signed identity, real audio,
  GitHub login, two-machine sync, or installed update behavior.

## Change routing

| Change | Minimum focused evidence |
|---|---|
| Workbench or Editor UI | nearest component/composable/store tests plus production build |
| Activity or terminal lifecycle | renderer Activity tests, native supervisor/launcher tests, live PTY smoke |
| Command or tool contract | native registry/runtime tests, service tests, command check, CLI smoke |
| Files or Git | native index/workspace/Git tests and Files/Editor tests |
| Graph | native graph/managed-Git tests, fixtures, and affected app tests |
| Tracker | native engine/store/report tests and affected app/settings tests |
| Routines or Apps | native owner tests and affected service/store/host tests |
| AI | native model/provider/transport tests and affected renderer AI tests |
| Scribe | `bun run check:meetings`, native meeting/audio/detection tests, and affected app tests |
| Release/signing/dependencies | release script tests, advisory/SBOM checks, and clean-tree package build |

Managed Git needs temporary bare-remote tests for setup, batching, exclusion,
merge, and recovery. Before release it also needs a signed-build smoke with a
real GitHub CLI login, organization repository, offline edits, and two machines.

Scribe release evidence must use the signed installed app for permission,
dual-channel capture, provider routes, forced-restart recovery, retention, and
deletion. Portable tests and fake audio cannot satisfy these claims. Exact
release commands are in [building.md](building.md).
