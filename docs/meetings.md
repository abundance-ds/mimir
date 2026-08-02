# Scribe meetings

Status: not ready. The automated repair suite is green, and a signed installed
build has completed first-run microphone/system-audio permission, known-
playback dual-signal capture, local live transcription, and Stop on the
reference Mac. A real Keychain credential has completed OpenAI's dedicated
transcription-session handshake; hosted live audio-to-transcript and
interrupted-recording recovery still lack signed end-to-end evidence. Do not
describe Scribe as ready until every required record exists in the evidence
manifest.

Scribe is Mimir's native, local-first meeting recorder and transcription app.
It detects likely calls, asks the user to start, records microphone and system
audio as independent durable tracks, transcribes through a managed local model
or one explicitly configured custom service, and runs reviewable follow-up
Activities after a terminal transcript. The review surface exposes only
summary generation and a general custom agent task; knowledge-graph proposals
are not part of the current Scribe interaction model.

This document owns Scribe product and subsystem detail. General Activity
lifecycle, MCP transport, persistence helpers, and visual language remain in
[activities.md](activities.md), [mcp.md](mcp.md),
[persistence.md](persistence.md), and [design-system.md](design-system.md).

## Product contract

- Recording is human-controlled. Detection presents a candidate; neither the
  detector nor an agent tool can exercise Mimir's microphone grant.
- Starting is one deliberate Record action. Native code still issues and
  consumes a short-lived, single-use authorization bound to the visible route
  and candidate; this is an internal anti-replay boundary, not a user
  attestation or legal checkbox.
- A persistent workbench indicator exposes elapsed time, microphone mute, and
  Stop while capture is active, including when the Scribe app is not selected.
- Permission state is attributed only to the signed `rs.shoulde.mimir` bundle.
  A terminal-launched development binary is labelled “development host — not
  Mimir” even when that host has microphone access. System-audio setup creates
  the public Core Audio process tap before opening the fixed macOS **Privacy &
  Security → Screen & System Audio Recording** pane, which registers signed
  Mimir with TCC. Audio checking can stream one combined microphone/system
  level projection at no more than 10 Hz. It distinguishes open failure, no
  callbacks, captured silence, and signal, reduces frames immediately to a
  bounded count and peak, discards every sample, and creates no meeting.
- Microphone selection is persisted as CPAL's serialized Core Audio device UID,
  never as a display name or enumeration index. Device catalogs explicitly
  report whether that UID is still available. If it is missing, capture uses
  the current default microphone for that run and the catalog supplies a
  fallback explanation; the stored choice is retained so reconnecting the
  device restores the user's selection.
- Microphone mute writes aligned silence to that channel. There is no pause
  state that could make channel clocks disagree.
- Microphone and system audio are separate, lossless 16 kHz mono `f32le`
  timelines. They are never mixed into the storage authority.
- The system tap is global: audible output from Spotify, browsers, meeting
  apps, and other processes is included unless a process is explicitly
  excluded. Hardware signal must be checked from the bundled Mimir app; the
  raw `bun tauri dev` executable has no stable TCC bundle identity and is not
  valid system-audio evidence.
- Capture owns the realtime budget. Transcription tails committed chunks and
  cannot block an audio callback or prevent durable recording.
- Transcription is either managed local or an explicit hosted URL. The primary
  hosted setup is OpenAI Realtime (`gpt-live-transcribe`); advanced URLs remain
  available and never receive audio without the selected route and an
  endpoint-bound Keychain credential. There is no hidden provider fallback.
- Stop drains audio and requests a terminal transcript revision. A terminal
  transcript with speech enqueues a durable title-and-summary Activity; a
  genuinely silent transcript completes without inventing a title, summary,
  or follow-up. A failed or unresolved transcript remains visibly
  recoverable and is never labelled complete.
- Summary offers three clear starting points—Summary, Brief, and Decisions +
  actions—plus Custom. Presets seed a per-run prompt that stays collapsed until
  the user wants to fine-tune it. Custom opens an interactive CLI-agent
  Activity for the reviewed meeting.

## Native composition

`src-tauri/src/meetings/` owns the product runtime:

