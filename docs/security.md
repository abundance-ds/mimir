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
origin policy, or capability grant. Do not describe an API as "safe" without
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
| Scribe capture | native human consent gate; no public start/mute/stop tools | macOS grants audio access to the Mimir process, not to an isolated meeting sandbox |
| Scribe custom STT | exact public HTTPS endpoint upgraded to WSS, pinned DNS/TLS, bounded protocol; endpoint-bound Keychain secret; recovery remains bound to the route/model approved at Start | configured provider receives integrity-verified committed meeting audio and transcript by design |
| Scribe local STT | pinned model identity and Metal-only in-process runtime; only canonical digest-verified committed chunks enter inference | the model file and readable transcript/audio remain local user data |
| Scribe follow-up | exact-argv durable Activity, terminal revision, bounded schema-validated output | the selected CLI agent has normal user-account filesystem/process authority |
| Tracker collector | disabled native guard; lazy Accessibility; browser host-only retention; no screen capture or public tools | enabled title/domain history is sensitive local data readable by the user's account |
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
`/bin/bash -lc` (or `cmd.exe /C`) with the requested working directory.
Timeout defaults to 30s, clamped to 120s; stdout/stderr each truncated to
100,000 bytes with `[truncated]` marker.

Environment filtering (`is_sensitive_env_key`) drops keys matching
(`src-tauri/src/shell_exec.rs` lines 24-42):

- prefix `TAURI_`
- case-insensitive substring: `API_KEY`, `APIKEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`

This is heuristic; it does not sanitize filesystem, network, subprocess, or
shell-language behavior.

`shell.run` is not in the public agent projection; CLI agents already have
their own shell.

Timeout kills the direct shell child; do not assume an independently detached
descendant is terminated. PTY Activity stop/shutdown uses the Activity
supervisor's process handling and is a separate lifecycle.

Launcher/App/Routine commands preserve argv boundaries and avoid a shell unless
the configured command itself is a shell. Never "simplify" exact argv into a
joined string.

## AI credentials and network

Credential resolution order (see [ai-system.md](ai-system.md) for provider
details):

1. OS keychain;
2. process environment;
3. debug-only repository/ancestor `.env` candidates;
4. debug-only `~/.mimir/keys.env`.

Release builds refuse plaintext fallback when keychain writes fail.
`ai_transport.rs` permits only hosts from built-in/provider registry URLs;
debug builds additionally permit localhost/127.0.0.1. Provider errors pass
through best-effort key-prefix redaction, so new credential formats require
updating redaction.

## Tracker evidence

Tracker is disabled by default. Its Rust command boundary rejects opening
Accessibility settings or creating a tracked break while disabled; the
collector does not sample, call AI, notify, install launch-at-login, or expose a
menu-bar item in that state.

Enabled app/bundle identity comes from native `NSWorkspace`. Window titles are
a separate Accessibility-gated option. Browser evidence is separately opt-in:
per-browser Automation returns a URL, Rust immediately parses it, and only the
normalized domain is stored. Full URLs and screen pixels are never retained.
Window titles are bounded at 512 characters.

Classification sends app/bundle and optional domain through the existing AI
host policy and keychain-backed credentials. Titles are excluded unless the
user enables `includeWindowTitlesInAi`. The daily cost cap includes
classification and nudge generation. Local fallback nudges require no network.

Tracker timeline/title/domain data is intentionally absent from automatic
Mimir context, Business graph context, `mimir_state`, and the public agent tool
projection. There is no `tracker_read` or `tracker_stats` tool. The dashboard
and private Tauri commands remain trusted renderer surfaces, not an agent
authorization boundary. See [tracker.md](tracker.md).

## Team chat

WSS transport with mandatory SASL, no loopback exemption. Credential storage:
macOS release Keychain (`rs.shoulde.mimir`); debug/other-platform owner-only
`~/.mimir/chat.credential` via atomic secret writer (see
[persistence.md](persistence.md)). The SQLite cache contains readable team
history by design.

OPER model: owner limited to account provisioning + relay identity;
`mimir-admin` limited to account/channel lifecycle + mode repair.

Agent chat tools (`chat_read`, `chat_search`, `chat_send`) are public local
tools. Activity-to-room link rejects different targets (prevents room drift;
not cryptographic identity). Agent messages carry client-only provenance tags;
`RELAYMSG` scoped to owner capability. Transport parameters, tags, room names,
message IDs, lengths, and WSS schemes validated before queueing. See
[ipc.md](ipc.md) for relay ordering.

Attachments: loopback-only service behind Caddy `/files`; authenticates by
delegating Basic credential to Ergo SASL. Uploads capped at 25 MiB, total
5 GiB. Client downloads size/SHA-256 verified. Any authenticated teammate can
read shared files; only uploader can delete.

Focused desktop notifications: bounded sender/title and message preview for
DM/direct @mention; require explicit OS permission.

Operations, bootstrap, admin token flow, and backup contents are in
[`deploy/chat/README.md`](../deploy/chat/README.md).

## Scribe meetings

Meeting detection observes local microphone-use metadata and running
application identity; it does not capture audio. Recording requires a
deliberate renderer confirmation and is not present in the public MCP
projection. This matters because `/mcp` is unauthenticated loopback: exporting
recording controls would let any local process exercise Mimir's TCC grants.
The system-audio permission repair command has no input and opens only the
fixed macOS Screen & System Audio Recording privacy pane; it is not a general
URL or process launcher. Public metadata updates validate post-recording
visibility before the platform content writer is invoked.

The recorder writes independent microphone and system tracks under
`~/.mimir/meetings/`. Those bytes and SQLite transcripts are readable to the
local account and its processes; full-disk encryption and account security are
outside Mimir's boundary. Diagnostics contain ids, state, durations, bounded
errors, and route class, never raw audio, transcript text, prompts, or API keys.

Local transcription performs no provider request. Managed model installation
is the one expected network path: the immutable manifest requires HTTPS,
public DNS, pinned resolved addresses, exact length, and SHA-256 before atomic
install. Custom transcription permits only the explicit endpoint saved by the
user. The native credential resolver returns the Keychain secret only when
that exact validated endpoint is selected.

Meeting transcripts are untrusted input to stop-time CLI agents. Prompts mark
the transcript as quoted data and exact argv avoids shell reconstruction.
Each hook receives an immutable, owner-only, bounded JSONL input materialized
from the exact terminal transcript revision under the meeting's private
`followups/<job>/` directory. Hook execution never uses the public export path.
Input and output paths must remain under the owned meeting directory, symlinks
are rejected, reads/writes are bounded, and JSON output is strictly validated.
Whole-record deletion removes these managed hook artifacts; explicit user
exports remain separate copies under `meetings/exports/`.
Knowledge-graph work produces a reviewable proposal only; accepting it follows
the graph's normal revision-aware review boundary.

See [meetings.md](meetings.md) for the complete capture, retention, and
deletion contract.

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
| Meeting capture/STT/hook | TCC consent, callback budget, independent tracks, endpoint/credential binding, transcript trust, bounded durable output, deletion/retention |

See [mcp.md](mcp.md), [apps-system.md](apps-system.md),
[files.md](files.md), [ai-system.md](ai-system.md), [chat.md](chat.md), and
[meetings.md](meetings.md).
