# Mimir Chat deployment

These files install the isolated Ergo service used by Mimir Chats. Read
[`docs/chat.md`](../../docs/chat.md) before production
changes.

- `install.sh` pins and checksum-verifies Ergo, creates the dedicated service
  user and directories, installs the unit, and bootstraps the owner.
- `configure.py` transforms the matching Ergo default config and fails if a
  pinned source section changes.
- `bootstrap.py` idempotently creates the owner account and `#general`. A first
  install uses a no-WebSocket, loopback-only exemption solely for that
  bootstrap window; the installer restores the normal no-exemption config even
  when bootstrap fails.
- `file_service.py` is the authenticated raw-upload/file service; it delegates
  credentials to Ergo SASL and stores blobs plus SQLite metadata locally.
- `admin_service.mjs` is the dependency-free Node 22 administration service.
  It authenticates a dedicated, hidden `mimir-admin` account to Ergo for each
  serialized operation and never receives the raw HTTP token from disk.
- `admin.html` is the deliberately small browser UI for teammate and channel
  lifecycle. The public page reveals no state; every API call needs the exact
  bearer token.
- `admin_token.mjs` creates or exports the gitignored local token without
  printing it. The server stores only its SHA-256 digest.
- `admin_protocol.mjs` exercises add/reset/deactivate/reactivate/delete and
  create/topic/transfer/retire/allow against the live public API, then cleans
  up its randomized records.
- `manage_user.py` installs as `mimir-chat-user` for authenticated owner-run
  teammate creation and confirmed removal.
- `Caddyfile` is the additive `chat.shoulde.rs` site block.
- `configure_caddy.py` performs the exact additive file-route upgrade on an
  existing Mimir Chat Caddy block and fails closed if it differs.
- `protocol_smoke.py` checks the anonymous rejection boundary and the
  authenticated public WebSocket/SASL/echo/history path.
- `protocol_features.py` checks the full live/replay contract for reactions,
  edits, typing, attachment metadata, and redaction in an isolated channel.
- `file_protocol.py` uploads, downloads, and deletes a temporary attachment
  through the public authenticated route.
- `health.sh` verifies only the chat units, loopback listeners, public edge,
  attachment auth boundary, failed-unit state, and disk headroom.
  A five-minute systemd timer records failures in the journal and failed-unit
  state without touching any unrelated service.
- `backup.sh` takes a short offline, checksummed nightly snapshot of chat
  configuration, credentials, history, file metadata, and blobs. The timer
  retains 14 days by default.
- `restore.sh` verifies checksums, archive paths, the installed Ergo release,
  and SQLite integrity without changing state. `--confirm` performs the
  restore and automatically reinstates the prior state if health checks fail.

The installer does not edit Caddy. Merge only the supplied site block, run
`caddy validate`, and reload Caddy after recording the health of every existing
host. The chat deployment owns only `/opt/mimir-chat`, `/etc/mimir-chat`,
`/var/lib/mimir-chat`, and the `mimir-chat`, `mimir-chat-files`, and
`mimir-chat-admin` units.

Prepare the admin token locally:

```bash
node deploy/chat/admin_token.mjs
```

The raw token stays in the repository's ignored `.env` as
`MIMIR_CHAT_ADMIN_TOKEN`. First installation passes a protected exported copy
to `install.sh --admin-token-file`; remove that copy immediately afterward.
Do not print, commit, or place the raw token on the server permanently.

Operator examples:

```bash
sudo mimir-chat-user add anna
sudo mimir-chat-user remove anna --confirm anna
sudo mimir-chat-health
```

Removal reserves the historical account identity and also unregisters channels
the account founded. Transfer ownership of important founded channels first.
