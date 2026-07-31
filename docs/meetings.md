# Scribe meetings

Status: implemented for the macOS arm64 release, 2026-07-30

Scribe is Mimir's native, local-first meeting recorder and transcription app.
It detects likely calls, asks the user to start, records microphone and system
audio as independent durable tracks, transcribes through a managed local model
or one explicitly configured custom service, and runs reviewable follow-up
Activities after a terminal transcript.

This document owns Scribe product and subsystem detail. General Activity
lifecycle, MCP transport, persistence helpers, and visual language remain in
[activities.md](activities.md), [mcp.md](mcp.md),
[persistence.md](persistence.md), and [design-system.md](design-system.md).

## Product contract

- Recording is human-controlled. Detection presents a candidate; neither the
  detector nor an agent tool can exercise Mimir's microphone grant.
- Starting requires an explicit in-app confirmation that participants were
  informed. Mimir cannot determine the applicable consent law.
- A persistent workbench indicator exposes elapsed time, microphone mute, and
  Stop while capture is active, including when the Scribe app is not selected.
- Microphone mute writes aligned silence to that channel. There is no pause
  state that could make channel clocks disagree.
- Microphone and system audio are separate, lossless 16 kHz mono `f32le`
  timelines. They are never mixed into the storage authority.
- Capture owns the realtime budget. Transcription tails committed chunks and
  cannot block an audio callback or prevent durable recording.
- Transcription is either `local` or `custom`. There is no vendor catalog,
  hidden network route, or automatic provider fallback.
- Stop drains audio and requests a terminal transcript revision. A terminal
  transcript with speech enqueues a durable title-and-summary Activity; a
  genuinely silent transcript completes without inventing a title, summary,
  or graph follow-up. A failed or unresolved transcript remains visibly
  recoverable and is never labelled complete.
- Knowledge-graph follow-up defaults to a separate user decision. “Create
  reviewable draft” runs a proposal Activity; it never mutates the graph
  invisibly.

## Native composition

`src-tauri/src/meetings/` owns the product runtime:

| Owner | Responsibility |
|---|---|
| `runtime.rs` | serialized lifecycle, recovery, snapshots, jobs, config policy |
| `store.rs` | SQLite authority, transcript revisions, chunk staging, leases |
| `capture.rs` | native audio streams, resampling, durable chunk commit, gaps |
| `transcriber.rs` | provider selection, durable tailing, live/final persistence |
| `local_whisper.rs` | in-process, Metal-only whisper.cpp inference |
| `stt.rs` | versioned provider-neutral WebSocket contract |
| `platform.rs` | config, Keychain, model manager, content, export, retention |
| `jobs.rs` | durable title/summary, transcription repair, and KG-proposal work |
| `tools.rs` | bounded, post-recording agent projection |
| `native.rs` | startup composition and native lifecycle owners |

Two deliberately small extracted crates sit under `src-tauri/crates/`:

- `mimir-meeting-audio` contains the audited Anarlog-derived Core Audio process
  tap, microphone stream, realtime ring, joiner, and drift/gap machinery.
- `mimir-meeting-detect` owns microphone-use observation and candidate policy.

The exact upstream revision, extracted-file manifest, retained license, and
local changes are recorded under `src-tauri/vendor/anarlog/`. Scribe-specific
dependency and model notices are in
`src-tauri/vendor/THIRD_PARTY_NOTICES.md`, which is packaged with the desktop
application. The upstream workspace is not a runtime or build dependency.

## Lifecycle and crash contract

The durable lifecycle is:

```text
Created → Recording → Stopping → Finalizing → Completed
                  ↘ Interrupted / Failed ↗
```

Only one meeting may own capture. Lifecycle transitions use optimistic
revisions in SQLite WAL mode. A one-second channel chunk is first staged in the
database, written through an atomic replace, and committed only after its byte
length and SHA-256 identity are durable. Transcription enumerates only these
committed database rows, revalidates their canonical path, bounds, byte length,
and SHA-256, and opens every path component without following links. Recovery verifies staged files,
quarantines corrupt state through the shared persistence helpers, releases
expired job leases, and converts an abandoned live lifecycle into an honest
interrupted record.

The renderer treats events as invalidation notices: install listeners first,
then read an authoritative snapshot. Correctness never depends on delivery to
a particular window. Dock/system Quit asks the user, performs the durable Stop
path, and exits only after native finalization returns. If the renderer window
was destroyed, the native exit handler still inspects capture, restores the
window, and durably stops before exit; an inspection or Stop failure fails
closed with Mimir still running. Closing or destroying the renderer does not
stop native capture.

Unexpected device loss reopens both capture sources as one generation, keeps
the canonical sample positions monotonic, and persists aligned silence/gap
evidence. Exhausted bounded retries fail actionably after finalizing everything
already committed. The worker reports a terminal disk/device/driver failure to
the durable runtime even without a renderer, which immediately leaves the
meeting visibly failed or interrupted for repair instead of waiting for Stop.

## Transcription routes

### Managed local model

The built-in model is multilingual Whisper Small. Its Hugging Face commit,
byte length, and SHA-256 are immutable source constants. Installation:

1. checks the current macOS arm64 platform and free-space reserve;
2. resolves and pins every HTTPS connection to validated public addresses;
3. streams into a private temporary file with bounded progress checkpoints;
4. verifies the exact length and SHA-256;
5. atomically installs the artifact and records its manifest identity.

