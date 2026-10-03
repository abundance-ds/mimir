# Building Mimir

Bun owns JavaScript; Cargo owns Rust. Release packaging targets macOS arm64.

## Prerequisites

- Bun 1.3.14, Node.js 22, stable Rust with rustfmt and clippy
- Tauri v2 platform dependencies
- Git and GitHub CLI (`gh`)
- macOS Scribe: Xcode command-line tools, CMake, libclang

## Development

```bash
bun install --frozen-lockfile
bun tauri dev
```

On macOS arm64, `bun tauri dev` runs the generated app bundle through
`scripts/run-macos-dev-app` to keep the permission identity. Do not use bare
`cargo run`. For an isolated hardware smoke:

```bash
bun run scribe:smoke-app
open src-tauri/target/debug/bundle/macos/Mimir.app
```

`bun run dev` starts only the browser frontend; native features are
unavailable. Vite binds `127.0.0.1:1420` (`strictPort`).

### Connection sign-in clients

Google sign-in needs these ignored `.env` values for development and packaging:

```text
MIMIR_GOOGLE_OAUTH_CLIENT_ID=
MIMIR_GOOGLE_OAUTH_CLIENT_SECRET=
```

The Google client is a Desktop app with the scopes declared in
`connections.rs`. GitHub uses installed `git` and `gh`; it has no build
credential. Slack and Granola credentials are entered at runtime and must not
enter `.env` or CI secrets (`scripts/release-env.mjs` strips personal Slack
tokens from the build environment).

## Verification

Commands are in [testing.md](testing.md). The first clean Scribe build takes
several minutes. The Whisper model installs at runtime under
`~/.mimir/models/stt/`.

## Local signed package

```bash
bun run check:signing
bun tauri build
```

Required local inputs:

| Purpose | Inputs |
|---|---|
| Apple signing/notarization | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Updater signing | `TAURI_SIGNING_PRIVATE_KEY` or `_PATH`, plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

The ignored `.env` must have mode `0600` (`check:signing` enforces it). Do not
source it in a shell. Without `TAURI_SIGNING_PRIVATE_KEY*`, the build reads
`~/.config/mimir/release/updater.key` and the password from the login Keychain
(`com.abundanceds.mimir.updater-signing`). CI uses GitHub secrets.

`bun tauri build` (`scripts/tauri.mjs`) requires a clean commit that stays
unchanged, builds macOS arm64, signs the app and DMG, notarizes the DMG with
`notarytool` (Tauri's own notarization is disabled), staples DMG and app, builds
the updater archive from the stapled app, signs it, and stages the release.

The stage (`src-tauri/target/release-artifacts`) contains exactly:

- versioned arm64 DMG
- versioned `.app.tar.gz` and `.sig`
- `latest.json`
- source-bound manifest
- `SBOM.spdx.json`
- `THIRD_PARTY_LICENSES.md`
- `THIRD_PARTY_NOTICES.md`

## Create a release

Select the SemVer increment from the changes. Ask only if it is ambiguous.

```bash
bun run release:create -- patch
```

Alternatives: `minor`, `major`, `X.Y.Z`. The command requires:

- branch `main`, clean tree, `HEAD` equal to `origin/main`
- public repository `abundance-ds/mimir` and all ten GitHub secrets
- equal versions in `package.json`, `Cargo.toml`, `tauri.conf.json`
- unused tag and GitHub Release

It bumps the three versions and `src-tauri/vendor/license-policy.json`, runs
`cargo metadata` (updates `Cargo.lock`), `bun install --frozen-lockfile`,
`supply-chain:generate`, `check:meetings`, `docs:check`, `check:identity`,
`check:commands`, `test`, `build`, commits `release: prepare vX.Y.Z`, creates
an annotated tag, and runs `git push --atomic origin main <tag>`. It does not
run Rust checks or advisories; the tag workflow (`.github/workflows/build.yml`)
does: Ubuntu `verify`, then macOS arm64 sign/notarize/stage, then one draft
GitHub Release published with `--latest`, then a public feed check.

After the workflow succeeds:

```bash
bun run release:verify
```

Do not report success before this passes. Never move a published tag or replace
published assets; publish a new patch release for a defect.

Manual `workflow_dispatch` runs `verify` and `package-macos` and uploads an
artifact. It does not publish.

## Release smoke

The workflow does not prove runtime behavior. Material releases need a smoke of
the installed signed app: launch/relaunch, file save, one terminal Activity,
permission prompts, affected Scribe/GitHub paths. Record missing evidence in
[issues.md](issues.md).

## Dependencies and licenses

After a lockfile, policy, or embedded-asset change:

```bash
bun run supply-chain:generate
bun run check:meetings
git diff -- src-tauri/vendor
cargo install cargo-audit --version 0.22.2 --locked
bun run check:advisories
```

`src-tauri/vendor/license-policy.json` is the review authority. Committed SBOM,
license, and Scribe notice files ship in the app and release stage.

Linux is verify-only in CI (`package-linux` is disabled with `if: false`).
`scripts/tauri.mjs` refuses Windows release builds. `release:create` owns
version synchronization. Product name is `Mimir`; package and crate name are
`mimir`.
