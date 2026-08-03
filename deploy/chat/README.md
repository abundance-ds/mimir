# Mimir Chat ops runbook

Single ops owner for the Mimir Chat deployment. Client architecture and agent
participation are in [`docs/chat.md`](../../docs/chat.md); trust boundaries are
in [`docs/security.md`](../../docs/security.md). Operator host access, secret
locations, and deploy commands are machine-local in `.internal/deployment.md`
(gitignored, repo root).

## Reference deployment

Ergo 2.19.0 behind the host's existing Caddy:

```text
https://chat.shoulde.rs/healthz    Caddy health response
wss://chat.shoulde.rs/webirc       public TLS WebSocket
https://chat.shoulde.rs/files      authenticated attachment API
https://chat.shoulde.rs/admin/     token-gated administration UI
127.0.0.1:8067                     Ergo WebSocket listener
127.0.0.1:16667                    local bootstrap/operations listener
127.0.0.1:8069                     attachment service
127.0.0.1:8070                     Node administration service
```

Isolated as `mimir-chat.service` under user `mimir-chat`:

```text
/opt/mimir-chat/current/           pinned Ergo release
/etc/mimir-chat/ircd.yaml          generated server config
/etc/mimir-chat/waqr.pass          root-only owner passphrase
/etc/mimir-chat/admin-irc.pass     dedicated admin service credential
/etc/mimir-chat/admin.token.sha256 SHA-256 of the browser admin token
/var/lib/mimir-chat/               Ergo state and history
/var/lib/mimir-chat/files/         attachment blobs
/var/backups/mimir-chat/            root-only checksummed snapshots
```

Invariants: public TLS in Caddy, every service listener on loopback, SASL
mandatory on every listener with no loopback exemption, self-registration off,
persistent server history on, `#general` auto-joined. Always-on sessions get
mandatory automatic away. The owner OPER class is limited to account
provisioning and relayed agent identity.

## Installation

`install.sh` pins and checksum-verifies the Ergo release, creates the
`mimir-chat` user/directories/services, generates config from that release's
exact `default.yaml` with counted replacements, starts isolated units, and
bootstraps the owner, `mimir-admin` identity, and `#general`.

The Caddy block is additive; merge only the supplied site block, run
`caddy validate`, and reload after recording health of every existing host.

### Bootstrap exception

First install only: bootstrap temporarily removes the WebSocket listener and
permits an anonymous loopback client long enough to create the owner. It then
installs the no-exemption configuration before exposing the WebSocket. Cleanup
fails closed to normal configuration if bootstrap does not complete. Existing
installs bootstrap by authenticating as the owner.

## Deploy scripts

- `install.sh` -- pin release, create user/dirs/units, bootstrap owner
- `configure.py` -- transform Ergo default config; fail if pinned section changes
- `bootstrap.py` -- idempotent owner + `#general`; first-install loopback exemption
- `file_service.py` -- authenticated upload/download; delegates credentials to Ergo SASL; SQLite metadata
- `admin_service.mjs` -- dependency-free Node 22 admin service; dedicated hidden `mimir-admin` account; serialized operations; never receives raw HTTP token from disk
- `admin.html` -- browser UI for teammate/channel lifecycle; reveals no state without exact bearer token
- `admin_token.mjs` -- create/export gitignored local token; server stores only SHA-256 digest
- `manage_user.py` -- installs as `mimir-chat-user`; owner-authenticated teammate add/remove
- `configure_caddy.py` -- exact additive file-route upgrade on existing Caddy block
- `Caddyfile` -- additive `chat.shoulde.rs` site block
- `health.sh` -- chat units, loopback listeners, public edge, attachment auth, disk headroom; 5-min systemd timer
- `backup.sh` -- short offline checksummed nightly snapshot; 14-day default retention
- `restore.sh` -- verify checksums/paths/release/SQLite integrity; `--confirm` restores with automatic rollback on health failure

## Admin token

```bash
node deploy/chat/admin_token.mjs
```

Raw token stays in the repository's ignored `.env` as `MIMIR_CHAT_ADMIN_TOKEN`
(mode `0600`). First installation passes a protected exported copy to
`install.sh --admin-token-file`; remove that copy immediately afterward.

The page itself is public and stateless; it exposes no chat state until the
exact token is entered. The browser keeps it in tab-scoped `sessionStorage`,
never a cookie or URL. The server stores only the token's SHA-256 digest.

Caddy strips the `/admin/` prefix and proxies only to the loopback Node 22
service. API requests use constant-time comparison against
`/etc/mimir-chat/admin.token.sha256`.

The `mimir-admin` account authenticates over loopback SASL and obtains an OPER
role limited to account registration, suspension, channel registration/purge,
mode repair, and rate-limit exemption. It lacks history, rehash, shell, and
filesystem authority. Operations are serialized, request bodies capped at
16 KiB, and service logs exclude authorization and request bodies.
`waqr`, `mimir-admin`, and `#general` are protected from destructive actions.

