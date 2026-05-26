# Distribution System

Shoulders ships custom builds to design partner clients via a private CI pipeline and authenticated web portal.

## Architecture

```
profiles/*.json              define what ships per client
        ↓
scripts/prepare-profile.sh   stages resources for build
        ↓
GitHub Actions (CI)          builds macOS ARM + Windows + Linux
        ↓
Private GitHub Releases      stores signed .dmg/.msi + updater artifacts
        ↓
v3.shoulde.rs (web portal)   proxies downloads with key auth + serves updater endpoint
        ↓
Client installs              auto-updates via Tauri updater plugin
```

## Key Design Decision

All profiles share the same core app binary. Profiles only control which skills and apps are **seeded on first install** — they persist in `~/.shoulders-v3/` and survive updates. This means one update channel for all clients.

## Build Profiles

Profiles live in `profiles/*.json`. See [building.md](building.md#build-profiles) for format, creation, and the `prepare-profile.sh` script.

On first launch, the app reads `profile.json` from its bundled resources:
1. Filters `BUNDLED_SKILLS` to only those listed in `bundleSkills`
2. Seeds profile-specific skills from `bundled-skills/` resource directory
3. Seeds profile-specific apps from `bundled-apps/` resource directory
4. All seeding skips if the skill/app already exists on disk

Implementation: `src/stores/panel/persistence.js` (seeding block), `src/services/skills/loader.js` (`seedSkillFromResource`), `src/services/apps/seeder.js` (`seedAppFromResource`).

## Auto-Updater

### How it works

1. App checks `https://v3.shoulde.rs/api/updates/latest.json` on launch (5s delay)
2. If a newer version exists, the user sees a toast + can update from Settings → About
3. Download + install + relaunch happens in one step

### Signing

Updates are signed with a minisign keypair shared with v0.2.x:
- Private key: `~/.tauri/shoulders.key` (local) + `TAURI_SIGNING_PRIVATE_KEY` (CI secret)
- Public key: embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
- Do NOT regenerate — existing installs would reject updates signed with a different key

### Config

`src-tauri/tauri.conf.json`:
```json
"plugins": {
  "updater": {
    "pubkey": "...",
    "endpoints": ["https://v3.shoulde.rs/api/updates/latest.json"]
  }
}
```

`bundle.createUpdaterArtifacts: true` makes CI produce `latest.json` + `.sig` files attached to each release.

### Implementation

- Rust plugins: `tauri-plugin-updater`, `tauri-plugin-process` in `Cargo.toml`
- JS service: `src/services/appUpdater.js` (`checkForUpdate`, download/relaunch)
- UI: silent check on mount in `src/panel/App.vue`, manual check in `src/shared/ui/settings/AboutSection.vue`

## Server Infrastructure

A single AWS EC2 instance runs both the v0.2.x site and the v3 web portal, separated by Caddy reverse proxy routes:

| Domain | Backend | Port | Directory |
|---|---|---|---|
| `shoulde.rs` | v0.2.x site | 3000 | `~/shoulders/` |
| `v3.shoulde.rs` | v3 web portal | 3002 | `~/shoulders-v3/` |

Caddy handles TLS termination and reverse proxying for both domains.

### Systemd service

The v3 portal runs as `shoulders-v3-web.service` (port 3002). Environment variables are loaded from `~/shoulders-v3/web/.env`:

| Variable | Value |
|---|---|
| `NUXT_GITHUB_REPO` | `shoulders-ai/shoulders-private` |
| `NUXT_GITHUB_TOKEN` | Fine-grained PAT with release read access |
| `PORT` | `3002` |

Service management:

```bash
sudo systemctl restart shoulders-v3-web
sudo systemctl status shoulders-v3-web
journalctl -u shoulders-v3-web -f
```

## CI/CD for Web Portal

`.github/workflows/deploy-web.yml` auto-deploys the web portal on any push to `web/**`.

**Flow:**
1. SSHs to the EC2 server using `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY` secrets
2. Pulls latest changes in `~/shoulders-v3/`
3. Runs `bun install && bun run build` in `~/shoulders-v3/web/`
4. Restarts `shoulders-v3-web.service`

## Web Portal

Minimal Nuxt 3 app at `web/`, deployed to `v3.shoulde.rs`. See [../web/README.md](../web/README.md) for setup and deployment.

### Pages

- `/` — Landing page. Invitation-only branding.
- `/download?key=...` — Authenticated download page. Validates key, shows platform-specific download buttons.

### Server routes

- `/api/validate?key=...` — Validates JWT, returns client info + available release assets
- `/api/download?key=...&asset=...` — Proxies release asset download from private GitHub repo
- `/api/updates/latest.json` — Tauri updater endpoint. Proxies `latest.json` from private GitHub release. 10-minute cache.

### Authentication

Ed25519 JWT tokens. The private key lives in the repo root `.env` (`PORTAL_SIGNING_KEY`), the public key is committed at `web/server/data/portal.pub`. Tokens encode client name, allowed platforms, and expiry. Revoke by adding the token's `jti` to `web/server/data/revoked.json`.

See [../web/README.md](../web/README.md) for setup and token management.

## Client Delivery Flow

```
1. Create profiles/client-name.json (list skills, apps, bundleSkills)
2. Add any custom skills to profiles/skills/, apps to profiles/apps/
3. Push to shoulders-private
4. GitHub → Actions → Build & Release → Run workflow → profile: client-name
5. Release created with signed macOS + Windows + Linux builds
6. Issue JWT: node scripts/admin.mjs (or node scripts/issue-token.mjs "Client" --platforms=macos-arm,windows)
7. Send client: v3.shoulde.rs/download?key=<jwt>
8. Client downloads, installs, configures API key in Settings
9. Future updates: build a new version → client's app auto-updates
```

## CI Pipeline

Builds run on 3 platforms: macOS ARM (`macos-14`), Windows (`windows-latest`), and Linux (`ubuntu-22.04`). See [building.md](building.md#ci-builds) for workflow details, matrix, sidecar handling, and GitHub secrets.
