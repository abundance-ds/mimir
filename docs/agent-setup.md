# Agent setup

Mimir detects Codex, Claude, Pi, and Gemini from the login-shell `PATH`.
Presets live in `~/.mimir/launchers.json` and preserve exact argv, environment,
and working-directory policy (`workspace`, `home`, or custom). On macOS and
Linux the login-shell `PATH` is used for skill preparation and agent processes
so desktop launches find runtimes like Node. An explicit preset `env.PATH`
takes precedence. `~/.mimir/bin` is added to either path.

## Connection

Every Activity receives its scoped MCP URL, Activity and agent IDs, and
`~/.mimir/bin` on `PATH`. Mimir adds one product-owned `mimir_workbench`
connection while preserving unrelated client configuration:

| Client | Connection |
|---|---|
| Codex | one-run `mcp_servers.mimir_workbench.url` override |
| Claude | inline `mimir_workbench` HTTP definition |
| Pi | installed Mimir extension |
| Gemini | owned `mimir_workbench` stdio-proxy setting |

A conflicting unrelated entry with the same name is an error. Resume uses the
exact recorded session and launch policy, never an implicit “latest” session.

## Skills and packages

Mimir installs four packaged skills into the Private scope from `skills/`:
`mimir` (overview), `mimir-config`, `mimir-graph`, and `mimir-meetings`. A test
keeps the overview's tool list equal to the public tool allowlist.

`mimir run <name>` resolves `agents/<name>/AGENT.md` through the same Activity
path. Routines can reference agent package names directly.

Resolution order, skill projection, and package format are in
[agent-interface.md](agent-interface.md). Native ownership is `launchers.rs`,
`agent_packages.rs`, and `mimir_cli.rs`. Renderer ownership is the launcher
service/store and Activity runtime.
