# Mim

Mim 0.1.0 is a local AI-native workbench for CLI agents and reviewed files.
It is built for one person and a small team: fast, direct, and hackable without
administration UI.

The package name is `mim-workbench`. The desktop app uses Tauri v2, Vue 3,
CodeMirror 6, xterm.js, and a Rust backend.

## Workbench

Mim has one three-pane window:

```text
+----------------+---------------------------+---------------------------+
| Sidebar        | Activity                  | Editor                    |
| launchers      | terminal, agent, app,     | Markdown tabs, inline AI, |
| core surfaces  | Files, or Routines        | diffs, live preview,      |
| Activities     |                           | and inline comments       |
+----------------+---------------------------+---------------------------+
```

- **Sidebar** launches Codex, Claude, Pi, terminals, Files, Apps, and Routines.
  It also tracks live, finished, and archived Activities.
- **Activity** is the universal execution surface. Each terminal, agent run,
  app, and scheduled routine run has one stable Activity identity.
- **Editor** remains mounted while Activities change. Agents can inspect and
  edit it through Mim's MCP tools, while substantial edits open as reviewable
  diffs.

All panes resize. The Sidebar collapses to a 52px live rail; Activity and Editor
collapse to 44px rails without losing their state.

## Capability layer

Mim starts a loopback MCP endpoint at `http://127.0.0.1:17532/mcp`. One
discoverable registry serves launched agents, apps, routines, and the installed
`mimx` CLI.

Mim-launched Codex, Claude, and Pi sessions receive the connection
automatically. Core tool domains cover files, editor state, comments, shell,
web search, Activities, Apps, Routines, and settings. Embedded apps may add
tools to the same live registry.

There is no general built-in chat surface. CLI agents are the primary
intelligence; native model calls are reserved for the editor's Cmd+K inline
agent and `++` ghost completions.

## Start developing

Prerequisites are Node.js 22, npm, the stable Rust toolchain, and the platform
dependencies required by Tauri.

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

See [Building](docs/building.md) for platform notes and release checks.

## Local configuration

Mim creates and uses:

- `~/.mim/launchers.json` for exact-argv launcher presets
- `~/.mim/activities/` for durable Activity metadata and bounded scrollback
- `~/.mim/apps/` for local app definitions
- `~/.mim/app-data/` for app-owned JSON data
- `~/.mim/routines/` for routine TOML files
- `~/.mim/routines-state.json` for scheduler state
- `~/.mim/settings.json` for workbench, editor, model, and workspace settings
- `~/.mim/bin/mimx` for the installed CLI
- `~/.mim/pi/mim-tools.ts` for Pi's dynamic Mim tool extension

API keys entered in Settings are stored in the OS keychain. Debug builds may
also read environment variables, `.env`, and `~/.mim/keys.env`.

## Documentation

Start with [docs/_MAP.md](docs/_MAP.md). It maps every current subsystem and
links to the concise system documents.
