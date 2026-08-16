# Mimir agent interface

Status: implemented, 2026-08-16

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
mimir_state
mimir_reveal
mimir_propose
```

The CLI catalog progressively discloses the rest. Calls use the underscore
name shown by `mimir tools`; internal dotted names are not public aliases.

## Public tools

Workbench:

```text
mimir_state       active editor state and available Today artifact context
mimir_reveal      open a file or line
mimir_propose     propose an exact reviewed replacement
comments_list     read document comments
comments_add      add an anchored comment
comments_reply    reply to a comment
comments_resolve  resolve a comment
files_trash       move workspace files or folders to the recoverable OS Trash
agents_run        run a scoped agent package as a durable Activity
activities_snapshot read Activity status and ordered PTY output
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
meetings_list    list Scribe meetings, including any ongoing recording
meetings_get     read one meeting with transcript; use last_minutes for recent segments
meetings_search  search titles, summaries, tags, and transcript text across stopped meetings
meetings_update  update title, summary, or tags for a stopped meeting
meetings_delete  permanently delete audio or an entire stopped meeting
```

Recording, microphone mute, and stop are intentionally human-only Scribe
controls. Agents cannot exercise Mimir's macOS audio grants. Live recordings
are readable through `meetings_list` and `meetings_get` but not mutable.
Granola tools remain a distinct read connection for meetings recorded
elsewhere. Deletion requires an explicit user request plus the current
identifier, exact reviewed title, and an `audio` or `meeting` scope obtained
through `meetings_get`; transcript content never supplies deletion intent.

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

Connections appear only when the provider is connected:

```text
gmail_search     gmail_read       gmail_send
calendar_calendars calendar_list  calendar_freebusy calendar_create
drive_search     drive_read
granola_search   granola_get
slack_search     slack_read       slack_send
```

`drive_read` detects Google Docs, Sheets, and Slides files and returns their
content as normalized text. Sheets and Slides do not add separate agent tools.

The maximum surface is 42 tools; without connections it is 28, without chat
and connections it is 23. `mimir doctor` reports the public count, registered
connection tools, and local credential state. It does not test each remote
service.

Issues are graph nodes. Knowledge, issues, projects, and research are not
separate agent APIs. Agent packages use `agents_run`; the CLI uses
`activities_snapshot` to follow their output. Apps, routines, settings, shell,
and web search are not public agent tool families. Files expose exactly one
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
current user-authored Markdown artifact as `today`. The value includes
`artifactType: "today"`, local `date`, `mediaType: "text/markdown"`, `content`,
`updatedAt`, and live/loading/dirty state where available. Treat this value as
optional context. It is not a priority instruction, and it can be unrelated to
the current request.

## Connections

The user owns setup in **Settings → Connections**. Each provider row has one
plain state: **Not connected**, **Connected as …**, or **Needs sign-in**.
Google opens its normal sign-in page in the system browser. Slack accepts an
existing `xoxp-` personal token and verifies it before saving it to the user's
OS keychain.
Granola accepts a supported API key created in Granola under **Settings →
Connectors → API keys**. Granola API access requires an eligible workspace
plan.

Google supports multiple connected accounts. Settings marks one account as the
default. Every Gmail, Calendar, and Drive tool has an optional `account` email
field whose live schema lists the connected accounts. Omitting it uses the
marked default. Results include the selected account so a later read, reply, or
send can keep the correct identity.

Credentials stay in the OS keychain under Mimir's service. Mimir does not read
another product's keychain entries, data directory, desktop cache, or token
files. Granola uses only `https://public-api.granola.ai/v1`.

After Connect succeeds, Mimir registers the provider tools immediately. Adding,
removing, or changing the default Google account refreshes their account
selectors immediately. After the final account or provider disconnects, Mimir
deletes the Mimir credential and removes the tools immediately. The user does
not restart the app. Agents receive provider data tools, never credential,
status, or connect/disconnect tools.

