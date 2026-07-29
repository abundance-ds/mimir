# Chats

Status: implemented, 2026-07-29. Review fixes landed the same day (multiline
ingestion, relay fallback, windowed history, read-anchor monotonicity,
file-service hardening); re-verify in production after deploying the updated
`file_service.py` and rerunning the protocol tests before calling this
production-verified again.

## Product model

Chats is the small-team communication place in Mimir. It is not an AI-agent
transcript, an Activity per room, or a complete Slack clone.

Settings > Chat has one Show Chats switch. Turning it off removes the entire
Sidebar section, disconnects the transport, clears the dock chat badge, and
unregisters the four local chat tools. It does not delete cached history,
credentials, channels, server history, or files; turning it on restores the
surface and reconnects.

- One stable `chats` Activity owns every room.
- The Sidebar shows one flat place-list below Tools. `#` and person icons carry
  the channel/direct distinction without extra section labels. Selecting a
  room changes chat state without adding to Activity history.
- The Activities `+` still means “start a process.” Activities still means
  “work currently running.” An agent started from a room becomes a normal
  Activity linked back to that room.
- The server speaks IRCv3 through Ergo, but Mimir exposes team language:
  channels, direct messages, replies, members, topics, unread messages, and
  search. IRC commands and service traffic are not part of the UI.

## Everyday interaction

The expanded Sidebar keeps channels followed by direct messages in one stable
list. Every unread place gets one dot; the Chats header gets one aggregate dot
whenever any place is unread. The Chats list has its own persisted disclosure
state. The collapsed whole Sidebar becomes one Chats hub rather than a narrow
rail of every room. Cmd/Ctrl+P can find a channel or direct message by name or
topic when a query is present, but rooms do not crowd its default result set.

The existing Activity pane header carries the active room, topic/member
summary, search, Start agent, and a compact details popover. The details
popover shows current members and supports topic editing, mute, leave, or
closing a direct-message row. There is no duplicate chat header.

Messages use a dense transcript rather than alternating bubbles. Consecutive
messages from one sender group for scanning; day boundaries, one New messages
marker, timestamps, agent provenance, code blocks, and links remain visible.
A one-level reply includes a compact source preview and can jump to the
original message. Search runs against the local SQLite cache, works offline,
and Escape returns from a result to the prior result list.

Hover or keyboard focus exposes the smallest useful message toolbar. Reply is
one level deep. Five common reactions are one click and toggle cleanly. An
author can edit a short message inline or enter a deliberate delete
confirmation; deleted content becomes a stable tombstone so replies retain
context. A copied `mimir://chat/<target>/<message>` link opens the exact cached
message. Direct @account mentions receive a quiet transcript treatment.

The paperclip accepts multiple files, native drag/drop, and pasted clipboard
files. The room is captured when upload starts. Cards show useful name,
size/type, automatic verified image previews, and one native open action.
Downloads are cached under `~/.mimir/chat-files/` only after their advertised
size and SHA-256 match.

Presence is intentionally coarse: available or away. Ergo marks an always-on
account away when all of its active sessions disconnect; Mimir does not infer
productivity or last-seen time. Typing indicators are ephemeral IRC tags,
expire locally after silence, and are excluded from persistent history.

Unread dots exist only for positive counts. Every unread room contributes to
the aggregate Chats dot even when muted. The dock badge follows the same total.
Focused desktop notifications require an explicit Settings > Chat permission
action and fire only for an incoming DM or direct @mention while it is not
already visible. Muting suppresses those alerts without changing unread state.

The composer keeps one draft and scroll position per room. Enter sends,
Shift+Enter adds a line, and a send is single-flight to prevent rapid duplicate
submission. When disconnected, history and search remain available, the
composer explains that sending is unavailable, and the draft remains intact.
Incoming messages follow only when the reader is already near the bottom;
otherwise a small “new messages below” control appears.

Create channel, Join channel, and Direct message are three short focused
flows. Known teammates are offered first for direct messages; an exact account
can still be entered.

## Agent participation

Start agent in the pane header chooses an enabled CLI-agent launcher. Mimir
creates and links the Activity before spawning the process, gives it a bounded
room prompt, and exposes:

```text
chat_read
chat_search
chat_send
chat_download
```

The room prompt is seeded as editable terminal input and is not submitted.
The user can append the actual assignment, revise any wording, and press Enter
when ready. Starting an agent therefore never sends instructions on the user's
behalf.

For a linked Activity, an explicit target cannot escape the linked room.
Agent sends are visible as `account/agent` when Ergo relay identity is
available, with a visible-label fallback otherwise. Messages keep the
originating Activity ID when the protocol carries it, so the provenance badge
opens that Activity. An agent Activity header offers Return to chat.

Examples:

```bash
mimir call chat_read '{"target":"#general","limit":20}'
mimir call chat_search '{"target":"#general","query":"launch decision","limit":10}'
mimir call chat_send '{"target":"#general","text":"Review complete."}'
mimir call chat_download '{"file_id":"<attachment id from chat_read>"}'
```

## Client architecture

`src-tauri/src/chat/` owns the WebSocket IRCv3 session, SASL, capabilities,
reconnect loop, channel history, membership/presence, validation, authenticated
file transfer, SQLite cache, and native tools. Required capabilities include
SASL, message/account tags, server time, batches, echo, chat/event history,
redaction, account/away notify, and extended join. Echo messages make the
server response the canonical local message.

`~/.mimir/chat.sqlite3` contains targets, messages, materialized edits,
reactions and tombstones, attachment metadata, FTS search, unread anchors,
member snapshots, mute/hidden state, and Activity links. Cached history is
available before or without a connection. HistServ bookkeeping is filtered
from the product transcript.

`~/.mimir/chat.json` contains only endpoint, account, and display name. macOS
release builds store the passphrase in the login Keychain under service
`rs.shoulde.mimir`. Debug builds deliberately avoid code-signature prompts
after each recompile, and other platforms lack that integration, so both use
the repository's atomic secret writer for an owner-only
`~/.mimir/chat.credential` file. Debug builds can use
`MIMIR_CHAT_PASSWORD`; adding `MIMIR_CHAT_PERSIST_PASSWORD=1` writes that
credential through the normal debug store for local provisioning.

The renderer boundary is `src/services/chat.js`, `src/stores/chat.js`, and the
Chat Activity/sidebar/settings components. The store owns per-room drafts and
scroll state, local search flow, active target, cached records, unread totals,
and native event reconciliation.

## Production service

The reference deployment is Ergo 2.19.0 behind the host's existing Caddy:

```text
https://chat.shoulde.rs/healthz    small Caddy health response
wss://chat.shoulde.rs/webirc      public TLS WebSocket
https://chat.shoulde.rs/files     authenticated attachment API
https://chat.shoulde.rs/admin/    token-gated administration UI
127.0.0.1:8067                    Ergo WebSocket listener
127.0.0.1:16667                   local bootstrap/operations listener
127.0.0.1:8069                    attachment service
127.0.0.1:8070                    Node administration service
```

Ergo is isolated as `mimir-chat.service` under user `mimir-chat`:

```text
/opt/mimir-chat/current/          pinned Ergo release
/etc/mimir-chat/ircd.yaml         generated server config
/etc/mimir-chat/waqr.pass         root-only owner passphrase
/etc/mimir-chat/admin-irc.pass    dedicated admin service credential
/etc/mimir-chat/admin.token.sha256 SHA-256 of the browser admin token
/var/lib/mimir-chat/              Ergo state and history
/var/lib/mimir-chat/files/        attachment blobs
/var/backups/mimir-chat/          root-only checksummed snapshots
```

The deployment keeps public TLS in Caddy, every service listener on loopback,
SASL mandatory on every listener with no loopback exemption,
self-registration off, persistent server history on, and `#general`
automatically joined. Always-on sessions have mandatory automatic away state.
The owner OPER class is intentionally limited to account provisioning and
relayed agent identity. The separate hidden `mimir-admin` identity has only the
account/channel lifecycle and mode capabilities required by the administration
service; it is protected from self-removal and parts `#general`.

The public URL is discoverable but not sufficient to join: Ergo rejects
unauthenticated sessions before chat use. New accounts can be created by the
root-only `mimir-chat-user` operation or the bearer-token admin API. Any
provisioned teammate is then trusted to create/join channels and message other
teammates.

`deploy/chat/install.sh` pins the release and verifies its published checksum,
creates only the chat user/directories/services, generates config from Ergo's
versioned default with counted replacements, starts the isolated units, and
bootstraps the owner, administration identity, and `#general`. The included
Caddy block is additive; merge it into the existing Caddyfile and validate
before reload.

On a first install only, bootstrap temporarily removes the WebSocket listener
and permits an anonymous loopback client long enough to create the owner. It
then installs the normal no-exemption configuration before exposing the
WebSocket listener. Cleanup fails closed to the normal configuration if
bootstrap does not complete. Existing installs bootstrap by authenticating as
the owner and never enable that temporary exception.

## Operations

The normal administration surface is:

```text
https://chat.shoulde.rs/admin/
```

Its token is the `MIMIR_CHAT_ADMIN_TOKEN` entry in the repository's ignored
`.env`, mode `0600`. The page itself is public and stateless; it exposes no chat
state until the exact token is entered, keeps that token in tab-scoped
`sessionStorage`, and clears it on logout. The server stores only the token's
SHA-256 digest.

