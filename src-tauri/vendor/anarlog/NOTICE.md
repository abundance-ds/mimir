# Anarlog provenance and reuse boundary

This directory records a source audit of
[`fastrepl/anarlog`](https://github.com/fastrepl/anarlog) at the immutable
commit in [`UPSTREAM`](UPSTREAM). It does **not** currently contain Anarlog
implementation code and it is not part of Mimir's Cargo graph.

Anarlog's repository is MIT licensed. The preserved upstream license is in
[`LICENSE`](LICENSE); its copyright and permission notice must remain with
every copied file or substantial portion. Future imported files must also
carry a short origin comment containing the upstream URL and commit, while
Mimir-specific modifications remain identifiable in review history.

The exact audited source files and their raw-content SHA-256 values are in
[`import-manifest.tsv`](import-manifest.tsv). Dispositions mean:

- `candidate`: the narrowest next code/test extraction candidate.
- `adapt`: useful behavior, but it must enter through a Mimir-owned interface
  and satisfy the stated redesign requirements before it can ship.
- `reference`: use its state model, test cases, or failure semantics as design
  input; do not copy the file wholesale.
- `reject`: known to violate Mimir's architecture, safety model, or product
  boundary when used unchanged.
- `legal-hold`: do not copy or distribute until dependency/model provenance
  and license obligations have been reviewed and recorded.

## Audited boundary

The audit intentionally stops at source provenance. It does not authorize
copying the Anarlog workspace, database, React UI, Tauri plugins, hosted
services, cloud proxies, telemetry, agent stack, or provider catalog.
Anarlog is a large Rust/Tauri monorepo: at the pinned commit the focused
`listener-core` dependency closure alone resolves roughly 350 normal
dependency nodes, while `audio-actual` resolves roughly 140. Mimir should
extract small, independently tested behavior into Mimir-owned crates instead
of depending on the upstream workspace.

The pinned commit is 140 commits after the latest audited desktop tag
`desktop_v1.3.11`. Across the meeting-related paths, that delta changes 147
files by about 10,000 insertions and 1,500 deletions. Treat the pin as an
audited snapshot, not a stable upstream library API.

Focused tests run against the pin on Apple Silicon macOS:

- `cargo test -p transcript -p hooks --lib`: 81 passed.
- `cargo test -p audio-actual --lib`: 18 passed, 3 hardware tests ignored.
- `cargo test -p detect --lib`: 70 passed; these are primarily pure
  Accessibility-tree tests, not signed-package/hardware validation.

Passing unit tests do not close the hardware, permission, lifecycle, recovery,
or distribution gates described below.

## Exact reuse decisions

### Extract first: deterministic transcript core

The first candidate is the provider-neutral portion of `crates/transcript`:
word assembly/stitching, channel state, deltas, segments, speaker assignment,
rendering, and their tests. Preserve the tests and replace Anarlog protocol
types at a thin adapter boundary.

Do not import `postprocessor.rs`. It pulls in Anarlog's template system and
JSON-patch prompting. Split it from the deterministic transcript core; Mimir's
existing Activities and AI boundary should own any correction or summary job.

### Adapt next: raw dual-channel macOS capture

The useful capture seam is `CaptureConfig`, `CaptureFrame`, `CaptureStream`,
and `AudioProvider`, followed by the realtime ring buffer, microphone capture,
Core Audio process tap, resampling, join/alignment, and cancellation code.
Mimir must preserve raw microphone and raw system tracks as the recoverable
source of truth. AEC/VAD output is a derived live-transcription stream.

Do not reproduce Anarlog's current recorder routing: its source pipeline calls
`preferred_mic()`, applies VAD masking, and sends that processed track to the
recorder. The recorder also performs synchronous per-sample WAV writes from an
actor mailbox and later converts the file to MP3. Mimir needs a bounded writer
queue, visible overflow/corruption state, chunk-level recovery metadata, and
an atomic finalization path.

The macOS system-audio implementation uses Core Audio process taps. Apple
requires macOS 14.2 or newer, `NSAudioCaptureUsageDescription`, and a system
audio recording permission prompt. Mimir currently declares neither a macOS
minimum nor the audio usage keys/entitlement. Signed and notarized artifact
tests are a release gate, not a post-merge manual check.

### Adapt selectively: meeting evidence and timers

The useful detection pieces are the per-process Core Audio app snapshot,
debounced state transitions, configurable notification delay/cooldown, and
their paused-time tests. Parameterize Mimir's own bundle identity and model
detection as evidence with confidence, not `microphone active == meeting`.

Reject the macOS detector lifecycle unchanged. It spawns a permanently parked
listener thread and a second infinite polling thread, leaks callback data so
Core Audio can keep using it, never unregisters listeners, and its `stop`
drops a Tokio join handle without awaiting termination. The Windows detector
is a no-op. The Accessibility meeting/chat scanner and English Zoom menu
heuristics are brittle, permission-heavy, and outside the initial capture
boundary.

### Adapt narrowly: transcription protocols/providers

The `owhisper-interface` word/batch/stream shapes and the deterministic batch
accumulator are useful adapters, but the upstream file itself calls part of
the shape a legacy database format. Mimir must define its own canonical word,
segment, provider-attempt, and transcript-revision records.

Do not import `owhisper-client` wholesale. It contains a broad provider
catalog and Anarlog-specific dependencies. If an OpenAI-compatible provider is
selected, extract only that adapter behind a Mimir-owned provider trait with
typed errors, cancellation, timeouts, idempotency, secret redaction, and
bounded upload/response handling.

### Reference only: session supervision and persistence

The single-active-session guard, active/finalizing snapshots, degraded
record-only fallback, listener retry schedule, source/recorder supervision,
short replay buffer, and batch-finalization semantics are good behavior
references. Do not introduce `ractor`, Sentry scope mutation, Anarlog storage,
or provider-specific local models through `listener-core`.

The Anarlog canonical session/transcript/participant/action-item schema is a
useful domain checklist but is entangled with Anarlog CloudSync/E2EE and does
not model Mimir's durable post-processing jobs. Mimir owns its migrations and
must persist explicit capture attempts, raw artifacts, transcript revisions,
provider attempts, finalization state, and post-processing jobs.

### Reject unchanged: hooks

Anarlog hooks store a command as one string, expand environment variables,
split on whitespace, run all hooks concurrently, capture unbounded output, and
kill after five seconds. The desktop starts the after-stop hook as an
unawaited UI promise, not after durable transcript finalization. This violates
Mimir's exact-argv execution contract and is unsuitable for CLI agents.

Post-meeting work must be a durable Mimir job emitted only after the canonical
audio/transcript transaction commits. It should launch existing Activities or
Routines with an argv array, explicit context artifact, idempotency key,
status, retry/cancel policy, output cap, audit trail, and a clear partial
failure state.

## Dependency and license hazards

The root MIT license does not relicense third-party crates, model weights,
codecs, Swift packages, or hosted services.

- `listener-core` encodes MP3 through `mp3lame-encoder`/`mp3lame-sys`.
  The encoder declares LGPL-3.0 and the sys crate builds LAME. Do not ship this
  path without a distribution/compliance decision; a recoverable PCM or other
  approved format is preferable for the canonical recording.
- `transcribe-soniqo` pins `speech-swift` 0.0.22 (Apache-2.0), then rewrites
  its checkout's declared macOS platform from 15.0 to 14.2 during the build.
  That patch, the Swift/Metal toolchain, and every model weight require an
  independent compatibility and license review.
- The streaming Parakeet CoreML repository reports a nonstandard/“other”
  license derived from NVIDIA's model terms. The batch Parakeet CoreML
  repository reports CC-BY-4.0. Neither model may be bundled until its exact
  revision, terms, notices, attribution UX, download integrity, and removal
  procedure are recorded.
- The checked-in AEC and Silero VAD ONNX files have no model-specific license
  record beside this reuse boundary. They remain `legal-hold` even though the
  surrounding Anarlog code is MIT.
- Apple `SpeechAnalyzer` is a macOS 26-era optional backend, not Mimir's
  baseline local transcription implementation.
- Anarlog's legacy Whisper path is disabled in its current desktop defaults
  and pins a Codeberg fork/revision. It is design evidence, not an approved
  local backend.

Before any legal-hold entry changes disposition, add the third party's exact
source URL, immutable revision, license text, notices/attribution, artifact
SHA-256, and distribution decision to this directory.

## Import and resync procedure

1. Clone the canonical repository without modifying Mimir and check out the
   exact commit from `UPSTREAM` in detached mode.
2. Run `scripts/verify-anarlog-provenance.sh /path/to/anarlog`. The verifier is
   read-only and checks the commit, every manifest hash, and this preserved
   license.
3. Select only `candidate` entries for the current vertical slice. Any `adapt`
   entry first needs a Mimir-owned interface and red Gherkin-derived tests.
4. Copy the minimum source and tests into a new Mimir-owned crate. Add an
   origin comment with repository, commit, upstream path, MIT copyright, and
   a pointer to this directory. Keep semantic changes in reviewable commits.
5. Replace Anarlog-specific protocols, storage, telemetry, UI events, secrets,
   and provider selection at the boundary; do not copy outward dependencies
   merely to make the imported file compile.
6. Run the focused unit/property tests, simulated failure tests, hardware/TCC
   matrix, crash-recovery tests, and signed/notarized package tests before
   changing any feature flag to on.
7. For a future upstream resync, add a second audited commit rather than
   silently changing `UPSTREAM`. Review `git log` and a path-limited diff from
   the old pin, re-run dependency/license inventory, regenerate hashes, and
   port changes manually into Mimir. Never overwrite Mimir-owned changes with
   a subtree update.

The manifest is an allowlist for review, not a command to bulk copy files.
