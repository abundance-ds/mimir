# Building Mimir

Mimir 0.1.0 uses Bun for the JavaScript workspace and Cargo for Rust.

## Prerequisites

- Bun 1.3.14
- Node.js 22 for the build, test, and release wrappers
- stable Rust with `rustfmt`
- platform dependencies for Tauri v2

Ubuntu CI installs:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf
```

## Development

Install from the lockfile:

```bash
bun install --frozen-lockfile
```

Run the desktop app:

```bash
bun tauri dev
```

Vite binds strictly to `127.0.0.1:1420`. If startup reports that the port is in
use, inspect the process before stopping it:

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
```

`bun run dev` starts only the browser frontend. Native PTYs, dialogs, the file
index, Apps, Routines, key storage, and the MCP endpoint require Tauri.

## Verification

Run the CI checks:

```bash
bun run test
bun run build
bun run docs:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The frontend wrappers in `scripts/test.mjs` and `scripts/build.mjs` set the Node
flags required by the current dependency graph. Run the package scripts through
Bun rather than calling Vitest or Vite directly for release verification.

See [testing.md](testing.md) for test-environment limitations and
change-to-test routing.

## Packaging

On macOS, check that the local Apple release credentials are complete without
printing them:

```bash
bun run check:signing
```

Build the platform-native release bundle:

```bash
bun tauri build
```

The `tauri` package script is a credential-safe launcher around the checked-in
Tauri CLI. The active release platform is:

- **macOS arm64**: Tauri imports `APPLE_CERTIFICATE` and applies the Developer ID
  signature. The launcher then submits the final artifact through Apple's
  native `notarytool`, waits for acceptance, and staples and validates the
  distributable artifact.

On macOS the launcher loads the gitignored repository `.env`. Do not run
`source .env`; use the Bun launcher so the base64 certificate and passwords are
parsed without shell interpolation. `.env` must stay ignored and owner-only
(`0600`). `.env.example` records names only.

The local `.env` contains both Tauri's canonical Apple variables and the legacy
`CSC_*`/`APPLE_APP_SPECIFIC_PASSWORD` aliases from the original
electron-builder credential bundle. `scripts/release-env.mjs` understands both,
but new Apple setup should use:

| Platform | Build inputs |
|---|---|
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |

The GitHub workflow verifies frontend and Rust on Linux. A manual dispatch
builds the Developer ID-signed and Apple-notarized arm64 DMG. GitHub Actions
reads Apple variables from repository secrets; it never receives the local
`.env` file.

Verify final artifacts on their native platform:

```bash
# macOS
codesign --verify --deep --strict --verbose=2 Mimir.app
spctl --assess --type execute --verbose=2 Mimir.app
xcrun stapler validate Mimir.app

```

A local macOS build produces **Mimir.app** and a versioned disk image under
Tauri's release bundle output.

### Parked Windows release

Windows is not an active build or release platform. The launcher deliberately
rejects Windows release builds, the GitHub workflow has no Windows job, and no
Azure credentials are stored in GitHub Actions.

The previous Azure Artifact Signing values remain only in the local `.env`, and
the credential-safe `windowsSigningConfig()` recipe plus its focused test remain
in `scripts/release-env.mjs`. This keeps restoration small without presenting
Windows as supported. To restore it later:

1. Re-enable the `windowsSigningConfig(env)` injection in `scripts/tauri.mjs`.
2. Add a Windows packaging job that installs `artifact-signing-cli`.
3. Restore the seven `AZURE_*` Actions secrets from the local `.env`.

`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, and `AZURE_LOCATION` are
retained Azure administration context, not release inputs.

### Parked Linux release

Linux compiles and runs its tests in CI, but no Linux package is currently
published. The complete AppImage and Debian packaging job remains disabled in
`.github/workflows/build.yml`; change its `if` condition back to
`github.event_name == 'workflow_dispatch'` to restore it.

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
