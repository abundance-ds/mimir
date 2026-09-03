# MCP registry and transport

Mimir exposes a small public agent API over loopback while retaining a larger
internal registry for UI and runtimes.

## Transport

The desktop serves `http://127.0.0.1:17532/mcp`. It supports initialize, ping,
tool list/call, schema validation, cancellation, and stable protocol versions.
It has no caller identity or session id and must never bind externally.

Normal discovery advertises only `mimir_state`, `mimir_reveal`, and
`mimir_propose`, plus the instruction to use `mimir tools`. The installed CLI
requests the complete current public projection.

## Registry and projection

- `tool_registry.rs` owns canonical definitions, schemas, validation,
  providers, cancellation, revisions, and structured results.
- `tool_runtime.rs::AGENT_TOOLS` is the public underscore-name allowlist.
  Internal dotted names and old aliases are rejected by MCP.
- Workbench tools relay to the renderer. Graph and connection tools can use
  native providers. Both return the same readable and structured result shape.
- Dynamic providers unregister and cancel pending work when their App or
  connection ends.
- Stable tool error codes are `not_found`, `invalid_input`, `cancelled`,
  `timeout`, `unavailable`, `handler`, and `internal`.

The complete public tool list and usage policy are in
[agent-interface.md](agent-interface.md). Launcher attachment is in
[agent-setup.md](agent-setup.md); relay ordering is in [ipc.md](ipc.md).
