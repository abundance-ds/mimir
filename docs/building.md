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

On macOS arm64, this command launches the debug executable from
`src-tauri/target/debug/bundle/macos/Mimir.app`. The launcher refreshes the
bundle after each Rust build, reuses the normal development build cache, and
preserves Vite hot reload. It uses `APPLE_SIGNING_IDENTITY` from `.env` when
available. Before Tauri creates threads, the debug executable performs a
same-PID re-exec that disclaims the launching terminal as the responsible
process. Together, the signed bundle and this handoff make macOS attribute
microphone and system-audio permission to Mimir. If the handoff fails, Scribe
reports a development-host identity instead of treating the bundle ID as
proof. Without `APPLE_SIGNING_IDENTITY`, the launcher uses an ad-hoc signature
and warns that the app does not use Mimir's normal development permission
identity. macOS can bind a development audio grant to the current binary code
hash, so a Rust rebuild can require one new permission click even with the
Developer ID signature.

Do not bypass this launcher with a bare `cargo run` for Scribe audio checks.
Build a separate ad-hoc `.app` for an isolated local hardware smoke test:

```bash
bun run scribe:smoke-app
open src-tauri/target/debug/bundle/macos/Mimir.app
```

Both development paths are test-only. They do not produce or claim a release
artifact.

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

Rust development and test profiles keep line-table debugging but disable
incremental compilation. Scribe's native audio and Whisper graph otherwise
accumulates several gigabytes of never-pruned incremental state. Cargo still
does not garbage-collect its native build-output directory; `cargo clean
--manifest-path src-tauri/Cargo.toml` removes only regenerable output when disk space is
more important than the next build's warm cache.

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
- A signed build must start and finish on the same clean Git commit. The
  wrapper removes only that version's exact expected DMG before Tauri runs,
  notarizes that exact path, and refuses macOS architectures other than arm64.
  It never selects the newest file from a bundle directory.

The `.env` (gitignored, `0600`) holds Apple credentials. Use the Bun launcher (`bun tauri build`), not `source .env` -- avoids shell interpolation of base64 values. `.env.example` records variable names.

| Platform | Required variables |
|---|---|
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |

GitHub Actions reads these from repository secrets; it never receives the local `.env`.

### Dependency inventory and license policy

The complete locked Cargo and Bun component inventory is committed as
`src-tauri/vendor/SBOM.spdx.json` (SPDX 2.3) and the release-readable
`src-tauri/vendor/THIRD_PARTY_LICENSES.md`. Both files, plus the full-text
Scribe asset notices, are bundled into the app and staged beside the release
DMG.

`src-tauri/vendor/license-policy.json` is the review authority. Every
third-party lock identity needs a declared license expression with at least one
permitted choice. Unknown license identifiers and expressions with only denied
choices fail `bun run check:meetings`. Metadata omissions require a narrow,
component-version-specific override with public evidence and a reason; adding
a broad default is not allowed.

After changing `Cargo.lock`, `bun.lock`, the policy, or a reviewed embedded
asset:

```bash
bun run supply-chain:generate
bun run check:meetings
git diff -- src-tauri/vendor
```

Generation reads Cargo metadata and the public npm registry. The release gate
itself is offline and verifies exact lock identities, the lock/policy digest,
the human-readable inventory, model/vendor pins, packaged resources, and the
license policy. Review the generated diff before committing; generated files
are never an excuse to skip license review.

The deterministic inventory is complemented by a current advisory scan:

```bash
cargo install cargo-audit --version 0.22.2 --locked
bun run check:advisories
```

CI runs this before any test or package job. It fails on RustSec
vulnerabilities and Bun production advisories; the advisory database result
is time-sensitive evidence and is not embedded into the reproducible SBOM.

Verify final artifacts:

```bash
# macOS
codesign --verify --deep --strict --verbose=2 Mimir.app
spctl --assess --type execute --verbose=2 Mimir.app
xcrun stapler validate Mimir.app
```

A successful macOS release stages exactly five files in a clean
`release-artifacts` directory under Tauri's target directory: the notarized
versioned DMG, its source-bound manifest, SPDX SBOM, license inventory, and
third-party notices.
The manifest records the immutable Git commit and tree, target, exact release
materials, byte sizes, and SHA-256 digests without local absolute paths.
GitHub Actions uploads this directory as one artifact instead of using a DMG
glob. Before publishing, compare the staged DMG digest with the manifest and
record the manifest, signing, Gatekeeper, stapler, and functional smoke results
in the release evidence.

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
