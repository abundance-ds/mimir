---
name: mimir-config
description: Locate and safely edit Mimir settings, launchers, routines, apps, and skills.
---

# Mimir configuration

Edit only authored sources under `~/.mimir`: `settings.json`,
`launchers.json`, `routines/*.toml`, `apps/`, and
`skills/{catalog,personal,projects}/`. Preserve unrelated JSON keys.

Routine files require `id`, `title`, `preset`, and `prompt`. `schedule` is an
optional cron string; omit it for manual-only. Optional keys are `enabled`,
`timezone`, `overlap = "skip" | "parallel"`, `missed = "skip" | "run-once"`,
`workspace`, and `interactive`.

An app is `apps/<id>/app.toml` or `apps/<id>.toml`:

```toml
id = "example"
title = "Example"
mode = "embedded"
entry = "index.html"
```

Modes require one matching key: `embedded`/`window` → `entry`, `terminal` →
`preset`, `process` → `command`, `rust-helper` → compiled-in `helper`, `action`
→ internal `actionTool`. Optional `args`, `env`, `launchOnly`, and `tools`
remain private to the app runtime. Embedded pages receive `window.mimir` APIs
for app data, files, HTTP, private tools, and opening workspace files.
Routine files refresh automatically; reload externally edited apps in
Settings → Apps.

Add skills with `mimir skill add <directory> --catalog|--personal|--project`;
do not copy cross-project skills into repositories.
To share the catalog, set absolute `settings.skills.catalogRoot`.

Do not edit `session.json`, `routines-state.json`, `activities/`, `app-data/`,
graph event files, or credentials. Use graph tools for graph data. Credentials
stay in the OS keychain.
