# Building

## Commands

Install:

```bash
bun install
```

Frontend build:

```bash
bun run build
```

Tauri dev:

```bash
bun run tauri dev
```

Rust checks:

```bash
cd src-tauri
cargo check
cargo check --release
```

Equivalent one-liner from repo root:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## Sidecar Binaries

`src-tauri/binaries/` is gitignored. Two sidecars must be placed there for full functionality:

| Binary | Source | Purpose |
|---|---|---|
| `typst-aarch64-apple-darwin` | `brew install typst` then `cp $(which typst) src-tauri/binaries/typst-aarch64-apple-darwin` | PDF export |
| `docx-worker-aarch64-apple-darwin` | Built from `spike/docx-worker/` (.NET 8 self-contained) | DOCX annotation |

Replace `aarch64-apple-darwin` with the appropriate target triple for your platform. PDF export falls back to system PATH if the sidecar is missing; DOCX annotation requires the binary.

## AI Dev Environment

In debug builds, Rust reads API keys in this order: OS keychain, process env, repo `.env`, then `~/.mim/keys.env`.

If this repo has `ANTHROPIC_API_KEY` in `.env`, this is enough:

```bash
bun run tauri dev
```

Persistent debug fallback:

```bash
mkdir -p ~/.mim
cp .env ~/.mim/keys.env
```

Production builds do not use plaintext `~/.mim/keys.env` fallback.

## Dev Server Port

Tauri expects Vite at:

```txt
http://127.0.0.1:1420
```

This is configured in `src-tauri/tauri.conf.json`.

