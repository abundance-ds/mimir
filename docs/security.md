# Trust and security boundaries

Mimir is a trusted-local workbench, not a sandbox or multi-tenant agent host.
This document prevents agents from mistaking validation in one subsystem for a
global permission boundary.

## Trust model

The user trusts:

- CLI agents launched with their user account;
- local App definitions and their JavaScript;
- callers able to connect to Mimir's loopback MCP port;
- Routine definitions and launcher presets under `~/.mimir`;
- the currently opened workspace.

There is no per-agent identity, permission prompt, package signature, App
origin policy, or capability grant. Do not describe an API as “safe” without
naming the exact boundary it enforces.

## Capability boundaries

| Surface | Enforced boundary | Important non-boundary |
|---|---|---|
| MCP HTTP | binds `127.0.0.1`; schema validation, timeouts, cancellation | `/mcp` has no bearer token or caller roles |
| Legacy `/api/tools` | runtime bearer token | token does not apply to `/mcp` |
| Files manager commands | canonical open-workspace root, traversal/symlink/root/overwrite checks | does not constrain generic file commands |
| Core text MCP tools | renderer `resolveSafePath` confines workspace paths | `@editor` operates on the current in-memory document |
| Top-level file Tauri commands | atomic replacement and IO errors | accept arbitrary user-readable/writable paths |
| Embedded App local protocol | validated app id, relative path, canonical containment | hosted App JavaScript remains trusted |
| App SDK filesystem | host file commands | not workspace-scoped |
| App HTTP | only `http`/`https`, timeout cap | no host allowlist; Apps may contact arbitrary hosts |
| AI transport | model registry host allowlist; release rejects localhost | provider receives prompt/context by design |
| Shell tool | timeout/output cap and heuristic secret-env filtering | executes a real shell as the user; not a process sandbox |
| Launcher/Routine PTY | exact argv, no shell reconstruction | child inherits user authority and merged environment |
| API-key persistence | release keychain; debug owner-only fallback | environment keys are inherited by Mimir before filtering elsewhere |
| Chat transport | public WSS, mandatory SASL, loopback Ergo listeners behind Caddy | one small-team server; no per-room authorization UI or enterprise tenancy |
| Chat administration | bearer token checked by a loopback Node service; server stores only its digest; dedicated narrow Ergo OPER | possession of the raw token grants full teammate/channel lifecycle administration |
| Linked chat agent | Activity-to-room link rejects target changes | an unlinked trusted-local MCP caller may pass a room explicitly |
| Chat credential | macOS login Keychain in release; owner-only atomic file in debug and elsewhere | local user/process authority remains the product trust boundary |

## MCP endpoint

`src-tauri/src/tool_server.rs` binds the configured port to loopback and exposes
a stateless MCP endpoint. Any local process able to reach that port can list and
call its capabilities, including shell execution and file/editor mutations.
The product assumes a trusted local account.

Do not bind externally, add CORS-style exposure, or advertise it as
authenticated without designing an actual caller/session policy. An
`mcp-session-id` header alone does not add security.

The registry validates JSON input schemas before provider dispatch. Provider
implementations still validate semantic constraints such as workspace
containment, revision matches, and current editor availability.

## Filesystem surfaces

`src-tauri/src/workspace_files.rs` is the strong file-manager boundary:
canonicalized paths must stay under the indexed workspace; the root cannot be
renamed/trashed; new names cannot contain separators; existing symlink escapes
are rejected; duplicate does not follow symlinks.

`src-tauri/src/file_index.rs` does not traverse or index symlinks and respects
ignore rules/noise directories. Index omission is a search/performance policy,
not an access-control rule.

Generic commands in `src-tauri/src/lib.rs` (`read_text_file`,
`write_text_file`, binary variants, directory listing) accept arbitrary paths.
Core MCP file tools add renderer-side workspace checks before invoking them.
Embedded Apps call the generic commands directly through `mimir-sdk.js`, so App
code is equivalent to trusted local extension code.

## Apps

Manifest validation protects catalog integrity and local protocol containment,
not the user from App behavior. Embedded Apps can:

- read/write arbitrary paths through the SDK;
- make arbitrary HTTP(S) requests through the native host;
- call every live registry tool;
- contribute tools callable by agents;
- open files in the Editor.

Local `app://` file serving canonicalizes the App root and target to block
traversal. Duplicate rejects symlinks and limits copied entries/bytes to avoid
unbounded package traversal. App data keys are relative-path validated and
namespaced by app id.

Provider lifetime is a security property: unmount/disconnect must unregister
definitions and cancel pending calls so a stale frame cannot retain authority.

## Shell and process execution

The private runtime handler `shell.run` (`src-tauri/src/shell_exec.rs`) executes
`/bin/bash -lc` (or
`cmd.exe /C`) with the requested working directory. The timeout defaults to
30s and caller values are clamped to 120s; stdout and stderr are each
truncated to 100,000 bytes with a `[truncated]` marker. Environment filtering
drops keys starting with `TAURI_` or containing `API_KEY`, `SECRET`, `TOKEN`,
`PASSWORD`, or `CREDENTIAL` (case-insensitive substring match), but it is
heuristic and does not sanitize filesystem, network, subprocess, or
shell-language behavior.

