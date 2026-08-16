# Building Mimir

Bun owns the JavaScript workspace. Cargo owns the Rust workspace.

## Prerequisites

- Bun 1.3.14
- Node.js 22 for build, test, and release scripts
- stable Rust with `rustfmt`
- platform dependencies for Tauri v2
- macOS Scribe builds: Xcode command-line tools, CMake, and libclang

The embedded whisper.cpp build uses Metal on macOS arm64. Ubuntu CI
dependencies are in `.github/workflows/build.yml`.

## Development

Install the locked dependencies:

```bash
bun install --frozen-lockfile
```

Run the desktop app:

```bash
bun tauri dev
```

On macOS arm64, this command launches
`src-tauri/target/debug/bundle/macos/Mimir.app`. The launcher refreshes the
bundle after each Rust build and keeps Vite hot reload.

The launcher uses `APPLE_SIGNING_IDENTITY` from `.env` when it is
available. It uses an ad-hoc signature when the identity is absent. A Rust
rebuild can require one new macOS audio permission click because macOS can bind
a development grant to the binary code hash.

Do not use a bare `cargo run` for Scribe audio checks. Use this isolated
hardware smoke app when required:

```bash
bun run scribe:smoke-app
open src-tauri/target/debug/bundle/macos/Mimir.app
```

Development builds are not release artifacts.

### Connection sign-in clients

Google sign-in uses desktop OAuth with PKCE and a loopback callback. Set these
values in the ignored `.env` file before development or packaging:

```text
MIMIR_GOOGLE_OAUTH_CLIENT_ID=
MIMIR_GOOGLE_OAUTH_CLIENT_SECRET=
```

The Google client must be a Desktop app client with Gmail, Calendar, Drive,
Sheets, Slides, and OpenID services enabled. Its consent configuration must
allow the scopes declared in `src-tauri/src/connections.rs`. Release packaging
requires both values. They identify the Mimir app; end users never enter them.

Slack uses a per-user `xoxp-` personal token entered in Settings after
installation. Mimir verifies it and stores it in the OS keychain. A Slack token
must never be in `.env`, GitHub Actions secrets, or a build environment. The
Tauri wrapper removes common Slack token variables before it starts a build.
Granola does not need a Mimir OAuth client because the user supplies a
supported Granola API key in Settings.

Vite binds to `127.0.0.1:1420`. If the port is busy:

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
```

`bun run dev` starts only the browser frontend. PTYs, dialogs, file index,
Apps, Routines, key storage, and the local tool server require Tauri.

## Verification

Run the normal development checks:

```bash
bun run test
bun run build
bun run docs:check
bun run check:meetings
```

Add the Rust checks for the complete CI set:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Run package scripts through Bun. The wrapper scripts set required Node flags.
Do not call Vitest or Vite directly for release verification.

The first clean Scribe build compiles whisper.cpp and can take several
minutes. The multilingual Whisper Small file is not in Git or in the app. The
verified in-product install downloads about 488 MB into
`~/.mimir/models/stt/`.

See [testing.md](testing.md) for change-to-test routing.

Rust development and test profiles keep line-table debugging and disable
incremental compilation. Use this command only when disk space is more
important than the next warm build:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
```

## Packaging

Before packaging, confirm these connection inputs:

- The reference Mac's ignored `.env` contains the Google OAuth client ID and
  secret. GitHub Actions needs the same two values for CI packaging.
- Slack personal tokens belong only in each user's OS keychain. They are not
  release inputs and must never enter the build.

### Local signed package

Check local signing inputs:

```bash
bun run check:signing
```

Build the release:

```bash
bun tauri build
```

The local release uses these credentials:

| Purpose | Inputs |
|---|---|
| Apple signing and notarization | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Tauri updater signing | `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`, plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |

`.env` is ignored by Git and must have mode `0600`. Use `bun tauri
build`; do not source `.env` in a shell.

On the reference Mac, the updater recovery key is
`~/.config/mimir/release/updater.key`. Its password is in the login Keychain
under `rs.shoulde.mimir.updater-signing`. CI uses GitHub secrets.

The wrapper:

1. requires a clean, unchanged Git commit;
2. builds only macOS arm64 release artifacts;
3. signs the app with Developer ID;
4. submits the exact DMG to Apple;
5. staples and validates the DMG and app;
6. creates the updater archive from the final stapled app;
7. signs that exact archive with the Tauri updater key;
8. writes and verifies the source-bound release stage.

The stage contains exactly eight files:

- the versioned arm64 DMG;
- the versioned `.app.tar.gz` updater;
- its `.sig`;
- `latest.json`;
- the source-bound manifest;
- `SBOM.spdx.json`;
- `THIRD_PARTY_LICENSES.md`;
- `THIRD_PARTY_NOTICES.md`.