Vite uses `strictPort: true` because Tauri has a fixed `devUrl`. If `1420` is already occupied, dev startup must fail instead of silently moving to another port. Check and stop stale processes before debugging phantom UI behavior:

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
pkill -f "vite --host 127.0.0.1"
```

## Known Warnings

`bun run build` currently emits a Vite chunk-size warning. This is expected for the current prototype bundle; AI SDK/provider packages are now part of that bundle.

## Testing

Config: `vitest.config.js` (happy-dom environment, Vue plugin, `setupFiles`).

Setup: `src/test/setup.js` — creates a fresh Pinia instance per test and mocks the Tauri boundary APIs (invoke, events, dialog, shell, window).

Smoke tests: `src/test/smoke.test.js` — `shallowMount` of key components to catch import/render errors.

Run:

```bash
bun run test
```

**Conventions:**
- Test files are co-located: `foo.js` is tested by `foo.test.js` in the same directory.
- Tests use real Pinia stores; only the Tauri boundary and `@ai-sdk/vue` are mocked.
- No snapshot tests.

## Manual Smoke Tests

Basic routes in browser mode:

```bash
bun run dev
open http://127.0.0.1:1420/
open 'http://127.0.0.1:1420/?view=agents'
open 'http://127.0.0.1:1420/?new=1&window=editor-smoke'
```

Native-only behavior that must be checked with `bun run tauri dev`:

- `Agents Panel` opens a separate native window.
- Closing the agents window updates the editor button state.
- `New Editor` from the agents window opens a separate unsaved editor window.
- Panel chat streams with a configured provider key.
- Panel chat tools can read the prototype document and create proposals without mutating text.
- Tauri permissions for this live in `src-tauri/capabilities/default.json`.

## Build Profiles

A build profile determines which skills and apps are bundled into the installer. Profiles live in `profiles/` as JSON files.

### Format

```json
{
  "name": "mim terminal",
  "skills": [],
  "apps": [],
  "bundleSkills": ["app-builder", "peer-review", "mim"]
}
```

| Field | Purpose |
|---|---|
| `name` | Display name baked into the build |
| `skills` | Profile-specific skills from `profiles/skills/` (copied into the bundle) |
| `apps` | Profile-specific apps from `profiles/apps/` (copied into the bundle) |
| `bundleSkills` | IDs of built-in skills from `src/services/skills/bundled.js` to seed on first launch |

### Creating a profile

1. Copy `profiles/default.json` to `profiles/your-name.json`.
2. Add skill folders to `profiles/skills/` and app folders to `profiles/apps/` as needed.
3. Reference them by name in `skills` and `apps` arrays.

### `prepare-profile.sh`

`scripts/prepare-profile.sh` stages a profile's resources into `src-tauri/resources/` for Tauri to bundle:

```bash
bash scripts/prepare-profile.sh default
```

This:
1. Cleans `src-tauri/resources/{bundled-skills/, bundled-apps/, profile.json}`.
2. Copies the profile JSON to `src-tauri/resources/profile.json`.
3. Copies each skill from `profiles/skills/` to `src-tauri/resources/bundled-skills/`.
4. Copies each app from `profiles/apps/` to `src-tauri/resources/bundled-apps/`.

The staged resources are gitignored (see gotchas). They must exist before `tauri build` but are not committed.

## Local Builds

Full local release build:

```bash
bash scripts/prepare-profile.sh default
bun run tauri build
```

The output is in `src-tauri/target/release/bundle/` (`.dmg` on macOS, `.msi`/`.nsis` on Windows).

## CI Builds

Builds are triggered via GitHub Actions `workflow_dispatch` on `.github/workflows/build.yml`.

**Inputs:**

- `profile` (string, default: `"default"`) — the profile name from `profiles/`.

**Matrix:**

| Platform | Runner | Target |
|---|---|---|
| macOS ARM | `macos-14` | `aarch64-apple-darwin` |
| Windows | `windows-latest` | `x86_64-pc-windows-msvc` |
| Linux | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |

**Linux build dependencies:**

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

**Linux sidecar handling:**

Linux sidecars are built/downloaded in CI (same approach as Windows):
- `docx-worker-x86_64-unknown-linux-gnu` — `dotnet publish` from `sidecar/docx-worker/DocxWorker/DocxWorker.csproj` (requires .NET 8 SDK)
- `typst-x86_64-unknown-linux-gnu` — downloaded from the public Typst GitHub releases

**Flow:**

1. `create-release` — reads version from `package.json`, creates a draft GitHub Release.
2. `build` — runs per platform: checkout (with LFS), install deps, prepare profile, import signing certs, run `tauri-action` with `includeUpdaterJson: true`.
3. `publish` — marks the draft release as published after both platform builds succeed.

## Sidecar Handling

### macOS

macOS sidecar binaries are pre-built and committed to `src-tauri/binaries/` via Git LFS (`.gitattributes` tracks `src-tauri/binaries/*`):

- `docx-worker-aarch64-apple-darwin` — built from `sidecar/docx-worker/` (.NET 8 self-contained)
- `typst-aarch64-apple-darwin` — from `brew install typst`

### Windows

Windows sidecars are built/downloaded in CI:

- `docx-worker-x86_64-pc-windows-msvc.exe` — `dotnet publish` from `sidecar/docx-worker/DocxWorker/DocxWorker.csproj`
- `typst-x86_64-pc-windows-msvc.exe` — downloaded from the public Typst GitHub releases

### Sidecar source

The docx-worker .NET project lives at `sidecar/docx-worker/` (moved from `spike/docx-worker/`).

## Signing Setup

### Apple Developer certificate

CI imports a `.p12` certificate from the `APPLE_CERTIFICATE` secret (base64-encoded) into a temporary keychain. Notarization uses `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`.

### Tauri updater signing

The updater keypair lives at `~/.tauri/mim-terminal.key` (local) and in the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets. This keypair is shared with v0.2.x — do not regenerate it.

The public key is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

### GitHub Secrets required

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` signing certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Identity string for `codesign` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key (minisign format) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key |
| `SERVER_HOST` | EC2 hostname for web portal deploy |
| `SERVER_USER` | SSH user for deploy (`ubuntu`) |
| `SERVER_SSH_KEY` | SSH private key for deploy |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions (for release uploads) |

## Cross-Platform Gotcha: macOS-Only Window APIs

`title_bar_style()`, `hidden_title()`, `traffic_light_position()`, and `RunEvent::Opened` are macOS-only Tauri APIs. Any new window creation code in Rust must guard these with `#[cfg(target_os = "macos")]` or the Windows/Linux builds will fail.

Source: `src-tauri/src/lib.rs`, `src-tauri/src/file_open.rs`, `src-tauri/src/apps.rs`.

## Version Sync

The version string must match in three files:

- `package.json` (`"version"`)
- `src-tauri/tauri.conf.json` (`"version"`)
- `src-tauri/Cargo.toml` (`version`)

Mismatch causes updater confusion — the app may report the wrong version or fail to detect updates.
