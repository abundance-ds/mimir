---
name: mimir
description: Use Mimir's Today, shared Scratchpad, Editor, and tool discovery. For Graph, Scribe, or configuration, use the matching mimir-* skill.
---

# Mimir

- **Scratchpad:** read and edit `~/.mimir/scratchpad.md` with normal file tools. Project `scratchpad.md` links point there. Keep the links intact. Mimir opens the Editor and keeps saved history.
- **Today (daily plan):** read `mimir_state.today`; append with `today_append`. No Graph skill needed.
- **Editor:** `mimir_state` reads; `mimir_propose` opens a reviewed diff.
- **Graph / Journal:** `mimir-graph`.
- **Scribe:** `mimir-meetings`.
- **Settings, launchers, routines, apps, skills:** `mimir-config`.
- **Files:** use the shell; Mimir reconciles changes. Delete with `files_trash`.
- **Chat:** a room-linked Activity defaults to that room.

## Tools

`mimir tools` lists available tools; `mimir tools <group>` filters.
`mimir tool <name>` shows inputs; `mimir call <name> '<json>'` calls.
The CLI uses the attached Mimir connection; it does not launch an app.
