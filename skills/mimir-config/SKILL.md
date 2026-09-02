---
name: mimir-config
description: Edit Mimir settings, launchers, routines, apps, and skills.
---

# Mimir configuration

Sources are `~/.mimir/{settings.json,launchers.json,routines,apps}` and scoped
`graph/`, `skills/`, and `agents/` folders. Project uses the repository root,
Private uses `~/.mimir/private/`, and Team uses managed
`~/.mimir/team-graph/`. Preserve unrelated JSON keys. Never change the Team
root or run Git there.

Routine files require `id` and `title`, plus either `agent` or both `preset`
and `prompt`. `agent` is mutually exclusive with `preset` and `prompt`.
Omit `schedule` for manual-only. Optional keys are `enabled`, `timezone`,
`overlap = "skip" | "parallel"`,
`missed = "skip" | "run-once"`, `workspace`, and `interactive`.

An app is `apps/<id>/app.toml` or `apps/<id>.toml`:

```toml
id = "example"
title = "Example"
mode = "embedded"
entry = "index.html"
```

Modes require one key: `embedded`/`window` → `entry`, `terminal` → `preset`,
`process` → `command`, `rust-helper` → `helper`, `action` → `actionTool`.
Optional keys are `args`, `env`, `launchOnly`, and `tools`. Routine files
refresh automatically. Reload edited apps in Settings → Apps.

Add skills with `mimir skill add <dir> --private|--project|--team` and agents
with `mimir agent add <dir> --private|--project|--team`. Use only the scoped
roots. If Team is not set up, `--team` stays unavailable; these commands do not
create or connect it.

Do not edit `session.json`, `routines-state.json`, `activities/`, `app-data/`,
graph event files, or credentials. Use graph tools for graph data. Credentials
stay in the OS keychain.
