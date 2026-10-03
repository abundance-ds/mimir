# Mimir agent interface

Authority for what agents can call. Internal dotted registry names do not
become public tools unless listed here.

## Discovery

```bash
mimir tools                    # grouped summary
mimir tools graph              # one family
mimir tools --json             # complete schemas
mimir tool graph_get           # one schema and call example
mimir call graph_status '{}'
mimir doctor
```

MCP initially advertises only `mimir_state`, `mimir_reveal`, and
`mimir_propose`; `mimir tools` discloses the rest.

## Public tools

Workbench:

```text
mimir_state  today_append  mimir_reveal  mimir_propose
comments_list  comments_add  comments_reply  comments_resolve
files_trash  agents_run  activities_snapshot
```

`today_append {text}` appends Markdown to the current day's scratchpad and
saves. Returns `{date, updatedAt, contextBefore, appended}`. `contextBefore`
is up to two preceding lines; `appended` is the exact inserted text. Read the
full scratchpad with `mimir_state.today`. After a timeout, read before
retrying: the append may have applied.

### Document targets and comments

`mimir_state {include_content: true}` reads the visible Editor and Today.
Its `active` document includes `documentId`, `revision`, and `saved`.
`mimir_state {target, include_content: true}` returns `{document}` for that
target without selecting a tab, changing the workspace, or reading Today.

A target is an absolute path, an open `documentId`, or `@editor`. Relative
paths resolve via the caller Activity's recorded workspace, then its working
directory. Without either, the visible workspace is used. Use an absolute path
for another workspace. `@editor` binds to
the active document at call start; use the returned path or `documentId` for
later calls.

`comments_list {target}` reads threads. `comments_add` and `comments_reply`
require `target`; `comments_resolve` accepts an optional `target`. List and
resolve default to `@editor`. Comment changes accept `expected_revision` from
the state read or a previous receipt. A mismatch stops the change. After a
timeout, read before retrying: the change may have applied.

Open documents use their current buffer, including unsaved text and hidden
tabs. Comment changes are undoable edits that follow autosave; they do not
force-save the user's draft. Closed documents use a checked disk write.
Receipts include `path`, `documentId`, the new `revision`, and `saved`;
`saved: false` means the change is in the buffer at receipt time.
Document IDs for open buffers are valid only while that document remains open.

The same tools work during review. No setup or extra review parameters are
required: use the file target, `anchor_text`, and `text`. The quote can come
from proposed text, original text, or the current comparison. If it identifies
more than one passage, quote more surrounding text. Reply and resolve use the
returned comment id as usual.

During review, `contentSource: "review"` identifies the review result. `saved`
reports whether discussion changes reached its saved record. A failed save
returns `saved: false` and `saveError`; read before repeating the mutation,
since the discussion remains in memory. State includes `review.id` and
`review.pendingChanges`; a content read also includes `review.original`.
Comment listings identify unattached quotations with `attachment`, and proposed
comment changes with `change` and `decision`.

