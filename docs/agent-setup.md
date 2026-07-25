# Agent setup

Mim detects Codex, Claude, and Pi from the user's login-shell PATH. Installed
agents appear as one-click launchers in the Sidebar. A missing binary remains
visible with its diagnostic.

## Launcher presets

Presets live in `~/.mim/launchers.json`. Mim writes the default file on first
load and can edit the same data in Settings > Launchers.

```json
{
  "version": 1,
  "presets": [
    {
      "id": "codex",
      "title": "Codex",
      "kind": "agent",
      "agentId": "codex",
      "args": [],
      "env": {},
      "cwd": { "mode": "workspace" }
    },
    {
      "id": "review",
      "title": "Claude review",
      "kind": "agent",
      "agentId": "claude",
      "args": ["--model", "sonnet"],
      "env": {},
      "cwd": { "mode": "workspace" }
    },
    {
      "id": "terminal",
      "title": "Terminal",
      "kind": "terminal",
      "args": [],
      "env": {},
      "cwd": { "mode": "workspace" }
    }
  ]
}
```

`kind` is `agent` or `terminal`. Agent presets use `agentId` `codex`, `claude`,
or `pi`; `binary` may override detection. A terminal may also set `binary`;
otherwise it uses the platform's default shell.

`cwd` accepts:

- `{ "mode": "workspace" }`
- `{ "mode": "home" }`
- `{ "mode": "custom", "path": "/absolute/path" }`

Each `args` item is one exact argv entry. No shell string is reconstructed.
`env` is merged into the child environment.

## Automatic MCP connection

Every Mim-launched preset receives:

- `MIMX_MCP_URL=http://127.0.0.1:17532/mcp`
- `~/.mim/bin` prepended to PATH

Agent-specific connection is added unless the preset already supplies it:

- Codex receives a one-off `mcp_servers.mim.url` configuration override.
- Claude receives an inline `--mcp-config` HTTP server definition.
- Pi receives `--extension ~/.mim/pi/mim-tools.ts`.

The Pi extension discovers the live registry at session start and registers
each tool with a `mim_` prefix. `/mim-refresh` discovers tools contributed after
the session began.

Ended agent Activities can start a continuation using the CLI's supported
resume strategy. Plain terminal restart always creates a fresh Activity.

## `mimx`

Mim installs `mimx` on launch and makes it available inside every Mim PTY.
It calls the same MCP registry as the agents.

```bash
mimx tools
mimx call files.search '{"scope":"project","query":"needle"}'
mimx active
mimx tabs
mimx open /absolute/path/to/file.md
mimx reveal /absolute/path/to/file.md:42
mimx selection
mimx comments
mimx comments-prompt
mimx replace-selection --stdin
mimx set-content --file replacement.md
mimx save
```

For a shell outside Mim:

```bash
export PATH="$HOME/.mim/bin:$PATH"
export MIMX_MCP_URL="http://127.0.0.1:17532/mcp"
```

Mim must be running for `mimx` and automatically connected agents to reach the
renderer-backed tools.
