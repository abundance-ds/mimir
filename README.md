# Mimir

Desktop app (Tauri) for working with CLI agents on local projects: agent and
terminal sessions beside a persistent Markdown editor, so switching sessions
never replaces the document or diff under review. Built for an individual or a
small trusted team.

## What it provides

- [Activities](docs/activities.md) — CLI agents and terminals with scrollback,
  resume, and recorded sessions; [agent packages](docs/agent-interface.md#agent-packages)
  add reusable Project, Private, and Team missions.
- [Files](docs/files.md) — project navigation;
  [Editor](docs/editor-system.md) — Markdown editing with agent changes as
  reviewable diffs.
- [Business graph](docs/business-graph.md) — linked projects, issues,
  decisions, and knowledge stored as Markdown.
- [Tracker](docs/tracker.md) — optional native desktop activity timeline,
  classification, breaks, and humane drift nudges.
- [Chats](docs/chat.md) — team channels and DMs; an agent launched from a room
  reads and replies there.
- [Apps](docs/apps-system.md) — local tools;
  [Routines](docs/routines.md) — scheduled agent or command runs.
- [Scribe](docs/meetings.md) — local-first meeting detection, dual-channel
  recording, transcription, and reviewable follow-up Activities.
- [Connections](docs/agent-interface.md#connections) — connect Google, Slack,
  and Granola once, then use their tools from any agent.

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