| Owner | Responsibility |
|---|---|
| `runtime.rs` | serialized capture lifecycle, recovery, and config policy |
| `runtime/library.rs` | bounded library, transcript, search, and renderer projections |
| `runtime/followups.rs` | durable summary reruns and retained-audio retranscription |
| `runtime/tests.rs` | runtime contract fakes and behavioral tests |
| `store.rs` | SQLite authority, transcript revisions, chunk staging, leases |
| `capture.rs` | native audio streams, resampling, durable chunk commit, gaps |
| `audio_test.rs` | ephemeral level streaming, window ownership, native teardown |
| `transcriber.rs` | provider selection, durable tailing, live/final persistence |
| `local_whisper.rs` | in-process, Metal-only whisper.cpp inference |
| `stt.rs` | versioned provider-neutral WebSocket contract |
| `platform.rs` | config, Keychain, model manager, content, export, retention |
| `jobs.rs` | durable title/summary, transcription repair, and KG-proposal work |
| `tools.rs` | bounded, post-recording agent projection |
| `native.rs` | startup composition and native lifecycle owners |
| `permissions.rs` | signed-bundle identity and truthful TCC projection |

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
interrupted record. Its recovered stop time is derived from the final committed
audio coordinate, not from the later relaunch wall clock; a staged chunk that
is promoted during recovery can advance that boundary.

Completed is resumable only through the explicit **Continue** action. Mimir
keeps the meeting id and reviewed history, creates a fresh run id, invalidates
the terminal transcript with one durable continuation revision, and appends
both channels at the next shared audio sequence. The elapsed duration starts
from retained audio and adds only the new capture run, so a break is not counted;
late callbacks from an earlier run are ignored. Continuation stays on the
meeting's original transcription route and model so retained audio cannot cross
an undisclosed provider boundary after a settings change.

Transcription repair is keyed to the immutable capture `runId`, never to the
mutable transcript revision. A retry reads only verified committed audio from
sequence zero and writes provider batches into private SQLite staging that is
neither rendered nor indexed. Restart clears an incomplete pass under that
same owner. The terminal pass is reconciled with set-based SQL as exactly one
new transcript revision: stale live STT rows and partials are replaced while
capture gaps and revision history remain intact. A crash after the terminal
revision but before lifecycle or job acknowledgement completes locally on the
next delivery without reopening a model, reading a Keychain credential,
connecting to a provider, or opening audio. Recovery classifies and promotes
staged audio before applying that shortcut: if a durable tail appears beyond
the earlier terminal transcript, Mimir keeps the meeting interrupted and
queues one new repair for the original capture generation instead of launching
summary work. Durable capture-failure intent likewise wins over an all-final
transcript in the same crash window, so restart restores `Failed` with the
original failure rather than relabelling the meeting successful.

The renderer treats events as invalidation notices: install listeners first,
then read an authoritative snapshot. Correctness never depends on delivery to
a particular window. Dock/system Quit asks the user, performs the durable Stop
path, and exits only after native finalization returns. If the renderer window
was destroyed, the native exit handler still inspects capture, restores the
window, and durably stops before exit; an inspection or Stop failure fails
closed with Mimir still running. Closing or destroying the renderer does not
stop native capture.

Device readiness is asynchronous. After free-space and durable-state
preflight, the runtime installs the active run and capture worker before Core
Audio or TCC can block. Record therefore returns with owned `Opening` state;
Stop can cancel that exact worker immediately, while a native opener that has
not returned is reclaimed off the command path. Stopping an audio level check
uses the same non-blocking cleanup rule, so diagnostics cannot trap Record.

Unexpected microphone loss reopens the capture generation while keeping the
canonical sample positions monotonic. System-audio open and restart are
independent: a missing or ended process tap keeps microphone capture live,
writes aligned system silence under the authorized channel, and persists
explicit bounded gap evidence while retrying the tap. A mic-only consent never
opens or writes a system channel. Exhausted microphone retries fail actionably
after finalizing everything already committed. The worker reports a terminal
disk/microphone/driver failure to the durable runtime even without a renderer,
which immediately leaves the meeting visibly failed or interrupted for repair
instead of waiting for Stop.
When Stop discovers that the capture worker already ended, it durably records
the interruption, drains and removes the live transcriber, and only then makes
same-process repair claimable. A delayed failure callback is an idempotent
redelivery and cannot create a second recovery owner.
At an ordinary Stop, CoreAudio can deliver a few final callbacks from one
source after the other. Scribe pads this bounded scheduling skew to keep tracks
aligned without presenting a false capture gap. Divergence beyond the explicit
tolerance remains durable gap evidence.
If Stop instead joins a worker while device or sleep recovery is recording an
explicit gap, it reloads the post-teardown meeting revision before entering
`Finalizing`; the gap remains authoritative without turning a successful Stop
into a revision conflict.

