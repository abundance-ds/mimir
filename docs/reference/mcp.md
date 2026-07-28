# Agent capability boundary

Mimir keeps a broad internal registry for its UI and runtimes, but exposes one
small public agent API.

## Transport

The desktop starts a loopback endpoint at:

```text
http://127.0.0.1:17532/mcp
```

It implements `initialize`, `ping`, `tools/list`, and `tools/call`, negotiates
the supported MCP protocol versions, validates browser Origin, and does not
issue session IDs. It must not be exposed beyond loopback.

Initialization contains only:

```text
Mimir: `mimir tools` · `mimir tool <name>` · `mimir skill <query>` · `mimir doctor`
```

Normal `tools/list` advertises `mimir_state`, `mimir_reveal`, and
`mimir_propose`. The installed CLI uses `includeAll: true` to obtain every
currently backed public tool. That wider result is still a public projection,
not the internal registry.

## Public projection

`src-tauri/src/tool_runtime.rs::AGENT_TOOLS` is the allowlist. It defines each
public underscore name, concise description, group, effect, and whether it is
directly advertised. `tools/call` resolves only these public names. Internal
dotted names and historical aliases are rejected even if a private registry
handler exists.

The 14 always-available core tools are:

```text
mimir_state       mimir_reveal      mimir_propose
comments_list     comments_add      comments_reply     comments_resolve
graph_find        graph_get         graph_create       graph_update
graph_delete      graph_restore     graph_context
```

Up to 13 connection tools register only when enabled and backed:

```text
gmail_search      gmail_read        gmail_send
calendar_list     calendar_create
drive_search      drive_read
granola_search    granola_get       granola_sync
slack_search      slack_read        slack_send
```

`mimir tools` groups these as Workbench, Graph, and Connections. It prints only
name, effect, and purpose. `mimir tool <name>` retrieves the full schema.
`mimir tools --json` is the only bulk machine-readable form.

There are no public knowledge, issues, projects, research, Activities, Apps,
files, routines, settings, shell, or web-search families. Issues are graph
nodes. Internal handlers for UI/runtime compatibility do not widen the agent
surface.

## Registry contract

`tool_registry.rs` remains transport-neutral and owns schemas, aggregate input
validation, annotations, structured results/errors, cancellation, provider
reconciliation, and revisions.

Stable error codes are `not_found`, `invalid_input`, `cancelled`, `timeout`,
`unavailable`, `handler`, and `internal`. MCP tool failures remain tool results
with `isError`; malformed protocol requests remain JSON-RPC errors.

Workbench tools relay to the renderer. Graph and connection tools have native
Rust handlers. Both paths use the same registry validation and result shape.
MCP responses contain readable `content` plus machine-readable
`structuredContent`; the CLI prefers the latter.

Today is folded into `mimir_state`. The built-in retains its `scratch` storage
id for migration but does not register an app tool.

## Connections

Connection handlers live in `connections.rs`.

- Google and Slack read credentials from Mimir’s OS-keychain service, then the
  predecessor service for migration. Credentials never appear in descriptors,
  results, diagnostics, or settings.
- Account selection uses `connections.<name>.account`, then the predecessor’s
  credential-free default, then `default`.
- Google registration follows granted OAuth scopes.
- Granola search/get use the local SQLite cache. Sync is the only Granola
  network operation and uses the Granola desktop token files. A completed
  `full` sync prunes meetings deleted upstream; a page-limited traversal never
  prunes.
- `settings.json` may disable `google`, `slack`, or `granola`; missing backing
  state keeps those tools out of the projection. Restarting Mimir rebuilds the
  projection after connection changes.

`mimir doctor` uses a private diagnostic RPC to inspect graph scopes, public
tool count, registered connection tools, and local credential errors. It does
not contact remote services and reports `remoteChecked: false` in JSON.
`graph.status` is not made public just to implement diagnostics.

## Client attachment

- Codex and Claude receive a run-scoped HTTP definition.
- Pi’s installed extension dynamically registers the three direct tools.
- Gemini uses Mimir’s owned stdio proxy entry.
- Every launched agent receives the scoped endpoint and `~/.mimir/bin` on
  `PATH`.

The endpoint URL’s activity/agent query parameters are omitted from ordinary
help and errors. `--verbose` may show them.

## Change checklist

For a new public capability:

1. Implement/register its internal canonical handler.
2. Add one `AGENT_TOOLS` projection entry.
3. Give it a short public description, group, and honest effect.
4. Add schema, rejection, CLI discovery, and end-to-end contract tests.
5. Add permanent agent text only if a demonstrated failure cannot be solved by
   the catalog or focused schema.
