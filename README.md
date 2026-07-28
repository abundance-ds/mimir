# Mimir

Mimir 0.1.0 is a local AI-native workbench for CLI agents and reviewed files.
It is built for one person and a small team: fast, direct, and hackable without
administration UI.

The package name is `mimir`. The desktop app uses Tauri v2, Vue 3,
CodeMirror 6, xterm.js, and a Rust backend.

## Workbench

Mimir has one three-pane window:

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
  CLI, terminal, or process run. **Activities** contains the active working set;
  closed runs live in Cmd/Ctrl+P History. Tools and launch sources each support
  local manual ordering. The Activities `+` menu mirrors New activity; Apps are
  managed in Settings.
- **Activity** is the universal execution surface. Each run and full-pane tool
  has one stable Activity identity, while singleton Tools stay out of run
  history.
- **Editor** remains mounted while Activities change. Agents can inspect and
  edit it through Mimir's MCP tools, while substantial edits open as reviewable
  diffs.

All panes resize. Editor is visible on startup. The Sidebar collapses to a 52px
live rail; Activity and Editor collapse to 44px rails without losing their
state, and either content pane can expand into focus and restore the split.

**Interface rule: NEVER USE border left coloured as a style element!**

## Business graph

The built-in Business graph combines the former Knowledge Graph and Issue
Board into one source-aware operating surface — a dispatch desk where agents
file work around the clock and the human keeps overview, contributes,
monitors, and corrects. Issues are typed graph nodes; the Now stream, Work
board, Portfolio ledger, Timeline, and the All directory are purpose-built
projections over the same private, project, and team knowledge. Markdown
stays canonical while a rebuildable Rust GraphStore provides fast search,
traversal, validation, conflict-safe writes, and agent context.

The interface follows a fast **Scan → Peek → Focus** rhythm with persistent,
debounced graph search and a single dispatch bar: search filters the current
projection across indexed titles, tags, summaries, and body text; the dispatch
bar opens graph objects, files new lines through a background agent,
delegates `!` or `work <target>` with a visible context pack, and exposes `/`
commands. AI work is trusted — it lands in Now as filed events with provenance,
never behind accept/reject gates. Board rows show full titles with visible
controls for priority, status, and due date; every active filter is named and
one-click dismissible; hover never reveals content or moves a surface.

Project sources remain in the workspace, private sources stay local under
`~/.mimir/graph/private/`, and an optional shared root is configured in Settings
> Graph. Delegated work launches durable CLI-agent Activities with bounded
graph context; decisions, evidence, deliverables, and next actions remain
linked to the project instead of disappearing into chat history.

Agents use one graph API: find, get, create, update, delete, restore, and
context. Issues are graph nodes rather than a parallel tool family. See
[Business graph](docs/reference/business-graph.md) for ontology, scopes,
projections, interaction design, migration, recovery, and architecture.

## Capability layer

Mimir starts a loopback MCP endpoint at `http://127.0.0.1:17532/mcp`. One
discoverable registry serves launched agents, apps, routines, and the installed
`mimir` CLI.

Mimir-launched Codex, Claude, Pi, and Gemini sessions connect automatically.
Their complete Mimir instruction is:

```text
Mimir: `mimir tools` · `mimir tool <name>` · `mimir skill <query>` · `mimir doctor`
```

Three frequent editor tools remain directly available. `mimir tools` prints
one concise Workbench/Graph/Connections catalog; `mimir tool <name>` expands
one schema. The public surface is 14 core tools plus up to 13 conditional
Gmail, Calendar, Drive, Granola, and Slack tools.
Catalog and personal skills use native client discovery. Project skills are
also native in Claude and Pi and remain available through `mimir skill` in
Codex and Gemini. See [Agent interface](docs/agent-interface.md).

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

Mimir creates and uses:

- `~/.mimir/launchers.json` for exact-argv launcher presets
- `~/.mimir/activities/` for durable Activity metadata and bounded scrollback
- `~/.mimir/apps/` for local app definitions
- `~/.mimir/app-data/` for app-owned JSON data
- `~/.mimir/graph/private/` for private local knowledge and work
- `~/.mimir/routines/` for routine TOML files
- `~/.mimir/routines-state.json` for scheduler state
- `~/.mimir/settings.json` for workbench, editor, model, and workspace settings
- `~/.mimir/session.json` for open tabs, unsaved drafts, recents, and zoom
- `~/.mimir/models.json` for inline and ghost AI model configuration
- `~/.mimir/bin/mimir` for the installed CLI
- `~/.mimir/pi/mimir-tools.ts` for Pi's dynamic Mimir tool extension
- `~/.mimir/skills/` for canonical catalog/personal/project skills and revisions
- `~/.agents/skills/` for Mimir-managed catalog/personal native projections

The writable catalog defaults to `~/.mimir/skills/catalog/`. Set the absolute
`skills.catalogRoot` in `settings.json` (or
`MIMIR_SKILLS_CATALOG_ROOT`) to share it across teammates. A Gemini launch adds
only Mimir's owned `mimir_workbench` entry to the existing Gemini settings.

API keys entered in Settings are stored in the OS keychain. Debug builds may
also read environment variables, `.env`, and `~/.mimir/keys.env`.
Existing Google and Slack credentials under the predecessor keychain service
are reused without exposing them to agents. Granola can reuse its previous
local cache and desktop token files.

## Documentation

Start with [docs/README.md](docs/README.md). Dense system notes and tutorials
remain preserved under `docs/reference/` for explicit, on-demand use.