## Create a release

The user phrase **create new release** authorizes the agent workflow in
`AGENTS.md`. The agent selects the SemVer increment from the changes. It asks
only when the correct increment is ambiguous.

The underlying command is:

```bash
bun run release:create -- patch
```

Use `minor`, `major`, or an explicit `X.Y.Z` when required.

The command refuses to continue unless:

- the branch is `main`;
- the working tree is clean;
- `main` matches `origin/main`;
- the repository is public;
- all Apple and updater GitHub secrets exist;
- the three version authorities agree;
- the tag and GitHub Release do not exist;
- frontend, documentation, command-sync, and build checks pass.

It updates the three version authorities, refreshes `Cargo.lock`, commits the
version, creates an annotated tag, and pushes the commit and tag together.

The tag starts the single `Verify and package` workflow. The workflow:

1. runs the complete Ubuntu verification job;
2. builds, signs, notarizes, and stages macOS arm64;
3. uploads one Actions artifact;
4. creates a temporary draft GitHub Release;
5. uploads and validates all eight files;
6. publishes the release without a manual action;
7. checks the public `latest.json` and updater archive.

The draft is only an atomic publication boundary. Users never see an
incomplete release. There is no manual candidate or manual Publish step.

After the workflow succeeds, run:

```bash
bun run release:verify
```

This command derives the tag from the synchronized repository version. It
verifies the published asset inventory, public updater version, signature
field, archive URL, and archive availability. Do not report release success
before this check passes.

Do not move a published tag. Do not replace published assets. If a published
release has a defect, fix it and create a new patch version.

### Manual workflow run

`workflow_dispatch` remains available for CI diagnosis. It verifies and
packages an Actions artifact, but it does not publish a GitHub Release. It is
not part of the normal release path.

### First updater-enabled release

Mimir 0.1.0 has no updater code. Each user must install the first
updater-enabled DMG once. Mimir 0.2.0 is that release.

All later releases use the in-app update flow. The next real release provides
the first installed-app end-to-end proof. Do not create a disposable test
release only for this proof.

Updater behavior, UI states, and restart safety are in
[updates.md](updates.md).

## Release acceptance

The workflow proves source identity, dependency checks, signing,
notarization, updater signing, and public asset access. It does not prove every
runtime path on another Mac.

For the first install and material runtime changes, check:

- Finder opens the DMG and copies Mimir to Applications.
- Gatekeeper opens Mimir without an unidentified-developer warning.
- The workbench opens, quits, and opens again.
- A project opens and saves an edited file.
- One terminal Activity starts and stops.
- macOS shows the expected microphone and system-audio permission flows.
- Scribe records both real channels, stops, and preserves the meeting.
- [acceptance.md](acceptance.md) passes for the changed areas.

If a check fails after publication, make a fix and release a new version. Do
not change the existing release.

## Dependency inventory and license policy

The locked Cargo and Bun inventory is committed as
`src-tauri/vendor/SBOM.spdx.json`. The release-readable inventory is
`src-tauri/vendor/THIRD_PARTY_LICENSES.md`. Both files and the Scribe notices
are in the app and beside each release.

`src-tauri/vendor/license-policy.json` is the review authority. Each locked
third-party component needs a declared license expression with at least one
permitted choice. Overrides must identify one exact component and version.

After a lockfile, policy, or reviewed embedded-asset change:

```bash
bun run supply-chain:generate
bun run check:meetings
git diff -- src-tauri/vendor
```

Generation reads Cargo metadata and the public npm registry. CI verifies the
result against the locks and policy.

CI also runs current advisory checks:

```bash
cargo install cargo-audit --version 0.22.2 --locked
bun run check:advisories
```

## Parked platforms

### Windows

Windows release packaging is inactive. The launcher rejects Windows release
builds. Recovery details remain in `scripts/release-env.mjs`,
`.env.example`, and the parked workflow history.

### Linux

CI compiles and tests Linux. The disabled AppImage and Deb package job remains
in `.github/workflows/build.yml`.

## Versioning

Keep the version synchronized in:

- `package.json`;
- `src-tauri/Cargo.toml`;
- `src-tauri/tauri.conf.json`.

`bun run release:create` owns the release-time change. The product name is
`Mimir`. The package and crate name is `mimir`.

## Local runtime files

The desktop app installs the `mimir` CLI and skills under `~/.mimir/`.
See [agent-setup.md](agent-setup.md) and
[docs/_MAP.md](_MAP.md#local-data).

API keys saved in Settings use the OS keychain. Debug builds can also read
process environment variables, the repository `.env`, and
`~/.mimir/keys.env`. The fallback file is a debug convenience. It is not
release credential storage.
