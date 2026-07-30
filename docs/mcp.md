# MCP registry, transport, and projection

Mimir keeps a broad internal registry for its UI and runtimes, but exposes one
small public agent API through MCP.

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
Mimir: On the first substantive user turn, call `mimir_title` once with a concise 3-8 word task title. Discover other capabilities with `mimir tools` (all), `mimir tools <workbench|graph|chat|connections>`, `mimir tool <name>`, `mimir skill <query>`, and `mimir doctor`.
```

Normal `tools/list` advertises `mimir_state`, `mimir_title`, `mimir_reveal`,
and `mimir_propose`. The installed CLI uses `includeAll: true` to obtain every
currently backed public tool. That wider result is still a public projection,
not the internal registry.

## Public projection

`src-tauri/src/tool_runtime.rs::AGENT_TOOLS` is the allowlist. It defines each
public underscore name, concise description, group, effect, and whether it is
directly advertised. `tools/call` resolves only these public names. Internal
dotted names and historical aliases are rejected even if a private registry
handler exists.

The projection includes the 5 chat tools (`chat_rooms`, `chat_read`,
`chat_search`, `chat_send`, `chat_download`) and up to 13 connection tools.
See [agent-interface.md](agent-interface.md) for the full canonical tool
listing and counts.

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

## Dynamic providers

`mimir doctor` uses a private diagnostic RPC to inspect graph scopes, public
tool count, registered connection tools, and local credential errors. It does
not contact remote services and reports `remoteChecked: false` in JSON.
`graph.status` is not made public just to implement diagnostics.

## Client attachment

See [agent-setup.md](agent-setup.md) for launcher presets, client connection
table, and resume semantics.

## Change checklist

For a new public capability:

1. Implement/register its internal canonical handler.
2. Add one `AGENT_TOOLS` projection entry.
3. Give it a short public description, group, and honest effect.
4. Add schema, rejection, CLI discovery, and end-to-end contract tests.
5. Add permanent agent text only if a demonstrated failure cannot be solved by
   the catalog or focused schema.
