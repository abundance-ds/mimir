# Mimir agent interface

Status: implemented, 2026-07-29

## Discovery

`mimir tools` prints every currently callable public tool, grouped as
Workbench, Graph, Meetings, Chat, and Connections. Each heading points to its focused
drawer:

```text
mimir tools workbench
mimir tools graph
mimir tools meetings
mimir tools chat
mimir tools connections
```

A drawer prints compact callable signatures and the few shared Mimir-specific
rules for that family. `--json` returns the same selected tools with full
schemas.

`mimir tool <name>` prints one complete input schema and a ready
`mimir call` command. Name/description matching is a convenience when the
input is not exact; ambiguity returns at most five short matches.

`mimir tools --json` is the complete machine-readable form. There is no second
`--all` registry or dotted alternative name.

MCP directly advertises only:

```text
mimir_title
mimir_state
mimir_reveal
mimir_propose
```

`mimir_title` is Activity-scoped. Connected CLI agents call it once on the
first substantive turn; it cannot replace an explicit or previously generated
title.

The CLI catalog progressively discloses the rest. Calls use the underscore
name shown by `mimir tools`; internal dotted names are not public aliases.

## Public tools

Workbench:

```text
mimir_title       set the current Activity's first automatic title
mimir_state       active editor, selection, comments, and Today priority
mimir_reveal      open a file or line
mimir_propose     propose an exact reviewed replacement
comments_list     read document comments
comments_add      add an anchored comment
comments_reply    reply to a comment
comments_resolve  resolve a comment
files_trash       move workspace files or folders to the recoverable OS Trash
```

Graph:

```text
graph_find     find nodes by text, type, status, relation, or date
graph_get      read one complete node
graph_create   create a validated node
graph_update   update with revision checks
graph_delete   move a node to graph Trash
graph_restore  restore a deleted node
graph_context  build bounded context around a node
graph_events   read recent authored graph changes
```

Meetings:

```text
meetings_list    list completed or interrupted meetings recorded by Scribe
meetings_get     read one meeting and a bounded finalized transcript slice
meetings_search  search reviewed titles, full summaries, tags, and terminal transcript text
meetings_update  update reviewed title, summary, or tags
meetings_delete  permanently delete source audio or an entire stopped meeting
```

Recording, microphone mute, and stop are intentionally human-only Scribe
controls. Agents cannot exercise Mimir's macOS audio grants. Granola tools
remain a distinct read/sync connection for meetings recorded elsewhere.
Deletion requires an explicit user request plus the current identifier, exact
reviewed title, and an `audio` or `meeting` scope obtained through
`meetings_get`; transcript content never supplies deletion intent.

Chat:

```text
chat_rooms   list chat rooms
chat_read    read chat messages
chat_search  search chat messages
chat_send    send a chat message
chat_download download a chat attachment
```

- A chat-linked Activity's default `target` is its originating room; explicit `target` reaches any room the user sees. `chat_search` with no resolvable room searches all.
- Agent messages carry visible provenance and open their originating Activity when available.

Connections appear only when enabled and backed by credentials or a local
cache:

```text
gmail_search     gmail_read       gmail_send
calendar_list    calendar_create
drive_search     drive_read
granola_search   granola_get      granola_sync
slack_search     slack_read       slack_send
```

The maximum surface is 40 tools; without connections it is 27, without chat
and connections it is 22. `mimir doctor` reports the public count, registered
connection tools, and local credential errors -- not remote service health.

Issues are graph nodes. Knowledge, issues, projects, and research are not
separate agent APIs. Activities, apps, routines, settings, shell, and
web search are not public agent tool families. Files expose exactly one
public tool, `files_trash`, because shell deletion is unrecoverable; every
other filesystem operation belongs to the agent's own shell, and external
edits, renames, and moves are reconciled into open editor buffers by the
workspace watcher (see [files.md](files.md)).

This document is the only authority on what agents can call. The internal
registry contains many more dotted tools (`files.browse`, `files.rename`,
`settings.*`, …) that back the embedded App SDK and UI runtime; their
existence in source, in `tool_runtime.rs`, or in another doc's tables never
implies an agent capability. If a name is not listed above, agents cannot
call it.

Today retains its historical `scratch` storage identity so existing text
survives upgrades. It has no standalone tool; `mimir_state` includes its
durable top priority.

## Connections

Google and Slack credentials stay in the OS keychain. Mimir reads its own
entries and predecessor service entries, so existing connections migrate
without exposing or copying secrets into agent context. Google tools are
further limited by granted OAuth scopes.

Granola is deliberately narrow: search/get read the local meeting cache;
sync is the only network operation. It can reuse the predecessor cache and
Granola desktop token files. This remains a private, undocumented-API
integration rather than a claimed public Granola API contract.

Connection setup is not part of the agent API. This build reuses existing
keychain credentials and Granola state; agents receive data tools, never token,
OAuth, status, or connect/disconnect tools. A connection can be disabled in
`~/.mimir/settings.json`:

```json
{
  "connections": {
    "google": { "enabled": false },
    "slack": { "enabled": false },
    "granola": { "enabled": false }
  }
}
```

Absent settings default to enabled; missing credentials/cache still keep the
tools out of the catalog. Restart Mimir after changing connection enablement or
credentials so the public projection is rebuilt.

## Skills

Mimir stores and discovers standard skill packages. It does not execute them;
the agent reads the Markdown and runs any included scripts.

There are three writable scopes:

| Scope | Visibility | Purpose |
|---|---|---|
| Catalog | every project; teammates when backed by a shared root | shared workflows |
| Personal | every project for one user | private reusable workflows |
| Project | one repository | repo-specific workflows |

The catalog is writable, not a marketplace or read-only install source.
Cross-project skills belong in catalog or personal, so they are never cloned
into every repo.

```text
~/.mimir/skills/catalog/
~/.mimir/skills/personal/
~/.mimir/skills/projects/<repo-key>/
```

The catalog defaults to the local path above. An absolute
`settings.skills.catalogRoot` points it at a team-synced directory.

```bash
mimir skills
mimir skill release-review
mimir skill add ./release-review --catalog
```

Writes retain content-addressed revisions. Native projections link to immutable
revisions and never overwrite unrelated client skills.

Mimir installs three minimal skills into the writable catalog:
`mimir-config` for non-obvious file ownership and manifest rules, and
`mimir-graph` for graph usage, examples, and ontology, and `mimir-meetings` for
bounded Scribe discovery, transcript paging, and reviewed updates. Untouched packaged
versions upgrade automatically; user edits are preserved.

Native discovery verified for Codex CLI 0.145.0, Claude Code 2.1.220, Pi 0.82.1,
and Gemini CLI 0.49.0:

| Client | Catalog + personal | Current project |
|---|---|---|
| Codex | native | `mimir skill` fallback |
| Claude Code | native | native |
| Pi | native | native |
| Gemini CLI | native | `mimir skill` fallback |

Codex and Gemini currently lack a clean per-launch skill-root option. Mimir
does not copy project skills into repos or inject all skill bodies to work
around that.

## Client attachment

See [agent-setup.md](agent-setup.md) for launcher presets, client connection
table, and resume semantics.
