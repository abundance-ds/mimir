# MCP registry

Mim exposes one canonical capability registry to CLI agents, embedded apps,
Routines, the renderer, and `mimx`.

## Transport

The desktop workbench starts a loopback HTTP server at:

```text
http://127.0.0.1:17532/mcp
```

It implements MCP `initialize`, `ping`, `tools/list`, and `tools/call`.
`tools/list` returns MCP aliases and preserves the canonical name, owner,
source, and registry revision in `_meta`.

The endpoint binds only to `127.0.0.1`. The older `/api/tools` routes exist for
local debugging and require the runtime bearer token; agents and `mimx` use
`/mcp`.

## Registry contract

`src-tauri/src/tool_registry.rs` is transport-neutral. It owns:

- canonical names and unique MCP aliases
- descriptions and JSON input schemas
- source and ownership metadata
- schema validation before execution
- structured result and error categories
- cancellation, timeouts, provider reconciliation, and revision observation

`src-tauri/src/tool_runtime.rs` registers core definitions. UI-backed tools
relay to `src/services/toolRuntime.js`. Apps can reconcile per-instance
providers through `src/services/appsCatalog.js`; removing an instance also
removes its tools and cancels outstanding calls.

## Core domains

| Canonical domain | Purpose |
|---|---|
| `files.*` | read, list, search, propose exact edits, create text files |
| `editor.*` | open/reveal/save, tabs, content, selection, editor mutations |
| `comments.*` | add, reply, resolve, reopen, and delete pseudo-XML threads |
| `shell.*` | bounded workspace shell execution |
| `web.*` | OpenAlex, Crossref, and arXiv metadata search |
| `activities.*` | list, spawn, stop, rename, archive, and clear Activities |
| `apps.*` | list and launch local Apps |
| `routines.*` | list schedules and run a Routine now |
| `settings.*` | read and update public workbench/editor settings |

Agents see stable MCP aliases such as `read`, `edit`, `editor_open`,
`comment_resolve`, `activities_list`, and `routines_run`. Canonical names are
used inside Mim and are also accepted by the registry.

Substantial file edits are routed into the stable Editor as proposals so the
user can accept or reject a full diff. Direct editor selection/content tools
are explicit lower-level operations.

## Callers

- Codex and Claude receive the MCP URL through launcher flags.
- Pi receives a generated extension that discovers and registers the aliases.
- `mimx tools` lists the current registry.
- `mimx call <canonical-or-alias> <json>` performs a generic call.
- Embedded apps use `window.mim.tools.list()`, `.call()`, and `.handle()`.
- Routine runs use their launcher preset and therefore inherit the same agent
  connection.

See [agent-setup.md](agent-setup.md) and [apps-system.md](apps-system.md).
