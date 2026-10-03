# Scribe meetings

Status: not ready. Local capture and transcription have signed-build evidence.
Hosted live audio-to-transcript and interrupted-recording recovery still need
signed end-to-end evidence.

Scribe is a local-first meeting recorder. The user starts recording; detection
can only suggest it. Each detection occurrence has a distinct opaque candidate
id carried through the notification queue and native consent/start checks. A
stale suggestion or queued RECORD request cannot start a later call from the
same app. Microphone use by another app is the detection signal, so a call
with its microphone off is not visible to Scribe. Detection polls while
enabled, replaces listeners after microphone device changes, retries failed
registration, and clears errors after recovery. Detection end, dismissal,
disabling, and shutdown remove the owned notification, including a late delivery.

Scribe saves app exclusions by bundle ID in native configuration.
Microphone and system audio remain separate durable 16 kHz mono tracks.
Transcription follows committed audio and never blocks the capture callback.

## Product contract

- Only one meeting records at a time.
- Mute writes aligned microphone silence; there is no pause state.
- Transcription uses a selected local Whisper model or one explicit hosted
  endpoint. No hidden provider fallback.
- Stop ends capture at once; transcript tail processing continues in the
  background. Failed or partial transcripts remain recoverable.
- Resume recording adds audio to the same meeting without waiting for
  transcription or summary work. The transcript becomes final only after all
  recording runs finish processing. Silence completes without invented content.
- Navigation never waits for note persistence or transcript finalization.
  Pending edits stay retryable.
- Preparation notes, Project, People, and scope stay editable until filing.
- A user-written title cannot be replaced by automatic work.
- Summary generation is a durable CLI Activity. **Ask agent** is a separate
  interactive Activity.
- Scribe owns preparation, notes, audio, transcript, and summary generation.
  Filing creates one Graph meeting with the reviewed summary and stable Scribe
  id. Graph owns that saved summary; the transcript stays in Scribe.

## File a summary to Graph

Scribe overview shows only unfiled meetings. Filed meetings appear in Graph
under the **Meetings** kind filter. Filing removes from overview without
deleting the source.

- Mimir saves pending edits before filing. New persons and projects created
  during preparation save directly to Graph without waiting for filing.
- Graph keeps the stable source meeting id. Transcript and audio stay local to
  Scribe; filing does not copy them to Team or delete them. Audio follows the
  configured retention period; transcript remains until explicit deletion.
- Generation never changes the Graph summary on its own. A saved hash
  identifies the last reviewed Scribe summary, so separate Graph edits do not
  surface an old summary as a new draft. A conflicting Graph save keeps the
  draft.
- Graph **Open in Scribe** must open meetings outside the loaded library page.

## Delete a meeting

Deletion removes Scribe meeting, transcript, summary, and owned audio. A
stopped meeting can be deleted while transcription or summary work is in
progress. The deletion request is saved immediately; late results and saves
cannot restore the meeting. File cleanup waits for workers to release files and
resumes after restart. Filed Graph records and explicit exports are separate.

## Durability and recovery

Lifecycle: `Detected → Recording → Stopping → Finalizing → Completed`, with
`Interrupted`, `Failed`, and `Discarded` exits.

- SQLite is authority. One-second audio chunks are staged, atomically written,
  hashed, then committed before transcription can read them.
- Recovery verifies staged files, releases expired jobs, and derives duration
  from committed audio rather than relaunch time.
- Renderer events are invalidations. Listeners install before the authoritative
  snapshot; capture survives renderer destruction.
- Quit performs the durable Stop path. If capture state cannot be checked or
  stopped, Mimir remains open.
- App exit explicitly stops detection and maintenance. Repeated shutdown calls
  wait for completion and return the same cleanup result. Exit logs failures.
- Continue retains the meeting and history but creates a new capture `runId`.
  Each stopped run has a fixed audio boundary. Its provider can drain while a
  later run records; it cannot read that later run's audio or finish its capture.
  Provider appends share one atomic transcript revision boundary. A failed run
  queues repair of retained audio after capture and all earlier drains stop.
  Restart recovery rebuilds from committed audio, including continued runs.