Visible `mimir_state` also returns `view`: mode, side, selection, and visible
range. When requested, `view.content` is the clean displayed text; its offsets
refer to that text. A batch overview returns `view.documents` and no active
document; use a file path. History returns `readOnly: true` and
`contentSource: "history"`. `@editor` reads that snapshot and refuses comment
mutations. An explicit working file path still targets the working document.
[Comments](comments.md#discussions-in-a-review) owns review behavior and storage.

Graph Details requires Source before a comment change. Closed Graph sources
require their scope to be mounted and use the Graph writer. Scratchpad writes
retain the shared document's history and revision checks.

Graph:

```text
graph_find  graph_status  graph_get  graph_create  graph_update
graph_delete  graph_restore  graph_context  graph_events
graph_resource_add
```

`rel` aliases `relation` in create/update; `sourceRevision` aliases
`expectedRevision` in delete; canonical names take precedence.

`graph_get` returns authored `relations` and a separate read-only
`bodyReferences` object (outgoing references and backlinks). Do not copy
derived references into a relation patch. `graph_find` relation filters and
`graph_context` include body-derived connections. Context applies scope and
sensitive-content restrictions. [Business graph](business-graph.md#inline-links-and-backlinks)
owns Markdown syntax and editing behavior.

Time sheets: read the current entry, preserve row IDs and unknown properties,
replace `properties.entries` through `setProperties.entries` with the returned
revision. The update replaces the complete list. Re-read after a conflict.
[Time sheets](business-graph.md#time-sheets) owns the row format.

When Graph Details is active, `mimir_state` reports `kind: "graph"` and no
text cursor. `contentSource: "saved"` is the tab's saved Markdown snapshot;
`graphDraft` is the current Details fields. The snapshot can be older than disk
during a conflict. Reading state does not save the draft. `mimir_propose` or `mimir_reveal` with a text location saves the draft
and opens Source first. A save conflict stops the operation and keeps the draft.

Meetings:

```text
meetings_list  meetings_get  meetings_search  meetings_update  meetings_delete
```

Live meetings are read-only. Permanent deletion requires an explicit user
request, exact id, current reviewed title, and `audio` or `meeting` scope from
`meetings_get`.

Chat:

```text
chat_rooms  chat_read  chat_search  chat_send  chat_download
```

A chat-linked Activity defaults to its originating room. Agent messages retain
visible Activity provenance.

Connected providers add:

```text
gmail_search  gmail_read  gmail_send
calendar_calendars  calendar_list  calendar_freebusy  calendar_create
drive_search  drive_read
granola_search  granola_get
slack_search  slack_read  slack_send
```

Explicit user wording (“send,” “post,” “create”) authorizes a remote write.
Ask only when destination or content is missing. Apps, Routines, Settings,
shell, Tracker, and web search are not public tool families. Files expose only
recoverable `files_trash`; agents use their own shell for other file work.

## Connections

Discover setup with `mimir tools connections`; schemas own arguments.

- `connections_list`: accounts, methods, tools, prerequisites, pending IDs.
- `connections_connect` / `connections_check`: return IDs for
  `connections_operation`; poll or cancel. Receipts expire on restart or after
  the 64-receipt limit; operations time out after four minutes.
- `connections_set_default`: Google account selection.
- `connections_disconnect`: local removal, not provider revocation.

Pass credentials through `--stdin`; never read stored secrets or put them in
arguments, logs, or files. Failed validation preserves existing credentials.
Concurrent setup changes are rejected. Recheck GitHub status after cancellation:
its CLI may already have saved the login. Settings and agents share native
validation and Keychain storage. AI, Scribe, and Chat setup is separate.

| Provider | Setup |
|---|---|
| GitHub | Requires `git` and `gh`; shared CLI login. No Mimir token or data tools. Team setup is separate. |
| Google | Browser OAuth with a client ID; multiple accounts, default used when omitted. |
| Slack | Browser OAuth with a client ID, or personal `xoxp-` token; one connection. |
| Granola | Public API key; one connection. |

Checks verify identity or status but do not prove every capability.

## Skills

Resolution order: Project, Private, Team.

```text
<project>/skills/
~/.mimir/private/skills/
~/.mimir/team-graph/skills/
```

```bash
mimir skills
mimir skill release-review
mimir skill add ./release-review --project|--private|--team
```

Installed skill revisions are content-addressed (SHA-256 of package files) and
retained immutably; unrelated client skills and user-modified skills are
preserved. Malformed packages
remain in place and do not hide a valid lower-priority package. Claude and Pi
receive Project skills at launch; Codex and Gemini use `mimir skill` for
Project lookup. Private and Team skills are native in all four clients.

## Agent packages

An agent package is `agents/<name>/AGENT.md` in Project, Private, or Team
(same resolution order as skills). Frontmatter can set title, description,
preset, args, skills, and interactive mode. `@path` includes UTF-8 text from
the package; the assembled mission is limited to 512 KiB.

```bash
mimir agents
mimir agent add ./evidence-sweep --project|--private|--team
mimir run evidence-sweep --follow
```

Runs use the caller's directory and become durable Activities. `--follow`
streams a headless run to exit. A missing include or required skill fails the
selected package rather than falling back to another scope. Routines resolve
the latest mission when they fire.

Launcher injection and resume rules are in [agent-setup.md](agent-setup.md).
