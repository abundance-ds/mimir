# Building Mim

Mim 0.1.0 is the `mim-workbench` npm and Cargo package.

## Prerequisites

- Node.js 22 and npm
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
npm ci
```

Run the desktop app:

```bash
npm run tauri -- dev
```

Vite binds strictly to `127.0.0.1:1420`. If startup reports that the port is in
use, inspect the process before stopping it:

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
```

`npm run dev` starts only the browser frontend. Native PTYs, dialogs, the file
index, Apps, Routines, key storage, and the MCP endpoint require Tauri.

## Verification

Run the CI checks:

```bash
npm test
npm run build
npm run docs:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

The frontend wrappers in `scripts/test.mjs` and `scripts/build.mjs` set the Node
flags required by the current dependency graph. Use the npm scripts rather than
calling Vitest or Vite directly for release verification.

Clippy is an additional local check; it is not currently run by CI:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

See [testing.md](testing.md) for test-environment limitations and
change-to-test routing.

## Packaging

Build the platform-native bundle:

```bash
npm run tauri -- build
```

The GitHub workflow verifies frontend and Rust on Linux. Its manual packaging
job builds an Apple Silicon DMG on macOS. A local macOS build produces
`src-tauri/target/release/bundle/macos/Mim.app` and a versioned image under
`src-tauri/target/release/bundle/dmg/`.

Keep the version synchronized in:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

The product name is `Mim`; the package and crate are `mim-workbench`.

## Local runtime files

Launching the desktop app installs `mimx` into `~/.mim/bin/` and the Pi
extension into `~/.mim/pi/`. It also creates runtime directories as their
systems are used. See [agent-setup.md](agent-setup.md) and
[docs/_MAP.md](_MAP.md#local-data).

API keys saved in Settings use the OS keychain. In debug builds only, key
resolution may also read process environment variables, the repository `.env`,
and `~/.mim/keys.env`. The fallback file is atomically replaced and owner-only
on Unix; it remains a debug convenience, not release credential storage.
