# Scribe meetings

Status: not ready. Local capture and transcription have signed-build evidence.
Hosted live audio-to-transcript and interrupted-recording recovery still need
signed end-to-end evidence.

Scribe is a local-first meeting recorder. The user starts recording; detection
can only suggest it. On macOS, a detection notification offers **RECORD**. That
explicit action opens Scribe and uses the normal permission, consent, and
candidate-validation path. Clicking the banner body opens Scribe without
starting capture. macOS responses use a retained callback delegate; ignored
notifications create no waiting worker or repeated notification-list scan.
Detection end, dismissal, disabling detection, and shutdown remove the owned
notification. A late delivery is removed again when its submission completes.
Each detection occurrence has a distinct opaque candidate id, carried through
the notification queue and native consent/start checks. A stale suggestion or
queued RECORD request cannot start a later call from the same app. Microphone
use by another app is the detection signal, so a call with its microphone off
is not visible to Scribe. Detection polls while enabled and does not require a
routine app restart. Detection replaces listeners after microphone device
changes, retries failed registration, and clears errors after recovery.
Microphone and system audio remain separate durable 16 kHz mono tracks.
Transcription follows committed audio and never blocks the capture callback.

## Product contract

- Only one meeting records at a time. A workbench control always exposes time,
  microphone mute, and Stop while recording.
- Mute writes aligned microphone silence; there is no pause state.
- Transcription uses the managed local Whisper model or one explicit hosted
  endpoint. There is no hidden provider fallback.
- Stop ends capture at once and leaves the recording surface. Transcript tail
  processing continues in the background and produces one terminal transcript.
  Failed or partial transcripts remain recoverable; silence completes without
  invented content.
- Leaving a meeting never waits for note persistence or transcript finalization.
  The overview shows background progress. Pending edits stay retryable, and a
  failed Stop restores the visible recording controls.
- A user-written title cannot be replaced by automatic work.
- Preparation notes, Project, People, and scope stay editable before, during,
  and after capture, until filing.
- Summary generation is a durable CLI Activity. **Ask agent** is a separate
  interactive Activity.
- Scribe owns preparation, notes, audio, transcript, and summary generation.
  Filing creates one Graph meeting with the reviewed summary and stable Scribe
  id. Graph owns that saved summary; the transcript stays in Scribe.

## File a summary to Graph

Scribe is the meeting workspace. Its overview and search show only meetings
that have no Graph record. **Load older meetings** extends the overview.
Filed meetings are available in Graph through its **Meetings** kind filter.
Filing removes a meeting from the Scribe overview without deleting its source.

The Scribe flow is overview → details → overview. **Back** or **Escape** returns
to the overview and saves pending edits in the background. An open menu or
editor control can consume Escape first.

Open a completed meeting in Scribe and review its Summary. Set Project to a
project or **None**, check People and Scope, then click **File to Graph** in the
detail header. Mimir saves pending edits before filing. The button changes to
**View in Graph**, which opens the linked meeting record.

After filing, Scribe shows the current Graph title, context, and summary.
**In Graph · Team**, for example, shows where the record is stored. Use **View
in Graph** to edit those saved values. Notes and transcript remain in Scribe.
Use **Meeting actions → Continue recording** to add another recording to the
same completed meeting.

Graph keeps the stable source meeting id. Its **Transcript → Open in Scribe**
action opens that meeting's Transcript tab, including meetings outside the
recent library page. The meeting menu provides **Show in Finder** and **Save
audio copy** for retained audio. Transcript and audio stay local to Scribe;
filing does not copy them to Team or delete them. Audio still follows the
configured retention period. The transcript remains until explicit deletion.

**Regenerate** creates a replacement draft. **Review draft** opens it for
review and editing; **View current** returns to the saved Graph summary.
**Update in Graph** replaces the saved summary. **Keep current** discards the
offer to replace it. Generation never changes the Graph summary on its own.
A saved hash identifies the last reviewed Scribe summary, so separate Graph
edits do not make an old summary appear as a new draft. A conflicting Graph
save keeps the draft available for review after **Reload**.

## Delete a meeting

Use the visible **Meeting actions (⋯)** button in the overview or detail view,
then **Delete**. Right-click on an overview row also opens this menu. Confirm
**Delete meeting** to remove the Scribe meeting, transcript, summary, and owned
audio. This also works for a prepared meeting when the call did not occur.
A filed Graph record and explicit exports remain separate records.

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
- App exit explicitly stops detection and maintenance. Repeated shutdown calls
  wait for completion and return the same cleanup result. Exit logs failures.
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
- Permanent deletion is visible at the durable tombstone boundary. The meeting
  disappears at once. An already running follow-up can release its process
  lease in the background before private file and database cleanup completes.

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
