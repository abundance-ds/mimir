# Shoulders Web Portal

Minimal Nuxt 3 site deployed to `v3.shoulde.rs`. Serves authenticated downloads and the Tauri auto-updater endpoint.

## Setup

```bash
cd web
bun install
bun run dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|----------|---------|
| `NUXT_GITHUB_REPO` | Private repo (`shoulders-ai/shoulders-private`) |
| `NUXT_GITHUB_TOKEN` | Fine-grained PAT with read access to releases on the private repo |

## Authentication

JWT tokens signed with Ed25519. The private key stays in the repo root `.env` (`PORTAL_SIGNING_KEY`). The public key is committed at `server/data/portal.pub`.

Two token types:
- **Client tokens** — carry `name`, `platforms`, `exp`. Used for download access.
- **Admin tokens** — carry `role: "admin"`, `exp`. Used for admin dashboard login.

Verification: `server/utils/verify-token.js` (Nitro auto-imported, available as `verifyToken()` in all server routes).

### Issuing tokens

Use the local admin dashboard or the CLI:

```bash
# Admin dashboard (recommended)
node scripts/admin.mjs

# CLI: client token
node scripts/issue-token.mjs "Acme Pharma" --platforms=macos-arm,windows --expires=365d

# CLI: admin token
node scripts/issue-token.mjs --admin --expires=7d
```

### First-time setup

```bash
node scripts/issue-token.mjs --init
```

Generates an Ed25519 keypair. Writes public key to `web/server/data/portal.pub` (commit this). Stores private key in `.env` as `PORTAL_SIGNING_KEY`.

### Revocation

Add the token's `jti` to `web/server/data/revoked.json` and push. The server checks this file on every request.

Client metadata is tracked in `web/server/data/clients.json` (committed, for reference).

## Server Routes

| Route | Purpose |
|-------|---------|
| `GET /api/validate?key=...` | Validates JWT, returns client info + available release assets |
| `GET /api/download?key=...&asset=...` | Proxies release asset download from private GitHub repo |
| `GET /api/updates/latest.json` | Tauri updater endpoint (public, no auth). 10-min cache. |
| `POST /api/admin/login` | Admin JWT login (sets httpOnly cookie) |
| `POST /api/admin/logout` | Clears admin session cookie |
| `GET /api/admin/stats` | Admin dashboard stats |
| `GET /api/admin/telemetry` | Telemetry data |
| `GET /api/admin/analytics` | Website analytics |

## Production Deployment

Deployed on the same AWS EC2 instance as v0.2.x `shoulde.rs`. The v3 portal runs alongside it on a separate port.

**Server layout:**
- Repo cloned to `~/shoulders-v3/` on EC2
- Built with `cd ~/shoulders-v3/web && bun run build`
- Output: `~/shoulders-v3/web/.output/server/index.mjs`

**Systemd service:** `shoulders-v3-web.service` on port 3002.

**Caddy:** handles TLS and reverse proxies `v3.shoulde.rs` to `localhost:3002`.

**Environment:** `.env` in `~/shoulders-v3/web/` with:
- `NUXT_GITHUB_REPO=shoulders-ai/shoulders-private`
- `NUXT_GITHUB_TOKEN=<fine-grained PAT with release read access>`
- `PORT=3002`

**Auto-deploy:** `.github/workflows/deploy-web.yml` runs on push to `web/**`. It SSHs to the server, pulls, builds, and restarts the service. Uses `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY` GitHub secrets.

**Manual deploy:**

```bash
ssh ubuntu@<SERVER_HOST>
cd ~/shoulders-v3 && git pull
cd web && bun install && bun run build
sudo systemctl restart shoulders-v3-web
```


## Design System

See: `../docs/web-design-system.md`

