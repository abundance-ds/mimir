# Mimir agent interface

This file is the authority for what agents can call. Internal dotted registry
names do not become public tools unless listed here.

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
`mimir_propose`; `mimir tools` progressively discloses the rest.

## Public tools

Workbench:

```text
mimir_state  today_append  mimir_reveal  mimir_propose
comments_list  comments_add  comments_reply  comments_resolve
files_trash  agents_run  activities_snapshot
```

`today_append {text}` appends Markdown to the current local day's scratchpad
and saves it. Returns `{date, updatedAt, contextBefore, appended}`.
`contextBefore` contains up to two preceding lines, without trailing blank lines;
`appended` is the exact inserted text, including the separator.
The receipt confirms the saved change.
Read the full scratchpad with `mimir_state.today`.
After a timeout or save error, read before retrying: the append may have applied.

Graph:

```text
graph_find  graph_status  graph_get  graph_create  graph_update
graph_delete  graph_restore  graph_context  graph_events
graph_resource_add
```

Meetings:

```text
meetings_list  meetings_get  meetings_search  meetings_update  meetings_delete
```

Live meetings are read-only. Agents cannot start, mute, stop, grant capture
permission, manage credentials/models, or export. Permanent deletion requires
an explicit user request, exact id, current reviewed title, and `audio` or
`meeting` scope from `meetings_get`.

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

Explicit user wording such as “send,” “post,” or “create” authorizes that
remote write. Ask only when destination or content is missing. Apps, Routines,
Settings, shell, Tracker, and web search are not public tool families. Files
expose only recoverable `files_trash`; agents use their own shell for ordinary
filesystem work.

## Connections

Connections are managed in Settings and update the live tool catalog without a
restart.

- GitHub uses installed `git` and the shared GitHub CLI login. It adds no agent
  tools, and Mimir never reads or stores its token.
- Google uses browser OAuth and can hold several accounts. Tool calls accept an
  optional account email; omission selects the marked default.
- Slack accepts a verified personal `xoxp-` token.
- Granola accepts its supported public API key.
- Mimir stores its provider credentials in the OS keychain. Agents cannot call
  credential or connection-management commands.

## Skills

Resolution order is Project, Private, then Team:

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

Mimir projects content-addressed retained revisions and preserves unrelated
client skills. Malformed packages remain in place and do not hide a valid
lower-priority package. Claude and Pi receive Project skills at launch; Codex
and Gemini use `mimir skill` for Project lookup. Private and Team skills are
native in all four clients.

## Agent packages

An agent package is `agents/<name>/AGENT.md` in Project, Private, or Team, with
the same resolution order as skills. Frontmatter can set title, description,
preset, args, skills, and interactive mode. `@path` includes UTF-8 text from the
package; the complete assembled mission is limited to 512 KiB.

```bash
mimir agents
mimir agent add ./evidence-sweep --project|--private|--team
mimir run evidence-sweep --follow
```

Runs use the caller's directory and become durable Activities. Interactive mode
opens a live session; `--follow` streams a headless run to exit. A selected
package with a missing include or required skill fails rather than falling back
to another scope. Routines can name an agent package and resolve its latest
mission when they fire.

Launcher injection and resume rules are in [agent-setup.md](agent-setup.md).
