# Scribe meetings

Status: not ready. Local capture and transcription have signed-build evidence.
Hosted live audio-to-transcript and interrupted-recording recovery still need
signed end-to-end evidence.

Scribe is a local-first meeting recorder. The user starts recording; detection
can only suggest it. Microphone and system audio remain separate durable
16 kHz mono tracks. Transcription follows committed audio and never blocks the
capture callback.

## Product contract

- Only one meeting records at a time. A workbench control always exposes time,
  microphone mute, and Stop while recording.
- Mute writes aligned microphone silence; there is no pause state.
- Transcription uses the managed local Whisper model or one explicit hosted
  endpoint. There is no hidden provider fallback.
- Stop drains capture and produces one terminal transcript. Failed or partial
  transcripts remain recoverable; silence completes without invented content.
- A user-written title cannot be replaced by automatic work.
- Preparation notes, Project, People, and scope stay editable before, during,
  and after capture.
- Summary generation is a durable CLI Activity. **Ask agent** is a separate
  interactive Activity.
- Scribe owns notes, audio, transcript, and summary. Filing creates one Graph
  meeting with the summary and stable Scribe id; the transcript stays in Scribe.

## Durability and recovery

Lifecycle: `Created → Recording → Stopping → Finalizing → Completed`, with
honest `Interrupted` and `Failed` exits.

- SQLite is authority. One-second audio chunks are staged, atomically written,
  hashed, then committed before transcription can read them.
- Recovery verifies staged files, releases expired jobs, and derives duration
  from committed audio rather than relaunch time.
- Renderer events are invalidations. Listeners install before the authoritative
  snapshot; capture survives renderer destruction.
- Quit performs the durable Stop path. If capture state cannot be checked or
  stopped, Mimir remains open.
- Continue retains the meeting and history but creates a new capture `runId`.
- Repair is keyed by `runId`, uses verified committed audio from sequence zero,
  stages output privately, and replaces transcript data only after a complete
  terminal pass.
- Recovery and retranscription use the route and model authorized for that
  recording. Settings changes cannot redirect retained audio.

## Transcription and follow-up

- Managed Whisper is a pinned, length- and SHA-256-verified Metal model. Mimir
  does not silently fall back to CPU or network inference.
- Hosted endpoints must be public HTTPS. Secrets are endpoint-bound in macOS
  Keychain and never returned through IPC or Activity arguments.
- OpenAI Realtime uses separate microphone and system sockets. Other endpoints
  use the versioned `mimir.stt.v1` protocol.
- Follow-up jobs use exact argv, immutable bounded inputs, leased durable rows,
  and schema-validated output inside the meeting directory.
- Notes and transcript are untrusted data. They are never interpolated into a
  command or treated as authority for deletion or Graph mutation.
- Summary format, prompt, and agent are frozen into each job. Failures remain
  retryable and do not turn a completed recording into a capture failure.

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
must belong to the responsible `rs.shoulde.mimir` app bundle; a terminal-hosted
grant is not release evidence. Release requires signed installed-app checks for
permissions, both real audio channels, Stop, transcription routes, crash
recovery, and deletion/retention.

Native ownership is `src-tauri/src/meetings/` with the narrow Graph bridge in
`meeting_filing.rs`. Renderer ownership is the meetings service, store, and
Scribe app. Exact release commands and evidence rules are in
[testing.md](testing.md) and [building.md](building.md).