`shell.run` is not in the public agent projection; CLI agents already have
their own shell.

Timeout kills the direct shell child; do not assume an independently detached
descendant is terminated. PTY Activity stop/shutdown uses the Activity
supervisor's process handling and is a separate lifecycle.

Launcher/App/Routine commands preserve argv boundaries and avoid a shell unless
the configured command itself is a shell. Never “simplify” exact argv into a
joined string.

## AI credentials and network

Credential resolution order is:

1. OS keychain;
2. process environment;
3. debug-only repository/ancestor `.env` candidates;
4. debug-only `~/.mimir/keys.env`.

Release builds refuse plaintext fallback when keychain writes fail.
`ai_transport.rs` permits only hosts from built-in/provider registry URLs;
debug builds additionally permit localhost/127.0.0.1. Provider errors pass
through best-effort key-prefix redaction, so new credential formats require
updating redaction.

## Team chat

Chats uses a separate public WSS endpoint. The reference Ergo process listens
only on loopback; Caddy owns TLS and the public `/webirc` upgrade. SASL is
mandatory on every listener with no loopback exemption, account
self-registration is off, and owner-run provisioning creates the 2–10
expected accounts. This is proportionate small-team authentication, not a
multi-tenant authorization model.

`mimir-chat-user` authenticates the root-only owner account over loopback
before adding or removing a teammate. A first installation has a narrower
bootstrap exception: the public WebSocket listener is absent while localhost
is temporarily exempted to create the first owner account, after which the
installer restores the no-exemption configuration. Its exit cleanup also
restores that secure configuration after a failed bootstrap.

The public `/admin/` HTML is inert without its bearer token. Caddy strips the
prefix and proxies only to the loopback Node 22 service. API requests use a
constant-time comparison against `/etc/mimir-chat/admin.token.sha256`; the raw
token remains only in the repository's ignored, owner-only `.env` unless a
short-lived protected export is being staged for deployment. The browser keeps
it in tab-scoped `sessionStorage`, never a cookie or URL.

Each operation authenticates the hidden, dedicated `mimir-admin` account over
loopback SASL and obtains an OPER role limited to account registration,
suspension, channel registration/purge, mode repair, and rate-limit exemption.
It lacks history, rehash, shell, and filesystem authority. Operations are
serialized, request bodies are capped at 16 KiB, and service logs exclude
authorization and request bodies. `waqr`, `mimir-admin`, and `#general` are
protected from destructive UI actions. This is proportionate token
administration for the trusted small team, not multi-admin RBAC.

The non-secret endpoint/account/display name lives in `~/.mimir/chat.json`.
In a macOS release build the passphrase lives in Keychain under service
`rs.shoulde.mimir`. Debug builds avoid code-signature prompts after each
recompile, and other platforms lack that integration, so both use
`write_secret_bytes_atomic` for `~/.mimir/chat.credential`, including
owner-only mode on Unix. The SQLite cache contains readable team history by
design and is not encrypted separately from the user's filesystem.

`chat.read`, `chat.search`, and `chat.send` are public local tools. When an
Activity was started from a room, its durable Activity link wins and any
different requested target is rejected. That prevents accidental room drift;
it does not create cryptographic agent identity or protect against another
trusted process using the loopback MCP endpoint.

Agent messages carry client-only provenance tags and use Ergo `RELAYMSG` only
through the narrowly scoped owner capability. Transport parameters, tags, room
names, message IDs, lengths, and WSS schemes are validated before queueing.
Messages are server-echo canonical; cached history and search remain readable
offline.

Attachments use a separate loopback-only service behind Caddy `/files`. Every
upload, download, metadata read, and delete authenticates by delegating the
same Basic credential to Ergo SASL; the service does not maintain a second
password database. IDs are opaque, uploads are capped at 25 MiB, total storage
at 5 GiB, and client downloads are size/SHA-256 verified before native open.
Any authenticated teammate can read a shared file; only its uploader can
delete it. This matches the trusted 2–10-person team model, not per-channel
file authorization.

Focused desktop notifications contain only a bounded sender/title and message
preview for a DM or direct @mention. They require explicit OS permission.
Muting is a local attention control, not access control.

Root-owned backups contain the server credentials, admin token digest, chat
history, file metadata, and blobs by design; they do not contain the raw
browser admin token. Archives and checksums are mode 0600 under
`/var/backups/mimir-chat`; restore validates checksums, paths, installed release,
and SQLite integrity before any state change.

## Change map

| Change | Required review |
|---|---|
| New MCP tool | input schema, semantic validation, destructive description, local-caller threat model |
| New file command | decide workspace-scoped manager vs trusted arbitrary-path command; add symlink/traversal tests |
| App SDK capability | document trusted power, validate frame messages, disconnect cleanup |
| New network path | scheme/host policy, timeout, response bounds, credential/error redaction |
| New credential source | release/debug policy, storage permissions, status reporting |
| Process execution | argv/shell boundary, environment inheritance, timeout/descendant behavior |
| Tauri window/capability | `capabilities/default.json`, window labels, invoke/event reachability |

See [mcp.md](mcp.md), [apps-system.md](apps-system.md),
[files.md](files.md), [ai-system.md](ai-system.md), and [chat.md](chat.md).
