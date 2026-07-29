# Mimir

Desktop app (Tauri) for working with CLI agents on local projects: agent and
terminal sessions beside a persistent Markdown editor, so switching sessions
never replaces the document or diff under review. Built for an individual or a
small trusted team.

## What it provides

- [Activities](docs/activities.md) — CLI agents and terminals with scrollback,
  resume, and recorded sessions.
- [Files](docs/files.md) — project navigation;
  [Editor](docs/editor-system.md) — Markdown editing with agent changes as
  reviewable diffs.
- [Business graph](docs/business-graph.md) — linked projects, issues,
  decisions, and knowledge stored as Markdown.
- [Chats](docs/chat.md) — team channels and DMs; an agent launched from a room
  reads and replies there.
- [Apps](docs/apps-system.md) — local tools;
  [Routines](docs/routines.md) — scheduled agent or command runs.

## Develop

```bash
bun install
bun tauri dev
```

See [Building Mimir](docs/building.md) for prerequisites, tests, and
packaging. Release packaging targets macOS arm64; Linux and Windows are
parked.

## Documentation

- [Codebase map](docs/_MAP.md) — change routing, owners, docs index
- [Agent interface](docs/agent-interface.md) — public agent tools
