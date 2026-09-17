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
Use **Ignore app** beside a suggestion to exclude that app from detection.
Scribe saves exclusions by app ID in its native configuration and applies them
after restart. **Scribe settings → Capture → Ignored apps → Allow detection**
removes an exclusion. Ignoring an app also removes its current suggestion and
notification; other apps and manual recording remain available.

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
- Transcription uses a selected local Whisper model or one explicit hosted
  endpoint. There is no hidden provider fallback.
- Stop ends capture at once and leaves the recording surface. Transcript tail
  processing continues in the background. **Meeting actions (⋯) → Resume
  recording** becomes available as soon as capture stops. It adds audio
  to the same meeting without waiting for transcription or summary work. The
  transcript becomes final only after all recording runs finish processing.
  Failed or partial transcripts remain recoverable; silence completes without
  invented content.
- Leaving a meeting never waits for note persistence or transcript finalization.
  The overview shows background progress. Pending edits stay retryable, and a
  failed Stop restores the visible recording controls.
- A user-written title cannot be replaced by automatic work.
- Preparation notes, Project, People, and scope stay editable before, during,
  and after capture, until filing.
- Recording opens the Notes tab. Notes and Transcript each use the full content
  width. Switching tabs retains the note selection, undo history, and each
  view's scroll position. Recording controls and failure notices stay visible
  above both views. Transcript updates do not change the selected tab.
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

The overview has one fixed toolbar: Search, Prepare, Record, and Settings.
Meetings appear directly below, grouped by date. The list updates from
Scribe events; **Retry** appears if loading fails. Model and
provider details belong in Settings. If recording needs setup, the Settings
button also shows **Setup**.

**Transcribe again** shows queued or running progress in the meeting and overview,
including when a transcript already exists. Repeat requests are disabled while it runs.

The Scribe flow is overview → details → overview. **Back** or **Escape** returns
to the overview and saves pending edits in the background. An open menu or
editor control can consume Escape first.

Open a completed meeting in Scribe and review its Summary. Set Project to a
project or **None**, check People and Scope, then click **File to Graph** in the
detail header. Mimir saves pending edits before filing. The button changes to
**View in Graph**, which opens the linked meeting record.

Project and People menus always offer **New project…** or **New person…**.
The action opens a small dialog with the search text in Name and the meeting's
scope in **Save in**. New person also offers an optional **Company** selector.
**Create and add** saves the person and its **works at** company relation directly
to Graph, then selects the person in the meeting. Projects are also saved
directly to Graph. These records do not wait for the meeting to be filed.
Creation errors retain the entered values for retry. Cancel closes the dialog
without creating a record. Notes and recording stay in place.

After filing, Scribe shows the current Graph title, context, and summary.
**In Graph · Team**, for example, shows where the record is stored. Use **View
in Graph** to edit those saved values. Notes and transcript remain in Scribe.
Use **Meeting actions (⋯) → Resume recording** to add audio to the same meeting. It also works while transcription
is in progress or needs repair. An existing summary remains readable and is
marked for an update after more recording. Editing it after transcription or
generating a new summary clears that notice.

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
audio. A stopped meeting can be deleted while transcription, summary work,
or note saving is in progress. The deletion request is saved immediately;
late results and saves cannot restore the meeting. File cleanup waits for
workers to release their files and resumes after restart if needed. This also
works for a prepared meeting when the call did not occur. A filed Graph record
and explicit exports remain separate records.

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
- OpenAI Realtime uses separate microphone and system sockets. Other endpoints
  use the versioned `mimir.stt.v1` protocol.
- Follow-up jobs use exact argv, immutable bounded inputs, leased durable rows,
  and schema-validated output inside the meeting directory.
- Notes and transcript are untrusted data. They are never interpolated into a
  command or treated as authority for deletion or Graph mutation.
- Summary format, prompt, and agent are frozen into each job. Failures remain
  retryable and do not turn a completed recording into a capture failure.
- Permanent deletion is visible at the durable tombstone boundary. The meeting
  disappears at once. Native transcription workers and running follow-ups
  release their files in the background before private file and database
  cleanup completes. Renderer updates exclude pending and accepted deletions,
  including late save responses, search results, and older library pages.

### Local models

Scribe uses OpenAI Whisper through `whisper.cpp` with Metal. In
**Settings → Scribe → Transcription**, **Download** installs a model, **Use**
selects it for new recordings, and **Remove** deletes it. Downloads do not change
the selection. Active recordings retain their model. Removing the selected
model requires a download or another selection before recording.

`src-tauri/resources/meeting-models.json` owns the catalog, pinned revisions,
sizes, and checksums. Models download to `~/.mimir/models/stt/` on user action
and are never bundled. Existing Small downloads remain usable.

## Summary prompts and context

`src-tauri/resources/meeting-summary-prompts.json` owns the built-in prompts
for the renderer and native service. Former built-in defaults migrate to the
selected format; custom prompts and queued instructions remain unchanged.
The summary dialog loads the saved prompt when opened. Selecting the saved
format uses its custom prompt; other formats use their built-in prompts.

Each summary job reads the transcript and user notes. Its prompt includes a
context block, saved as `meeting-context.json` for retries. The block contains
`TITLE`, `YOU`, `THEM: [names]`, and `PROJECT`. Names come
from the selected Graph records. The configured Graph **You** person is excluded
from `THEM`. Filed meetings use their current Graph title and relations;
unfiled meetings use their Scribe selections. Retries reuse the saved context;
a new generation reads the current selections. Missing selected records report
an error instead of silently omitting names. `Them` and `Others` refer to the
`THEM` list; multiple names identify the group, not each voice.

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
