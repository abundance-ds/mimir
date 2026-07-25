# Routines

Routines are file-defined schedules that launch CLI agent presets. A scheduled
or manual run becomes an ordinary durable Activity with status and scrollback.

## Definition

Place one TOML file per routine in `~/.mim/routines/`:

```toml
id = "morning-review"
title = "Morning review"
enabled = true
schedule = "0 9 * * 1-5"
timezone = "Europe/Berlin"
preset = "codex"
prompt = "Review recent workspace changes and leave precise comments."
overlap = "skip"
missed = "run-once"
workspace = "/absolute/path/to/workspace"
```

Fields:

| Field | Meaning |
|---|---|
| `id` | stable ASCII identifier |
| `title` | Activity-facing label |
| `enabled` | defaults to `true` |
| `schedule` | five-, six-, or seven-field cron expression |
| `timezone` | IANA timezone or `local` |
| `preset` | ID from `~/.mim/launchers.json` |
| `prompt` | final CLI prompt argument |
| `overlap` | `skip` or `parallel` |
| `missed` | `skip` or `run-once` |
| `workspace` | optional cwd override |

Five-field cron uses conventional minute/hour/day/month/week-day numbering.
The runtime normalizes it into the seconds-aware scheduler format.

## Runtime

`src-tauri/src/routine_runtime.rs` watches the routine files and launcher
configuration through a short native tick. It validates both inputs, resolves
the preset, calculates next fire times, and publishes catalog changes to the
Routines Activity.

Planner state is stored atomically in `~/.mim/routines-state.json`. A corrupt
state file is quarantined and reported without disabling valid definitions.

At fire time the runtime:

1. applies missed-fire and overlap policy;
2. resolves the current launcher preset and agent connection flags;
3. appends the routine prompt as one argv item;
4. spawns a durable `routine` Activity through `ActivitySupervisor`;
5. records the scheduled time and routine origin on the Activity.

Run now uses the same launch path with the current time as its scheduled time.

## UI and tools

The Routines Activity shows enabled/running state, schedule, timezone, preset,
next fire, prompt, policy, workspace, and per-definition diagnostics. It
supports keyboard selection, double-click/Enter run, Run now, and reload.

MCP exposes `routines.list` and `routines.run`; aliases are `routines_list` and
`routines_run`.

## Relevant code

- `src-tauri/src/routines.rs`
- `src-tauri/src/routine_runtime.rs`
- `src/services/routines.js`
- `src/stores/routines.js`
- `src/mim/activities/RoutinesActivity.vue`
