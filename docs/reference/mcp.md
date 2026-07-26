# MCP registry

Mim exposes one canonical capability registry to CLI agents, embedded apps,
Routines, the renderer, and `mimx`.

## Transport

The desktop workbench starts a loopback HTTP server at:

```text
http://127.0.0.1:17532/mcp
```

It implements MCP `initialize`, `ping`, `tools/list`, and `tools/call`.
Ordinary `tools/list` returns only the three lean agent tools and one registry
revision. Explicit CLI discovery sends `includeAll: true`; that response
returns the complete catalog with canonical name, owner, and source metadata.

The server negotiates the stable `2025-06-18` and `2025-03-26` protocol
versions. It is intentionally stateless and therefore does not issue or
require MCP session ids. Registry changes are observed through the revision in
`tools/list`; the server does not advertise `listChanged` because this compact
HTTP transport has no outbound notification channel.

The endpoint binds only to `127.0.0.1`. The older `/api/tools` routes exist for
local debugging and require the runtime bearer token; agents and `mimx` use
`/mcp`. The MCP endpoint is a trusted-local capability surface: it has no
per-agent tokens or role policy, and must not be exposed beyond loopback.

## Registry contract

`src-tauri/src/tool_registry.rs` is transport-neutral. It owns:

- canonical names and unique MCP aliases
- descriptions and JSON input schemas
- source and ownership metadata
- schema validation before execution
- structured result and error categories
- cancellation, timeouts, provider reconciliation, and revision observation

`src-tauri/src/tool_runtime.rs` registers core definitions. UI-owned tools
relay to `src/services/toolRuntime.js`; Business graph tools register direct
native handlers because `GraphRuntime` owns their data and mutation contract.
Both paths share the same registry schema validation, errors, discovery, and
cancellation contract. Apps can reconcile per-instance providers through
`src/services/appsCatalog.js`; removing an instance also removes its tools and
cancels outstanding calls.

Stable error codes are `not_found`, `invalid_input`, `cancelled`, `timeout`,
`unavailable`, `handler`, and `internal`. Callers must branch on the code, not
message prose. Native wrapper failures in `src/services/toolRuntime.js` map
known workspace/revision/not-found errors into these categories.

Core renderer relays default to 120 seconds; dynamic provider timeouts are
bounded natively. Timeout/cancel removes the provider's pending request and
emits a renderer cancellation. A response after completion is rejected as an
unknown/late id rather than reviving the call.

## Default agent surface

| Tool | Purpose |
|---|---|
| `mim_state` | active document, tabs, selection, visible range, dirty state, and comment counts |
| `mim_reveal` | open a file and optionally reveal a line or offset |
| `mim_propose` | show one exact replacement as an accept/reject review |

These are transport projections over `editor.state`, `editor.reveal`, and
`editor.propose`. The descriptions are deliberately one sentence each and the
schemas carry validation details. Calls to other known canonical names and
aliases still work; they are simply not placed in every agent's initial
context.

## Registry domains

| Canonical domain | Purpose |
|---|---|
| `files.*` | text tools plus workspace-safe browse, folder, rename, duplicate, and Trash operations |
| `editor.*` | open/reveal/save, tabs, content, selection, editor mutations |
| `comments.*` | add, reply, resolve, reopen, and delete pseudo-XML threads |
| `shell.*` | bounded workspace shell execution |
| `web.*` | OpenAlex, Crossref, and arXiv metadata search |
| `activities.*` | list, spawn, stop, rename, archive, and clear Activities |
| `apps.*` | list, launch, reload, create, duplicate, display-rename, and Trash local Apps |
| `routines.*` | list, run, create, revision-guarded update/duplicate, and Trash |
| `settings.*` | read and update public workbench/editor settings |
| `graph.*` | source-aware graph query, search, traversal, context, diagnostics, migration, and mutation |
| `knowledge.*` | compatibility facade over non-issue graph nodes |
| `issues.*` | Issue Board compatibility plus semantic movement, assignment, completion, deliverables, and next actions |
| `projects.*` | link companies/contacts and record durable project decisions |
| `research.*` | capture source-aware HEOR evidence |

Optional aliases such as `read`, `comment_resolve`, `activities_list`, and
`routines_run` remain in the internal registry and explicit `mimx` catalog.
Canonical names are used inside Mim and are also accepted by the registry.

File-manager aliases are namespaced (`files_browse`, `files_create_folder`,
`files_rename`, `files_duplicate`, `files_trash`) so the long-standing
`create` alias remains the text-file tool. Routine mutation aliases are
`routines_create`, `routines_update`, `routines_duplicate`, and
`routines_trash`. Routine update/duplicate/Trash calls must pass the
`sourceRevision` returned by `routines.list` as `expected_revision`; stale
callers receive a structured `invalid_input` error instead of overwriting
external edits.

App definition aliases are likewise explicit: `apps_reload`, `apps_create`,
`apps_duplicate`, `apps_update`, and `apps_trash`. They invoke the same native
catalog operations as Settings > Apps and return its refreshed catalog.
`apps.update` changes the display title while keeping the id stable because
that id owns app data, Activity identity, and generated app-tool names.

Substantial file edits are routed into the stable Editor as proposals so the
user can accept or reject a full diff. Direct editor selection/content tools
are explicit lower-level operations.

## Callers

- Codex and Claude receive the MCP URL through launcher flags.
- Pi receives a generated extension that discovers and registers the aliases.
- `mimx tools` lists the three default tools without schemas.
- `mimx tools <topic>` or `mimx tools --all` discloses optional capabilities;
  `--json` includes their schemas.
- `mimx call <canonical-or-alias> <json>` performs a generic call.
- `mimx graph [terms]`, `mimx board [status]`, and `mimx context <id>` expose
  readable terminal projections over the native graph tools.
- Embedded apps use `window.mim.tools.list()`, `.call()`, and `.handle()`.
- Routine runs use their launcher preset and therefore inherit the same agent
  connection.

See [agent-setup.md](agent-setup.md) and [apps-system.md](apps-system.md).

MCP results carry both human-readable `content` and machine-readable
`structuredContent`. `mimx` returns `structuredContent` when present and keeps
the text form only as a compatibility fallback.

## Lifetime and change map

The registry exists before the HTTP socket. `createToolRuntime.start` installs
relay listeners, then acquires a client lease on `tool_server_start`; HMR
instances may overlap. The final lease release closes and awaits the listener
before another bind can occur. See [ipc.md](ipc.md).

When adding/changing a core tool, update:

- the definition/schema/alias in `src-tauri/src/tool_runtime.rs`, or
  `business_graph/tools.rs` for a direct native graph tool;
- the lean projection in `src-tauri/src/tool_server.rs` only if the capability
  belongs in every agent's initial context;
- the renderer dispatch in `src/services/toolRuntime.js` or workspace tool
  implementation under `src/services/ai/tools/`;
- `CORE_TOOL_ALIASES` if it uses the legacy renderer tool set;
- Rust registry/runtime/server tests and `toolRuntime.test.js`;
- `bin/mimx.mjs` only for a new convenience command, not generic call support;
- this document only for a new domain or non-obvious lifecycle rule.

Do not hand-maintain a second complete tool-schema table here; the definition
vectors and explicit full-list response are canonical.
