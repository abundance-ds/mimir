# Mimir

Mimir is a desktop application for working with CLI agents on local projects.
It places agent and terminal sessions beside a persistent file editor, so
switching sessions does not replace the document or diff being reviewed.

It is built for an individual or a small trusted team that wants to run agents,
inspect their work, and keep project context in one application.

## What it provides

- [Activities](docs/activities.md) run CLI agents and terminals,
  retain scrollback, and reopen or resume recorded sessions.
- [Files](docs/files.md) navigates the current project; the
  [Editor](docs/editor-system.md) edits Markdown and presents agent
  changes as reviewable diffs.
- [Business graph](docs/business-graph.md) stores linked projects,
  issues, decisions, and knowledge as Markdown.
- [Chats](docs/chat.md) provides team channels and direct messages.
  An agent launched from a room reads and replies there by default and can
  address any room the user sees.
- [Apps](docs/apps-system.md) add local tools, and
  [Routines](docs/routines.md) schedule agent or command runs.

## Develop

```bash
bun install
bun tauri dev
```

See [Building Mimir](docs/building.md) for prerequisites, tests, and
packaging.

Release packaging currently targets macOS arm64 only. Linux and Windows are
parked as recoverable recipes rather than active distribution targets.

## Documentation

- [Documentation index](docs/README.md)
- [Agent integration](docs/agent-interface.md)
- [Codebase map](docs/_MAP.md)
