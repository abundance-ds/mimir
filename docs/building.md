# Building Mimir

Bun for the JavaScript workspace, Cargo for Rust.

## Prerequisites

- Bun 1.3.14
- Node.js 22 for build/test/release wrappers
- stable Rust with `rustfmt`
- platform dependencies for Tauri v2
- macOS Scribe builds: Xcode command-line tools, CMake, and libclang; the
  embedded whisper.cpp build uses Metal

Ubuntu CI deps: see `.github/workflows/build.yml`.

## Development

Install from the lockfile:

```bash
bun install --frozen-lockfile
```

Run the desktop app:

```bash
bun tauri dev
```

Vite binds to `127.0.0.1:1420`. If the port is busy: `lsof -nP -iTCP:1420 -sTCP:LISTEN`.

`bun run dev` starts only the browser frontend. PTYs, dialogs, file index, Apps, Routines, key storage, and MCP require Tauri.

## Verification

Dev-loop essentials:

```bash
bun run test
bun run build
bun run docs:check
bun run check:meetings
```

Full CI-equivalent (add Rust):

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Run package scripts through Bun (`scripts/test.mjs`, `scripts/build.mjs` set required Node flags); do not call Vitest or Vite directly for release verification.

The first clean Scribe build compiles whisper.cpp and can take several minutes.
The multilingual Whisper Small artifact is not stored in Git or bundled in the
app; the verified in-product install downloads about 488 MB into
`~/.mimir/models/stt/`.

See [testing.md](testing.md) for what each command proves, environment limits, and change-to-test routing.

## Packaging

Check macOS signing prerequisites:

```bash
bun run check:signing
```

Build the release bundle:

```bash
bun tauri build
```

- **macOS arm64**: Tauri imports `APPLE_CERTIFICATE`, applies Developer ID signature, submits through `notarytool`, staples and validates.
- The bundle targets macOS 14.2+, includes microphone/system-audio purpose
  strings, and signs with the audio-input entitlement. `bun run
  check:meetings` statically verifies these inputs before packaging.

The `.env` (gitignored, `0600`) holds Apple credentials. Use the Bun launcher (`bun tauri build`), not `source .env` -- avoids shell interpolation of base64 values. `.env.example` records variable names.

| Platform | Required variables |
|---|---|
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |

GitHub Actions reads these from repository secrets; it never receives the local `.env`.

Verify final artifacts:

```bash
# macOS
codesign --verify --deep --strict --verbose=2 Mimir.app
spctl --assess --type execute --verbose=2 Mimir.app
xcrun stapler validate Mimir.app
```

A local macOS build produces **Mimir.app** and a versioned disk image under Tauri's release bundle output.

### Parked Windows release

Not active. Launcher rejects Windows builds; no CI job or Azure credentials in Actions. Restoration recipe: re-enable `windowsSigningConfig(env)` in `scripts/tauri.mjs`, add Windows CI job with `artifact-signing-cli`, restore `AZURE_*` secrets from local `.env`.

### Parked Linux release

CI compiles and tests but publishes no package. Disabled AppImage/Debian job in `.github/workflows/build.yml`; flip its `if` condition to restore.

Keep the version synchronized in:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

The product name is `Mimir`; the package and crate are `mimir`.

## Local runtime files

Launching the desktop app installs `mimir` and its skill module into
`~/.mimir/bin/`, plus the Pi extension under `~/.mimir/pi/`. It creates skill
storage and native projections only as they are used. See
[agent-setup.md](agent-setup.md) and [docs/_MAP.md](_MAP.md#local-data).

API keys saved in Settings use the OS keychain. In debug builds only, key
resolution may also read process environment variables, the repository `.env`,
and `~/.mimir/keys.env`. The fallback file is atomically replaced and owner-only
on Unix; it remains a debug convenience, not release credential storage.