## Transcription routes

### Managed local model

The built-in model is multilingual Whisper Small. Its Hugging Face commit,
byte length, and SHA-256 are immutable source constants. Installation:

1. checks the current macOS arm64 platform and free-space reserve;
2. resolves and pins every HTTPS connection to validated public addresses;
3. streams into a private temporary file with bounded progress checkpoints;
4. verifies the exact length and SHA-256;
5. atomically installs the artifact and records its manifest identity.

Inference re-verifies the artifact immediately before use. Model preparation
is owned asynchronously: recording returns without waiting for Metal warm-up,
projects transcription as `initializing`, and Stop joins the same worker or
queues one durable repair. `whisper-rs`
embeds whisper.cpp in process with Metal enabled. Unsupported targets and a
missing/corrupt model fail explicitly; Mimir never falls back to CPU or to a
network provider. Separate microphone and system windows preserve the
“You”/“Others” channel attribution. A persistent per-channel Earshot voice
gate requires sustained speech evidence before Whisper inference; deterministic
decoding, no-speech/log-probability thresholds, and bounded repetition
filtering prevent room tone and isolated clicks from becoming invented text.

### OpenAI Realtime and advanced URLs

The hosted route accepts an explicit public `https://` URL and model name, then
upgrades the connection to `wss://`. The normal OpenAI selection fills
`https://api.openai.com/v1/realtime` and `gpt-live-transcribe` in the same
atomic settings mutation, so selecting it cannot fail because a hidden URL is
still empty. The persisted endpoint remains canonical; only the wire handshake
adds `intent=transcription`, which selects OpenAI's dedicated transcription
session before Mimir sends `session.update`. URLs with credentials, fragments,
non-public/special-purpose addresses, unsafe DNS answers, or insecure schemes
are rejected. The socket pins validated DNS results while retaining TLS
hostname verification.

The bearer secret is stored only in macOS Keychain under service
`rs.shoulde.mimir`, account `meetings.custom-stt`. The resolver releases it
only for the exact currently configured endpoint and never returns it through
IPC, diagnostics, files, or Activity arguments.
Saving reports success only after an endpoint-bound Keychain read-back matches
the submitted secret. Scribe then shows a persistent configured state with
separate replace and remove actions; it retains the typed value and renders the
native failure beside the field when Keychain does not confirm the write.
After one successful read, the endpoint-bound value (including an absent value)
is cached only in process memory. Snapshot and transcript notifications reuse
that result instead of repeatedly opening Keychain authorization dialogs. The
cache is invalidated when the endpoint changes and overwritten on explicit save
or removal.

The route and model approved at Start are persisted as immutable meeting
provenance. Delayed or restart recovery uses that exact pair and fails closed
when legacy/damaged provenance is unavailable; changing global settings can
never redirect previously captured audio.

Explicit retranscription is a separate human action. It requires retained,
committed source audio and a `Completed`, `Failed`, or `Interrupted` meeting,
then freezes the currently selected route and model into a new durable job. A
pending automatic repair is cancelled before the deliberate new route can
receive audio; a running repair remains authoritative until it finishes. This
does not weaken automatic recovery's original-route rule. Provider output
remains in a private generation while it is partial; provider failure leaves
the old transcript and revision readable. Only an all-final pass atomically
replaces the STT-owned projection and completes an interrupted meeting. The
action itself is the authorization—there is no attestation checkbox. A crash
after commit but before job acknowledgement is reconciled locally without
disclosing the audio a second time.

OpenAI uses two independently owned Realtime transcription WebSockets: one for
microphone and one for system audio. Native code converts each committed 16
kHz `f32le` channel to 24 kHz PCM16, commits bounded two-second turns, accepts
delta/completed events, and assigns session-relative time plus `You`/`Others`
provenance because the model does not supply word timing or speaker labels.
The API key appears only in the TLS WebSocket `Authorization: Bearer` header.
OpenAI does not receive Mimir's private provider subprotocol.

