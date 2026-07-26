# Agent setup

Mim detects Codex, Claude, and Pi from the user's login-shell PATH. Installed
and enabled presets appear as one-click launchers in the Sidebar. Missing
binaries remain visible with their diagnostics in Settings > CLI tools instead
of occupying the launch surface.

## Launcher presets

Presets live in `~/.mim/launchers.json`. Mim writes the default file on first
load and can edit the same data in Settings > CLI tools.

```json
{
  "version": 1,
  "presets": [
    {
      "id": "codex",
      "title": "Codex",
      "kind": "agent",
      "agentId": "codex",
      "enabled": true,
      "args": [],
      "env": {},
      "cwd": { "mode": "workspace" }
    },
    {
      "id": "review",
      "title": "Claude review",
      "kind": "agent",
      "agentId": "claude",
      "enabled": true,
      "args": ["--model", "sonnet"],
      "env": {},
      "cwd": { "mode": "workspace" }
    },
    {
      "id": "terminal",
      "title": "Terminal",
      "kind": "terminal",
      "enabled": true,
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

`enabled` controls whether the usable preset appears in the Sidebar. Existing
version-1 files without the field load as enabled. The ordinary Settings path
shows detected command/version, a visibility switch, and one shell-like CLI
flags field. Working directory and command/environment details are progressive
disclosures. The flags editor parses quotes and escapes into `args`; the saved
file and native launcher still retain exact argv entries.

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

- Codex receives a one-off `mcp_servers.mim_workbench.url` configuration
  override. The app-specific name cannot merge with a user's unrelated stdio
  server named `mim`.
- Claude receives an inline `--mcp-config` HTTP server definition.
- Pi receives `--extension ~/.mim/pi/mim-tools.ts`.

Detection understands both two-argument and `--mcp-config=…` Claude forms, so
preconfigured flags are kept verbatim and never injected twice. Terminal
presets and agent presets with an exact binary path resolve without running
unrelated agent/version probes; the launcher settings screen is the explicit
detection refresh boundary.

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