Inference re-verifies the artifact immediately before use. `whisper-rs`
embeds whisper.cpp in process with Metal enabled. Unsupported targets and a
missing/corrupt model fail explicitly; Mimir never falls back to CPU or to a
network provider. Separate microphone and system windows preserve the
“You”/“Others” channel attribution.

### Custom URL

The custom route accepts an explicit public `https://` URL and model name, then
upgrades the connection to `wss://`. URLs with credentials, fragments,
non-public/special-purpose addresses, unsafe DNS answers, or insecure schemes
are rejected. The socket pins validated DNS results while retaining TLS
hostname verification.

The bearer secret is stored only in macOS Keychain under service
`rs.shoulde.mimir`, account `meetings.custom-stt`. The resolver releases it
only for the exact currently configured endpoint and never returns it through
IPC, diagnostics, files, or Activity arguments.

The route and model approved at Start are persisted as immutable meeting
provenance. Delayed or restart recovery uses that exact pair and fails closed
when legacy/damaged provenance is unavailable; changing global settings can
never redirect previously captured audio.

The versioned `mimir.stt.v1` WebSocket session sends model, sample format, and
ordered `microphone`/`system` channel identifiers. Provider acknowledgements
advance a bounded replay cursor over committed audio. Disconnects retry with
backoff; replay is bounded and idempotent, and an exceeded window becomes an
explicit transcript gap. Partial revisions are durable and visually distinct
until a final revision replaces them. Stop succeeds only after no unresolved
partial remains and a terminal revision is committed. Zero final segments are
a valid terminal result when no partial remains.

## Stop-time Activities

Follow-up jobs are leased, durable rows. The worker launches through
`RoutineRuntime` as a real PTY Activity using a preset's exact headless argv;
it never invokes a shell. Meeting id, hook id, immutable transcript revision,
and controlled paths are recorded as Activity provenance. Prompts treat the
transcript as untrusted quoted data, and outputs are bounded, schema-validated
JSON files under the meeting directory.

The default successful flow is:

1. generate a concise title and Markdown summary from the terminal transcript;
2. compare-and-set the reviewed content projection;
3. show “Create reviewable knowledge-graph draft?”, “Not now”, and “Never”;
4. if chosen, run a separate proposal-only Activity and expose its result for
   normal review.

Failures do not change a completed meeting into a recording failure. They
remain visible in both Scribe and the Activity tray and can be retried.
Idempotency keys and lease ownership prevent duplicate successful work after
restart. Each hook reads an immutable, bounded JSONL transcript materialized
from the exact terminal SQLite revision under
`<meeting>/followups/<job>/transcript.jsonl`. This is private job input, not a
user export: hook execution never creates a copy in `meetings/exports/`.

## Renderer and agent surface

`src/mimir/apps/ScribeApp.vue` owns the library, candidate suggestions,
consent gate, live ledger, transcript, summary, job diagnostics, KG decision,
exports, deletion, and settings. `src/stores/meetings.js` is an independent
workspace bootstrap initializer; it does not wait for MCP or Activities.

The public agent projection is intentionally post-recording and bounded:

- `meetings_list`
- `meetings_get`
- `meetings_search`
- `meetings_update`

Live meetings are unavailable to these tools. No start, mute, stop,
permission, credential, model-install, export, delete, or KG-mutation tool is
published. Granola remains a separate connection for externally recorded
meetings.

`meetings_search` requires at least three characters and queries private
SQLite trigram indexes for the complete reviewed title, full summary, tags,
and terminal transcript—not the 200-record renderer snapshot. Results and
per-meeting transcript excerpts remain capped, ordered newest first, and
exclude live or permanently deleting records. Reviewed content JSON remains
the editing authority; a file fingerprint repairs only missing/stale index
rows after an interrupted write.

## Local data and deletion

| Path | Contents |
|---|---|
| `~/.mimir/meetings.json` | native-owned Scribe configuration, no secret |
| `~/.mimir/meetings/meetings.sqlite` | lifecycle, chunk, transcript, job authority, and private reviewed-content search index |
| `~/.mimir/meetings/<id>/audio/` | independent committed channel chunks and gaps |
| `~/.mimir/meetings/<id>/followups/<job>/` | immutable bounded hook transcript input and controlled output |
| `~/.mimir/meetings/.content/` | reviewed title, summary, tags, and KG decision |
| `~/.mimir/meetings/exports/` | explicit user exports |
| `~/.mimir/models/stt/` | verified managed model and installation state |

Retention removes source audio only when the meeting is terminal and no
recovery or running-job hold applies. “Delete audio” preserves transcript and
reviewed content; “Delete meeting” tombstones the record, waits for any leased
Activity to finish without accepting its result, and removes the record plus
all owned files, including managed hook inputs and outputs. Files under
`meetings/exports/` exist only after an explicit user export and are
deliberately outside whole-record deletion; the user manages those copies
separately.
Deletion is best-effort local erasure and does not promise removal from
filesystem snapshots, backups, synced exports, or a custom provider that
already processed audio.

## Platform and release gates

The supported capture/inference product target is macOS arm64, minimum macOS
14.2. `Info.plist` carries microphone and system-audio purpose strings;
`Entitlements.plist` carries audio-input entitlement. Linux and Windows keep
explicit unavailable adapters so protocol, persistence, and unit tests remain
portable without pretending capture works.

Canonical behavior starts in `features/meetings/*.feature`. The evidence
manifest owns stable `MTG-*` scenario ids, performance budgets, automation
mapping, and manual packaged/hardware evidence. Run the focused and complete
gates documented in [testing.md](testing.md); signing, TCC, clean-install,
model, and packaged capture evidence is required for a release.
