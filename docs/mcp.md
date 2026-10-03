# MCP registry and transport

## Transport

`http://127.0.0.1:17532/mcp` — loopback only, no caller identity or session
ID. Supports initialize, ping, tool list/call, schema validation,
cancellation, and stable protocol versions.

## Registry and projection

- `tool_registry.rs` owns canonical definitions, schemas, validation,
  providers, cancellation, revisions, and structured results.
- `tool_runtime.rs::AGENT_TOOLS` is the public underscore-name allowlist.
  Internal dotted names and old aliases are rejected by MCP.
- Workbench tools relay to the renderer; Graph and connection tools can use
  native providers. Both return the same result shape.
- Dynamic providers unregister and cancel pending work when their App or
  connection ends.
- Error codes: `not_found`, `invalid_input`, `cancelled`, `timeout`,
  `unavailable`, `handler`, `internal`.

Public tool list and usage policy: [agent-interface.md](agent-interface.md).
Launcher attachment: [agent-setup.md](agent-setup.md). Relay ordering:
[ipc.md](ipc.md).