Other advanced endpoints use the versioned `mimir.stt.v1` WebSocket session,
which sends model, sample format, and ordered `microphone`/`system` channel
identifiers. Provider acknowledgements
advance a bounded replay cursor over committed audio. Disconnects retry with
backoff; replay is bounded and idempotent, and an exceeded window becomes an
explicit transcript gap. Partial revisions are durable and visually distinct
until a final revision replaces them. Stop succeeds only after no unresolved
partial remains and a terminal revision is committed. Zero final segments are
a valid terminal result when no partial remains.

## Stop-time Activities

Follow-up jobs are leased, durable rows. The worker launches through
`RoutineRuntime` as a real PTY Activity and never invokes a shell. Ordinary
launcher presets select the agent and optional model, but stop-time Codex work
is reduced to an ephemeral workspace-write invocation with user config, MCP,
extra directories, and authority-expanding flags disabled. Meeting id, hook
id, immutable transcript revision,
and controlled paths are recorded as Activity provenance. Prompts treat the
transcript as untrusted quoted data, and outputs are bounded, schema-validated
JSON files under the meeting directory.

Terminal lifecycle and the optional default title/summary outbox row commit in
one SQLite transaction. A job validation or insert failure leaves the meeting
`Finalizing`; it cannot produce a completed meeting with missing required
follow-up. Reading stop-hook policy uses a narrow non-secret configuration
projection and never reads the custom-STT credential. Manual retries receive
monotonic idempotency generations, while lease ownership still prevents more
than one live attempt in a generation.

The default successful flow is:

1. generate a concise title and Markdown summary from the terminal transcript;
2. compare-and-set the reviewed content projection;
3. open completed meetings on Summary when a summary exists;
4. let the user create another summary from a seeded preset or launch a Custom
   interactive agent task.

The visible summary presets are `standard`, `brief`, and `decisions-actions`.
Each seeds an editable per-run prompt. A separate optional launcher selector
chooses the exact installed CLI-agent preset for that run. The format identity,
exact prompt text, and agent identity are copied into the durable job payload,
so later settings edits cannot alter an already queued run and fine-tuning one
meeting cannot silently change future meetings. The globally saved prompt is
editable only in Scribe settings.

The editable text is not the entire agent prompt. Native code wraps it in a
fixed safety and output envelope: it identifies the immutable transcript as
untrusted data, forbids following transcript instructions, requires one
bounded title/summary JSON object at the controlled output path, and forbids
other file changes. The user-authored text is inserted as the summary-specific
instruction inside that envelope. A completed meeting can deliberately enqueue
a new title-and-summary generation; ordinary retry and regeneration remain
separate from capture state.

Custom is deliberately different from summary generation. It requires a CLI
agent and prompt, then opens a durable interactive Activity with the exact
meeting id in provenance and `MIMIR_MEETING_ID`. Before launch, native code
materializes the exact complete terminal revision as immutable private JSONL
and passes its path and revision in the Activity environment and prompt; the
agent does not need a `meetings_get` discovery round trip. Scribe does not imply
a hidden graph mutation or a vague draft destination.

Failures do not change a completed meeting into a recording failure. They
remain visible in both Scribe and the Activity tray and can be retried.
Idempotency keys and lease ownership prevent duplicate successful work after
restart. Each hook reads an immutable, bounded JSONL transcript materialized
from the exact terminal SQLite revision under
`<meeting>/followups/<job>/transcript.jsonl`. This is private job input, not a
user export: hook execution never creates a copy in `meetings/exports/`.

## Renderer and agent surface

`src/mimir/apps/ScribeApp.vue` owns a three-state Ready → Recording → Review
flow, inline candidate suggestions, live ledger, transcript, summary, job
diagnostics, custom agent tasks, file access, deletion, and separate settings. Record is
one action; there is no consent screen. During recording, the fixed transport
keeps Stop above every nonblocking diagnostic. Review opens on Summary when it
exists; its header contains Back, **Continue** when eligible, and one actions
menu. Continue recording, Rename, Show in Finder, save-copy actions,
retranscription, and Delete use the same accessible menu from detail and list
context. Failed transcripts also expose an inline
**Transcribe again** action. `src/stores/meetings.js` is an independent
workspace bootstrap initializer; it does not wait for MCP or Activities.
Recorder readiness also does not wait for transcript-window hydration, and
native startup secures private roots and authority files without recursively
walking every historical audio chunk or model artifact.
Library snapshots deliberately omit transcript text. Recording and Review both
render the selected meeting's separately paged transcript window, so the final
words visible live cannot disappear during Stop or when the meeting is reopened.
Configuration mutations share one ordered renderer queue. While it is nonempty,
every configuration control exposes and disables for the pending state; a
second accepted mutation runs after the first instead of returning an empty
success or silently discarding user intent.