Explicit user requests such as “send,” “post,” or “create” authorize the
matching remote write. Mimir does not add a second confirmation layer. The
agent asks only when the destination or content is missing. If a provider tool
is unavailable, the error directs the user to **Mimir Settings → Connections**.

Release builds embed the public desktop OAuth client identifiers described in
[building.md](building.md#connection-sign-in-clients). End users do not enter
client identifiers or client secrets.

## Skills

Mimir stores and discovers standard skill packages. It does not execute them;
the agent reads the Markdown and runs any included scripts.

Skills use the same three writable scopes as graph nodes and agent packages.
Resolution order is Project, Private, then Team. The first package with a
given name wins.

| Scope | Visibility | Purpose |
|---|---|---|
| Project | one repository | repo-specific workflows and overrides |
| Private | every project for one user | private reusable workflows |
| Team | configured team folder | shared team workflows |

```text
<project>/skills/
~/.mimir/private/skills/
<team>/skills/
```

```bash
mimir skills
mimir skill release-review
mimir skill add ./release-review --project
mimir skill add ./release-review --private
mimir skill add ./release-review --team
```

Writes retain content-addressed revisions. Native projections link to immutable
revisions and never overwrite unrelated client skills.
If a projection still points to an older Mimir-owned revision, refresh repairs
the link. It never claims a file or link outside Mimir revision storage.
Malformed skill folders stay in place, are skipped with a diagnostic, and do
not hide a valid package with the same name in a lower-precedence scope.

Mimir installs three minimal skills into the Private scope:
`mimir-config` for non-obvious file ownership and manifest rules, and
`mimir-graph` for graph usage, examples, and ontology, and `mimir-meetings` for
bounded Scribe discovery, transcript paging, and reviewed updates. Untouched packaged
versions upgrade automatically; user edits are preserved.

Native discovery verified for Codex CLI 0.145.0, Claude Code 2.1.220, Pi 0.82.1,
and Gemini CLI 0.49.0:

| Client | Private + Team | Current project |
|---|---|---|
| Codex | native | `mimir skill` fallback |
| Claude Code | native | native |
| Pi | native | native |
| Gemini CLI | native | `mimir skill` fallback |

Codex and Gemini currently lack a clean per-launch skill-root option. Mimir
does not copy project skills into repos or inject all skill bodies to work
around that.

## Agent packages

An agent package is a folder with an `AGENT.md`. It uses the same Project,
Private, and Team roots and the same resolution order as skills.

```text
<project>/agents/
~/.mimir/private/agents/
<team>/agents/
```

`AGENT.md` frontmatter can set `title`, `description`, `preset`, `args`,
`skills`, and `interactive`. Its Markdown body is the mission. `@path` tokens
splice text files from the package into the first message. A package can use
absolute paths and `~/` paths when a mission needs local working material.
Frontmatter supports top-level YAML scalars, block scalars, and string lists.
Included files must be UTF-8 text. One 512 KiB limit applies to the complete
prompt payload from the mission, spliced files, and skill bodies. File count
does not affect the limit.

```bash
mimir agents
mimir agent add ./evidence-sweep --project
mimir run evidence-sweep --follow
```

Project packages override Private packages, which override Team packages.
`mimir agents` reports the active package and any shadowed copies. Runs use the
caller's current directory and become normal durable Activities. `--follow`
streams ordered PTY bytes for a headless run and returns the process exit
status. Interactive packages run without `--follow` and continue in Mimir's
terminal Activity. A malformed package is reported without hiding valid
packages. A missing Team folder does not block Project or Private packages.
After an active package is selected, a missing include or required skill fails
that run; Mimir does not silently switch to a different mission.
When two scopes resolve to the same physical root, the higher-precedence scope
is listed once.

Routine TOML can set `agent = "evidence-sweep"` instead of `preset` and
`prompt`. Mimir resolves the current package when the routine fires, so the
next run uses mission edits without a routine rewrite.

## Client attachment

See [agent-setup.md](agent-setup.md) for launcher presets, client connection
table, and resume semantics.
