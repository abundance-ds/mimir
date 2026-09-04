---
name: mimir
description: Mimir is a desktop app for AI-native business. It runs CLI agents beside a Markdown editor, over a business graph, with Scribe meeting notes, team chat, and Google and Slack connections. Use when no more specific mimir-* skill fits, or when a request about Mimir is unclear.
---

# Mimir

## Parts

- Editor: the Markdown file the user is viewing. `mimir_state` reads it. `mimir_propose` offers a reviewed diff; it never writes the file.
- Today: the user's scratchpad for today's top of mind. Read it in `mimir_state.today`. Not the graph Journal.
- Files: shell operations, reconciled into the editor. `files_trash` is the only delete; never `rm` workspace files.
- Graph: the business knowledge layer. Projects, issues, decisions, people, companies, notes, resources, journal. Skill `mimir-graph`.
- Scribe: meeting recordings, transcripts, summaries. Skill `mimir-meetings`.
- Chat: team rooms and DMs. A session started from a room replies there by default.
- Connections: Google (Gmail, Calendar, Drive) and Slack. Tools exist only when connected.
- Activities: CLI agents and terminals with scrollback and resume. `agents_run` starts an agent package; `activities_snapshot` follows it.
- Routines: scheduled agent or command runs. Tracker: the user's desktop activity timeline. No agent tools for either.
- Config: settings, launchers, routines, apps, skills. Skill `mimir-config`.

## Tools

`mimir tools` lists what is callable now. `mimir tools <group>` shows one group.
`mimir tool <name>` shows inputs. `mimir call <tool> '<json>'` calls.
MCP advertises `mimir_state`, `mimir_reveal`, and `mimir_propose` directly.

```text
Core         mimir_state mimir_reveal mimir_propose comments_list comments_add
             comments_reply comments_resolve files_trash agents_run activities_snapshot
Graph        graph_find graph_status graph_get graph_create graph_update graph_delete
             graph_restore graph_context graph_events graph_resource_add
Meetings     meetings_list meetings_get meetings_search meetings_update meetings_delete
Chat         chat_rooms chat_read chat_search chat_send chat_download
Connections  gmail_search gmail_read gmail_send calendar_calendars calendar_list
             calendar_freebusy calendar_create drive_search drive_read
             slack_search slack_read slack_send
```

## Graph

- Find before get. Never guess an id. Use tools, never the Markdown files.
- Scopes are private, project, team. Without `scopeId`, normal kinds go to Team and journal goes to Private.
- Update or delete with `expectedRevision` from `graph_get.sourceRevision`. Delete returns an undo token.

## Meetings

- List or search first, then `meetings_get`. Use `last_minutes` for a live transcript.
- Recording, mute, and stop are human-only. Live meetings are read-only.
- Delete is permanent. It needs an explicit user request and the exact current title.

## Config

- Sources: `~/.mimir/{settings.json,launchers.json,routines,apps}` plus scoped `graph/`, `skills/`, `agents/`.
- Project is the repo root. Private is `~/.mimir/private/`. Team is `~/.mimir/team-graph/`.
- Preserve unrelated JSON keys. Never change the Team root or run Git there.