The native microphone/audio-test renderer contract is:

- `MeetingSnapshot.config.microphoneDeviceId` is the persisted Core Audio UID
  or `null` for the current default.
- Select or clear it through the existing ordered `meetings_update_config`
  command with `{ microphoneDeviceId: <device id> }` or
  `{ microphoneDeviceId: null }`.
- `meetings_microphone_devices` returns `{ selectedDeviceId,
  selectedAvailable, effectiveDeviceId, fallbackReason, devices[] }`; every
  device is `{ id, name, isDefault }`.
- `meetings_audio_test_start` takes no renderer-selected device argument. It
  uses the authoritative persisted configuration and returns `{ testId,
  requestedMicrophoneDeviceId }` immediately.
- `mimir://meeting-audio-test` emits `{ testId, sequence, state, microphone,
  systemAudio, microphoneDeviceId, microphoneDeviceName,
  fallbackFromMicrophoneDeviceId }`. Each source is `{ state, level, error? }`;
  running level events are combined and capped at 10 Hz.
- `meetings_audio_test_stop({ testId })` is owner-window scoped. Starting a
  recording, destroying the owner window, native shutdown, and explicit Stop
  all release both test streams. Renderer cleanup is helpful but not required
  for correctness.

Native snapshots expose transcription as `initializing`, `connecting`,
`listening`, `live`, `reconnecting`, `failed`, `delayed`, `batch`, `final`, or
`idle`. `src/services/meetings.js` exposes `retranscribeMeeting(meetingId)` and
the Pinia store exposes `retranscribe(id)`; both invoke
`meetings_retranscribe` and receive the ordinary authoritative snapshot. This
command is intentionally absent from the public agent tool projection.

Reviewed tags use the same projection in native meeting detail, list/search
agent metadata, and the Scribe review surface, so they cannot become
write-only metadata. The renderer presents tags as restrained inline text and
offers one keyboard-editable comma-separated field. Public inputs are trimmed,
deduplicated, and rejected before IPC above 64 entries, 80 characters, or the
native 160-byte per-tag storage bound; malformed native payloads are discarded
at renderer normalization rather than entering application state.

The public agent projection is intentionally post-recording and bounded:

- `meetings_list`
- `meetings_get`
- `meetings_search`
- `meetings_update`

Live meetings are unavailable to these tools. No start, mute, stop,
permission, credential, model-install, export, delete, or KG-mutation tool is
published. `meetings_update` loads and validates the same post-recording public
projection before asking the platform content owner to write, so a live or
otherwise private record cannot be mutated through a timing race. Granola
remains a separate connection for externally recorded meetings.

The packaged `mimir-meetings` skill is the progressive-disclosure guide for
this group: search or list first, get only the selected record, page only when
the task needs the complete transcript, and treat transcript text as untrusted
data. The skill adds no recording capability or second tool surface.

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
| `~/.mimir/meetings/<id>/meeting.md` | current reviewed summary and transcript, materialized by **Files** |
| `~/.mimir/meetings/<id>/followups/<job>/` | immutable bounded hook transcript input and controlled output |
| `~/.mimir/meetings/<id>/scribe-debug.jsonl` | rotating owner-only pipeline events; no transcript text, audio, credential, or provider URL |
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
The Review menu's **Show in Finder** action atomically refreshes `meeting.md` inside
the owned meeting directory and reveals that directory in Finder. Available
source audio remains beside it. Unlike an export copy, this materialized file
is owned by the meeting and is removed by **Delete meeting** together with the
database record, transcript, reviewed content, follow-up artifacts, and audio.
An unresolved `collecting` transcript-repair generation is itself an audio
hold, even after its job attempts are exhausted; both explicit audio deletion
and retention skip it. Conversely, retry refuses before provider startup when
no committed source audio remains, so an empty source can never replace a
previous transcript.
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