The Users panel adds accounts, rotates a passphrase, removes/restores access,
and permanently unregisters an account. Add and reset show the generated
passphrase exactly once. `waqr` and `mimir-admin` are protected. The Channels
panel creates channels, edits topics, transfers founders, retires a channel,
and allows a retired name again. Retiring empties the room and blocks the name;
`#general` cannot be retired. These operations are deliberately serialized.

Create a teammate account on the server:

```bash
sudo mimir-chat-user add anna
```

The command generates a passphrase, prints it once, and refuses existing or
reserved accounts. The teammate enters account, passphrase, and their chosen
display name in Mimir. Use `--passphrase` only when an explicit team credential
policy requires it. The legacy `sudo mimir-chat-user anna` spelling still adds
an account.

Remove a teammate account:

```bash
sudo mimir-chat-user remove anna --confirm anna
```

Removal immediately unregisters the login while reserving the account name so
old messages cannot be mistaken for a future person. One caveat: the attachment
service caches successful credentials for up to five minutes, so a removed
account can keep attachment access for that window. Ergo also unregisters any
channels that account founded, so transfer important channel ownership before
offboarding its founder. This command does not erase cached or server history.

Leaving and retiring are intentionally different channel operations. Any
non-`#general` channel has **Leave channel** in its details popover; this parts
the current user and removes the row. `#general` is the durable team room and
cannot be left from Mimir. The everyday Mimir UI does not expose channel
deletion. The administration UI's stronger **Retire** action empties the room
and reserves its name until an administrator explicitly allows it again; it
does not promise to erase historical messages from caches or backups.

Routine checks:

```bash
sudo mimir-chat-health
systemctl list-timers mimir-chat-health.timer mimir-chat-backup.timer
journalctl -u mimir-chat.service -u mimir-chat-files.service \
  -u mimir-chat-admin.service --since today
```

Run the public protocol smoke test from a machine with the Python
`websockets` package:

```bash
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/protocol_smoke.py
```

The smoke test first verifies that an unauthenticated public WebSocket session
is rejected, then verifies TLS/origin, capabilities, SASL, `#general`, echo,
and history. It posts a visible transport marker, so remove or clearly label
test messages when running it in a working room.

The complete feature and attachment protocols use isolated/temporary records
and clean up after themselves:

```bash
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/protocol_features.py
ssh chat-host 'sudo cat /etc/mimir-chat/waqr.pass' \
  | python3 deploy/chat/file_protocol.py
```

The administration lifecycle test also uses isolated records and never prints
the token or generated passphrases:

```bash
node deploy/chat/admin_token.mjs --export /tmp/mimir-chat-admin.token
node deploy/chat/admin_protocol.mjs --token-file /tmp/mimir-chat-admin.token
unlink /tmp/mimir-chat-admin.token
```

Nightly backups briefly stop only the three chat units so the account store,
history databases, file metadata, blobs, and administration credentials form
one consistent snapshot.
They retain 14 days unless `MIMIR_CHAT_BACKUP_RETENTION_DAYS` overrides it:

```bash
sudo mimir-chat-backup
sudo mimir-chat-restore /var/backups/mimir-chat/mimir-chat-<timestamp>.tar.zst
sudo mimir-chat-restore --confirm /var/backups/mimir-chat/mimir-chat-<timestamp>.tar.zst
```

The first restore command only verifies. `--confirm` saves the exact prior
state in a timestamped recovery directory, restores, and runs the full health
check; a failed check automatically puts the prior state back.

For an Ergo upgrade, keep the old versioned directory and current config
backup, generate the new config from that release's exact `default.yaml`, run
`ergo ... --smoke` on alternate loopback ports, switch
`/opt/mimir-chat/current`, and restart only the three chat units. Roll back by
restoring the prior config/symlink and restarting those units. Validate Caddy
only if its additive site block changed.

Before any production change, capture the current Caddy configuration,
listeners, services, and health of unrelated hosts. Afterward, compare those
baselines, run `caddy validate`, inspect the chat unit, and repeat the public
protocol test. Do not restart or rewrite unrelated services.

## Validation contract

- Cached history and search work while offline; sends fail clearly and retain
  drafts.
- A clean app restart retrieves its credential and reconnects.
- The first unread message anchors the initial view; only a visible,
  bottom-following room is marked read.
- Loading older history and changing rooms preserve viewport position.
- Live direct messages reopen a hidden conversation; historical replay alone
  does not.
- JOIN, PART, and QUIT update the member count.
- AWAY/account notifications update coarse presence; typing never reaches
  history.
- Human, reply, multiline, and relayed agent messages round-trip through the
  public server and local cache.
- Reactions, unreactions, edits, deletion, attachment metadata, and
  authenticated file bytes round-trip; cleanup leaves no protocol test
  transcript or file.
- Room-bound agents cannot read, search, or send to a different target.
- Production listeners remain loopback-only behind Caddy, anonymous sessions
  are rejected even on loopback, and existing host services remain healthy.