### Administration UI

- **Users**: add accounts, rotate passphrase, remove/restore access, permanently unregister. Add and reset show the generated passphrase exactly once. `waqr` and `mimir-admin` protected.
- **Channels**: create, edit topic, transfer founder, retire (empties room, blocks name), allow retired name. `#general` cannot be retired. Operations are serialized.

## Account management

### mimir-chat-user

Reads the root-only owner secret and authenticates through SASL. Neither that
secret nor teammate passphrases belong in agent output, logs, or repository
files.

```bash
sudo mimir-chat-user add anna
sudo mimir-chat-user remove anna --confirm anna
```

- `add` generates a passphrase, prints it once, refuses existing/reserved accounts. The teammate enters account, passphrase, and chosen display name in Mimir. Use `--passphrase` only for an explicit team credential policy. Legacy `sudo mimir-chat-user anna` spelling still adds.
- `remove` unregisters the login, permanently reserves the historical account name. Caveat: the attachment service caches credentials for up to five minutes. Ergo also unregisters channels the account founded -- transfer important channel ownership before offboarding.

### Channel operations

- **Leave**: any non-`#general` channel via details popover; parts user, removes row.
- **Retire** (admin UI only): empties room, reserves name until administrator allows it. Does not erase historical messages from caches/backups.

## Monitoring

```bash
sudo mimir-chat-health
systemctl list-timers mimir-chat-health.timer mimir-chat-backup.timer
journalctl -u mimir-chat.service -u mimir-chat-files.service \
  -u mimir-chat-admin.service --since today
```

## Protocol tests

Public smoke test (requires Python `websockets`):

```bash
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/protocol_smoke.py
```

Verifies: anonymous rejection, TLS/origin, capabilities, SASL, `#general`,
echo, history. Posts a visible transport marker -- remove or label test messages.

Full feature and attachment protocols (isolated records, self-cleaning):

```bash
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/protocol_features.py
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/file_protocol.py
```

Administration lifecycle test (isolated records, never prints token/passphrases):

```bash
node deploy/chat/admin_token.mjs --export /tmp/mimir-chat-admin.token
node deploy/chat/admin_protocol.mjs --token-file /tmp/mimir-chat-admin.token
unlink /tmp/mimir-chat-admin.token
```

## Backup and restore

Nightly backups briefly stop only the three chat units so account store, history
databases, file metadata, blobs, and admin credentials form one consistent
snapshot. Archives and checksums are mode `0600` under `/var/backups/mimir-chat`.
Backups contain server credentials, admin token digest, chat history, file
metadata, and blobs. They do not contain the raw browser admin token.
Retention: 14 days unless `MIMIR_CHAT_BACKUP_RETENTION_DAYS` overrides.

```bash
sudo mimir-chat-backup
sudo mimir-chat-restore /var/backups/mimir-chat/mimir-chat-<timestamp>.tar.zst
sudo mimir-chat-restore --confirm /var/backups/mimir-chat/mimir-chat-<timestamp>.tar.zst
```

First command verifies only. `--confirm` saves the exact prior state in a
timestamped recovery directory, restores, and runs the full health check;
a failed check automatically reinstates the prior state.

## Ergo upgrade

1. Keep old versioned directory and current config backup.
2. Generate new config from that release's exact `default.yaml`.
3. Run `ergo ... --smoke` on alternate loopback ports.
4. Switch `/opt/mimir-chat/current` symlink.
5. Restart only the three chat units.
6. Roll back: restore prior config/symlink, restart those units.
7. Validate Caddy only if its additive site block changed.

## Pre/post-change checklist

Before any production change: capture current Caddy configuration, listeners,
services, and health of unrelated hosts. Afterward: compare baselines, run
`caddy validate`, inspect the chat unit, repeat the public protocol test. Do not
restart or rewrite unrelated services.

## Validation contract

- Cached history and search work offline; sends fail clearly, retain drafts.
- Clean restart retrieves credential, reconnects.
- First unread message anchors initial view; only a visible, bottom-following room is marked read.
- Loading older history and changing rooms preserve viewport position.
- Live DMs reopen hidden conversation; historical replay does not.
- JOIN/PART/QUIT update member count.
- AWAY/account notifications update coarse presence; typing never reaches history.
- Human, reply, multiline, and relayed agent messages round-trip through public server and local cache.
- Reactions, unreactions, edits, deletion, attachment metadata, and authenticated file bytes round-trip; cleanup leaves no test transcript or file.
- Room-linked agents default to their room; explicit targets reach any room the user sees.
- Production listeners remain loopback-only behind Caddy, anonymous sessions rejected on loopback, existing host services remain healthy.
