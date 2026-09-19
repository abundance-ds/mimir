# Building Mimir

Bun owns JavaScript; Cargo owns Rust. Release packaging targets macOS arm64.

## Prerequisites

- Bun 1.3.14, Node.js 22, stable Rust with rustfmt
- Tauri v2 platform dependencies
- Git and GitHub CLI for managed repositories
- macOS Scribe: Xcode command-line tools, CMake, and libclang

## Development

```bash
bun install --frozen-lockfile
bun tauri dev
```

On macOS, use the Tauri launcher for Scribe checks. It runs the generated Mimir
app bundle and preserves the correct permission identity. Do not use bare
`cargo run`. For an isolated hardware smoke:

```bash
bun run scribe:smoke-app
open src-tauri/target/debug/bundle/macos/Mimir.app
```

`bun run dev` starts only the browser frontend; native features are unavailable.
Vite binds to `127.0.0.1:1420`.

### Connection sign-in clients

Google browser sign-in needs these ignored `.env` values during development
and packaging:

```text
MIMIR_GOOGLE_OAUTH_CLIENT_ID=
MIMIR_GOOGLE_OAUTH_CLIENT_SECRET=
```

The Google client is a Desktop app with the services and scopes declared in
`connections.rs`. End users never enter these values. GitHub uses installed
`git` and `gh`; it has no Mimir build credential. Slack and Granola credentials
are entered after installation and must not enter `.env` or CI secrets.

## Verification

Use the complete commands in [testing.md](testing.md). Run package scripts
through Bun rather than invoking Vite or Vitest directly. The first clean
Scribe build can take several minutes; the verified Whisper model installs at
runtime under `~/.mimir/models/stt/`.

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

The ignored `.env` must have mode `0600`. Do not source it in a shell. The
reference Mac keeps the updater key under `~/.config/mimir/release/`; its
password is in the login Keychain. CI uses GitHub secrets.

Packaging requires a clean unchanged commit, builds macOS arm64, signs and
notarizes the app and DMG, creates the updater from the final stapled app, signs
that archive, and verifies the source-bound stage.

The release stage contains exactly:

- versioned arm64 DMG
- versioned `.app.tar.gz` and `.sig`
- `latest.json`
- source-bound manifest
- `SBOM.spdx.json`
- `THIRD_PARTY_LICENSES.md`
- `THIRD_PARTY_NOTICES.md`

## Create a release

When the user asks to create a release, select the SemVer increment from the
changes and ask only if it is genuinely ambiguous.

```bash
bun run release:create -- patch
```

Use `minor`, `major`, or an exact version when needed. The command requires:

- branch `main`, clean working tree, and exact `origin/main`
- public repository and all release secrets
- matching versions in `package.json`, Cargo, and Tauri configuration
- unused tag and GitHub Release
- passing frontend, docs, command, and build checks

It updates versions, `Cargo.lock`, and the software inventory, checks the
packaged inventory, commits, creates an annotated tag, and
pushes commit and tag together. The tag workflow verifies Ubuntu, builds and
signs macOS, uploads the exact stage, publishes one complete GitHub Release,
and verifies public updater assets.

After the workflow succeeds:

```bash
bun run release:verify
```

Do not report success before this passes. Never move a published tag or replace
published assets; publish a new patch release for a defect.

Manual `workflow_dispatch` builds a diagnostic artifact but does not publish.
Mimir 0.2.0 is the first updater-enabled release, so existing 0.1.0 users must
install its DMG once.

## Release smoke

The workflow cannot prove runtime behavior on another Mac. Material releases
must smoke the installed signed app for launch/relaunch, file save, one terminal
Activity, expected permission prompts, and affected Scribe/GitHub paths. Record
missing evidence in [issues.md](issues.md).

The signed, notarized 0.3.3 build from `e7373ce` passed local installed-app
checks on 2026-09-19: launch, guarded Quit, relaunch with saved tabs, LF and
CRLF file saves, Undo/Redo in the CRLF file, and a terminal command followed
by normal shell exit. The source-bound stage, code signature, and Gatekeeper
assessment passed. These checks did not exercise capture permission prompts,
live Scribe providers/recovery, or two-Mac GitHub sync.

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

Linux remains compile/test-only in CI. Windows release packaging is inactive.
`bun run release:create` owns version synchronization. Product name is `Mimir`;
package and crate name are `mimir`.
