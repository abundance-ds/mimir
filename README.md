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
| Tools          | terminal, agent, tool,    | Markdown tabs, inline AI, |
| New activity   | Files, or Routines        | diffs, live preview,      |
| Activities     |                           | and inline comments       |
+----------------+---------------------------+---------------------------+
```

- **Sidebar** follows one lifecycle rule. **Tools** reopen stable surfaces such
  as Files, Routines, Today, and Business graph. **New activity** starts a fresh
  CLI, terminal, or process run. **Activities** contains the resulting live and
  historical runs. Tools and launch sources each support local manual ordering.
  The Activities `+` menu mirrors New activity; Apps are managed in Settings.
- **Activity** is the universal execution surface. Each run and full-pane tool
  has one stable Activity identity, while singleton Tools stay out of run
  history.
- **Editor** remains mounted while Activities change. Agents can inspect and
  edit it through Mim's MCP tools, while substantial edits open as reviewable
  diffs.

All panes resize. Editor is visible on startup. The Sidebar collapses to a 52px
live rail; Activity and Editor collapse to 44px rails without losing their
state, and either content pane can expand into focus and restore the split.

**Interface rule: NEVER USE border left coloured as a style element!**

## Business graph

The built-in Business graph combines the former Knowledge Graph and Issue
Board into one source-aware operating surface. Issues are typed graph nodes;
Board, Portfolio, CRM, Timeline, directory, and relationship views are
purpose-built projections over the same private, project, and team knowledge.
Markdown stays canonical while a rebuildable Rust GraphStore provides fast
search, traversal, validation, conflict-safe writes, and agent context.

The interface follows a fast **Scan → Peek → Focus** rhythm: projections stay
calm and scannable, Peek is read-first, and Focus provides one spacious scroll
for syntax-aware Markdown, business properties, and ontology-bounded
connections. Custom Vue listboxes, calendars, dialogs, and relationship
sentences replace browser-native form and graph-database UI.

This is an internal operational instrument, not a presentation dashboard:
Kanban geometry is fixed, important properties and controls remain visible,
Portfolio is a data table, and hover never reveals content or moves a surface.

Project sources remain in the workspace, private sources stay local under
`~/.mim/graph/private/`, and an optional shared root is configured in Settings
> Graph. **Start Work** launches a durable CLI-agent Activity with bounded
graph context; decisions, evidence, deliverables, and next actions remain
linked to the project instead of disappearing into chat history.

The same system is continuously available through `graph.*`, `knowledge.*`,
`issues.*`, `projects.*`, and `research.*` tools, plus `mimx graph`,
`mimx board`, and `mimx context`. See
[Business graph](docs/reference/business-graph.md) for ontology, scopes,
projections, interaction design, migration, recovery, and architecture.

## Capability layer

Mim starts a loopback MCP endpoint at `http://127.0.0.1:17532/mcp`. One
discoverable registry serves launched agents, apps, routines, and the installed
`mimx` CLI.

Mim-launched Codex, Claude, and Pi sessions receive the connection
automatically. Agents see only three concise tools by default: editor state,
file reveal, and reviewable proposals. The full files, comments, graph,
Activities, Apps, Routines, settings, and metadata-search capabilities remain
available on demand through `mimx help` and `mimx tools <topic>`. Embedded apps
may add tools to the same live registry without expanding default agent
context.

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

See [Building](docs/reference/building.md) for platform notes and release
checks.

## Local configuration

Mim creates and uses:

- `~/.mim/launchers.json` for exact-argv launcher presets
- `~/.mim/activities/` for durable Activity metadata and bounded scrollback
- `~/.mim/apps/` for local app definitions
- `~/.mim/app-data/` for app-owned JSON data
- `~/.mim/graph/private/` for private local knowledge and work
- `~/.mim/routines/` for routine TOML files
- `~/.mim/routines-state.json` for scheduler state
- `~/.mim/settings.json` for workbench, editor, model, and workspace settings
- `~/.mim/session.json` for open tabs, unsaved drafts, recents, and zoom
- `~/.mim/models.json` for inline and ghost AI model configuration
- `~/.mim/bin/mimx` for the installed CLI
- `~/.mim/pi/mim-tools.ts` for Pi's dynamic Mim tool extension

API keys entered in Settings are stored in the OS keychain. Debug builds may
also read environment variables, `.env`, and `~/.mim/keys.env`.

## Documentation

Start with [docs/README.md](docs/README.md). Dense system notes and tutorials
remain preserved under `docs/reference/` for explicit, on-demand use.