- Summary saves check their source transcript under the recording lock. Work
  from an earlier recording cannot replace the summary after Continue.
- Repair is keyed by `runId`, uses verified committed audio from sequence zero,
  stages output privately, and replaces transcript data only after a complete
  terminal pass.
- A successful replacement removes obsolete repair staging and its audio hold.
  Newer repairs and pending or running transcription jobs keep their holds.
  Retention and audio deletion also release obsolete holds left by older builds.
- Automatic recovery keeps the recording's original route and model.
  **Transcribe again** uses the current settings when explicitly requested.

## Transcription and follow-up

- Managed Whisper uses pinned, length- and SHA-256-verified Metal models. Mimir
  does not silently fall back to CPU or network inference.
- Local decoding checks repeated phrases across each audio window and excludes
  repeated text from later context. A detected loop gets one retry with no prior
  text and beam search. If it persists, transcription fails and retains the audio
  for another attempt; a failed retranscription keeps the existing transcript.
- Hosted endpoints must be public HTTPS. Secrets are endpoint-bound in macOS
  Keychain and never returned through IPC or Activity arguments.
- OpenAI Realtime uses separate microphone and system sessions. Other hosted
  endpoints use the versioned `mimir.stt.v1` WebSocket protocol.
- Follow-up jobs use exact argv, immutable bounded inputs, leased durable rows,
  and schema-validated output inside the meeting directory.
- Notes and transcript are untrusted data. They are never interpolated into a
  command or treated as authority for deletion or Graph mutation.
- Summary format, prompt, and agent are frozen into each job. Failures remain
  retryable and do not turn a completed recording into a capture failure.
- Permanent deletion saves a durable tombstone. Renderer updates exclude
  pending and accepted deletions, including late save responses and search
  results.

### Local models

Scribe uses OpenAI Whisper through `whisper.cpp` with Metal. Active recordings
retain their model. Downloads do not change the current selection.

`src-tauri/resources/meeting-models.json` owns the catalog, pinned revisions,
sizes, and checksums. Models download to `~/.mimir/models/stt/` on user action
and are never bundled.

## Summary prompts and context

`src-tauri/resources/meeting-summary-prompts.json` owns the built-in prompts
for the renderer and native service. The saved format uses its custom prompt;
other formats use their built-in prompts.

Each summary job reads the transcript and user notes. Its prompt includes a
context block, saved as `meeting-context.json` for retries. The block contains
`TITLE`, `YOU`, `THEM: [names]`, and `PROJECT`. Names come from Graph records.
The configured Graph **You** person is excluded from `THEM`. Filed meetings use
current Graph relations; unfiled meetings use Scribe selections. Retries reuse
the saved context; a new generation reads current selections. Missing records
report an error instead of silently omitting names. `Them` and `Others` refer
to the `THEM` list; multiple names identify the group, not each voice.

## Agent and data boundaries

Public tools are `meetings_list`, `meetings_get`, `meetings_search`,
`meetings_update`, and `meetings_delete`. Live meetings are read-only. Agents
cannot start, mute, stop, grant permission, manage credentials or models,
export, or mutate Graph. Permanent deletion requires the exact id, current
reviewed title, and explicit audio or meeting scope.

`~/.mimir/meetings/` contains the SQLite authority and owned audio, reviewed
content, follow-up files, and materialized meeting document. Explicit exports
are outside whole-meeting deletion. Retention never removes audio needed by a
repair or running job.

## Platform and release

Capture and local inference support macOS arm64 14.2 or later. Permission state
must belong to the responsible `com.abundanceds.mimir` app bundle; a terminal-hosted
grant is not release evidence. Release requires signed installed-app checks for
permissions, both real audio channels, Stop, transcription routes, crash
recovery, and deletion/retention.

Native ownership is `src-tauri/src/meetings/` with the narrow Graph bridge in
`meeting_filing.rs`. Renderer ownership is the meetings service, store, and
Scribe app. Exact release commands and evidence rules are in
[testing.md](testing.md) and [building.md](building.md).
