# Mimir agent interface

Status: implemented, 2026-07-29

## Design rule

Tell agents only what is Mimir-specific and changes their next action. They
already understand tools, JSON, files, shells, MCP, and skills.

Permanent context is one line:

```text
Mimir: `mimir tools` (all) · `mimir tools <workbench|graph|chat|connections>` · `mimir tool <name>` · `mimir skill <query>` · `mimir doctor`
```

No architecture lesson, hidden-tool warning, or client tutorial accompanies it.

## Discovery

`mimir tools` prints every currently callable public tool, grouped as
Workbench, Graph, Chat, and Connections. Each heading points to its focused
drawer:

```text
mimir tools workbench
mimir tools graph
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
mimir_state       active editor, selection, comments, and Today priority
mimir_reveal      open a file or line
mimir_propose     propose an exact reviewed replacement
comments_list     read document comments
comments_add      add an anchored comment
comments_reply    reply to a comment
comments_resolve  resolve a comment
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

Chat:

```text
chat_read    read recent messages in the linked room
chat_search  search the local cache for the linked room
chat_send    send a visible agent message to the linked room
chat_download download one authenticated attachment to a verified local path
```

An agent Activity started from chat is linked to that exact channel or direct
message before its process spawns. Omitting `target` uses the link; passing a
different target is rejected. Ordinary Activities may pass a target explicitly
or use the room currently open in Mimir. Agent messages carry visible
provenance and open their originating Activity when that Activity identity is
available. Reads and searches return current materialized state, including
edits, deletion markers, mentions, reactions, and attachment metadata.
`chat_download` verifies the attachment size and SHA-256 before returning its
local path.

Connections appear only when enabled and backed by credentials or a local
cache:

```text
gmail_search     gmail_read       gmail_send
calendar_list    calendar_create
drive_search     drive_read
granola_search   granola_get      granola_sync
slack_search     slack_read       slack_send
```

The maximum surface is 31 tools; without connections it is 18 while Chats is
enabled and 15 while Chats is off. `mimir doctor` reports this public count,
registered connection tools, and local credential errors—not remote service
health.

Issues are graph nodes. Knowledge, issues, projects, and research are not
separate agent APIs. Activities, apps, files, routines, settings, shell, and
web search are not public agent tool families. Internal UI/runtime operations
may still use private registry handlers.

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

Mimir installs two minimal skills into the writable catalog:
`mimir-config` for non-obvious file ownership and manifest rules, and
`mimir-graph` for graph usage, examples, and ontology. Untouched packaged
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

Mimir-launched Codex, Claude, Pi, and Gemini receive the scoped endpoint and CLI
on `PATH`. Codex and Claude use their run-scoped MCP configuration, Pi uses the
installed dynamic extension, and Gemini uses Mimir’s owned stdio proxy entry.
Unrelated client configuration is preserved.

Starting an agent from a chat room seeds a short, editable task prompt naming
the room and its four bounded chat tools. Mimir does not submit it: the user
can append or revise the assignment before pressing Enter. The link is durable
and created before the PTY starts, so the agent cannot race ahead of its room
boundary.

## Chat administration

The complete server and client runbook is
[`reference/chat.md`](reference/chat.md). For routine account operations on the
chat host, use the installed helper instead of anonymous IRC or hand-editing
Ergo state:

```bash
sudo mimir-chat-user add anna
sudo mimir-chat-user remove anna --confirm anna
sudo mimir-chat-health
```

Creation prints a generated teammate passphrase once. Removal unregisters the
login, permanently reserves its historical account name, and unregisters
channels that account founded; transfer important channel ownership first.
The helper reads the root-only owner secret and authenticates through SASL.
Neither that secret nor teammate passphrases belong in agent output, logs, or
repository files.

## Acceptance bar

For an unfamiliar operation:

1. `mimir tools <group>` supplies ordinary callable signatures.
2. `mimir tool <name>` supplies nested details only when needed.
3. `mimir call <name> ...` succeeds without schema probing.

Do not add instructions, facades, indexes, tool families, or commands unless an
observed failure shows which call or mistake they remove.
