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

The Pi extension discovers the lean live catalog at session start and preserves
its `mim_` names (legacy names receive the prefix once). `/mim-refresh`
discovers newly exposed default tools after the session began.

Ended agent Activities can start a continuation using the CLI's supported
resume strategy; the continuation respawns inside the same Activity record.
Plain terminal restart always creates a fresh Activity.

## Detection and resolution boundaries

Opening/reloading CLI Settings is the explicit detection refresh boundary.
Rust resolves the login-shell PATH and runs version probes once into a process
cache; ordinary launches reuse that cache. A preset with an explicit `binary`
or a terminal preset does not trigger unrelated agent/version probes.

Availability shown by `src/stores/launchers.js` is a renderer decoration over
the last detection result. `launcher_resolve` remains authoritative for a
launch: it validates the preset, chooses the binary and cwd, injects agent MCP
arguments only when absent, and returns exact command/argv/env. The renderer
then appends run-specific resume/prompt args and host-authoritative
`MIM_ACTIVITY_ID`/`MIMX_MCP_URL` before spawning.

Agent detection and connection injection are separate. A custom binary on an
agent preset keeps the configured `agentId`/resume strategy and MCP injection
without requiring the binary to match a detected catalog path.

Files that must agree:

- `src-tauri/src/launchers.rs`: config, detection cache, resolution/injection
- `src/stores/launchers.js`: availability projection
- `src/services/launchers.js`, `activities.js`: invoke boundary
- `src/stores/activityRuntime.js`: record construction and continuation argv
- `src/shared/ui/settings/launcherFlags.js`: shell-like UI text to exact argv
- `bin/mimx.mjs`, `bin/pi-mim-extension.ts`, `src-tauri/src/mimx.rs`: installed
  clients

Tests: native `launchers.rs`, launcher store/Settings/flags tests,
`activityRuntime.test.js`, and `mimxCli.test.js`.

## `mimx`

Mim installs `mimx` on launch and makes it available inside every Mim PTY.
It calls the same MCP registry as the agents.

```bash
mimx help
mimx state
mimx tools
mimx tools graph
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
mimx graph [search terms]
mimx board [status]
mimx context <graph-node-id>
```

Bare help stays short. `mimx help <topic>` and `mimx tools <topic>` disclose
optional commands and registry domains without loading their schemas into every
agent session. `mimx tools --all --json` remains available for diagnostics.

The graph shortcuts call the canonical native registry rather than scraping the
visual app: `graph` prints a compact source-aware catalog or ranked search,
`board` groups issues by status, and `context` prints the bounded agent context
pack used by Start Work.

For a shell outside Mim:

```bash
export PATH="$HOME/.mim/bin:$PATH"
export MIMX_MCP_URL="http://127.0.0.1:17532/mcp"
```

Mim must be running for `mimx` and automatically connected agents to reach the
renderer-backed tools.
