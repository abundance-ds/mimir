# Agent setup

Mimir detects Codex, Claude, Pi, and Gemini from the login-shell `PATH`.
Presets live in `~/.mimir/launchers.json` and preserve exact argv, environment,
and `workspace`, `home`, or custom working-directory policy.
On macOS and Linux, skill preparation and the agent process also use the
login-shell `PATH`, so they can find runtimes such as Node when Mimir starts
from the desktop. An explicit preset `env.PATH` takes precedence. Mimir adds
`~/.mimir/bin` to either path.

## Connection

Every Activity receives its scoped MCP URL, Activity and agent ids, and
`~/.mimir/bin` on `PATH`. Mimir adds one product-owned connection while
preserving unrelated client configuration:

| Client | Connection |
|---|---|
| Codex | one-run `mcp_servers.mimir_workbench.url` override |
| Claude | inline `mimir_workbench` HTTP definition |
| Pi | installed Mimir extension |
| Gemini | owned `mimir_workbench` stdio-proxy setting |

A conflicting unrelated entry with the same owned name is an error. Resume
uses the exact recorded provider session and launch policy; it never uses an
implicit “latest” session.

## Skills and packages

Project, Private, then Team is the resolution order for skills and agent
packages. Mimir projects retained immutable skill revisions without taking over
unrelated client files. Codex and Gemini need `mimir skill` for Project skills;
Claude and Pi receive Project skills at launch.

Mimir installs four packaged skills into the Private scope from `skills/`:
`mimir` (overview, used when no more specific skill fits), `mimir-config`,
`mimir-graph`, and `mimir-meetings`. A test keeps the overview's tool list equal
to the public tool allowlist.

`mimir run <name>` resolves `agents/<name>/AGENT.md`, launches it through the
same Activity path, and supports either interactive mode or headless follow.
Routines can reference the package name directly.

Native ownership is `launchers.rs`, `agent_packages.rs`, and `mimir_cli.rs`.
Renderer ownership is the launcher service/store and Activity runtime. Public
CLI discovery, tools, skills, and package formats are in
[agent-interface.md](agent-interface.md).
