# Routines

Routines are file-defined schedules that launch CLI agent presets. A scheduled
or manual run becomes an ordinary durable Activity with status and scrollback.

## Definition

Place one TOML file per routine in `~/.mimir/routines/`:

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
| `timezone` | IANA timezone or `local`; `local` resolves the `TZ` environment variable and falls back to UTC when `TZ` is unset |
| `preset` | ID from `~/.mimir/launchers.json` |
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

Planner state is stored atomically in `~/.mimir/routines-state.json`. A corrupt
state file is quarantined and reported without disabling valid definitions.

The native worker periodically fingerprints Routine definitions and launcher
configuration, reloads both as one consistent input set, and publishes only
after reconciling scheduler state. The UI does not own a second scheduler and
must not infer availability from TOML alone: an otherwise valid Routine can be
runtime-unavailable because its current preset cannot resolve.

At fire time the runtime:

1. applies missed-fire and overlap policy;
2. resolves the current launcher preset and agent connection flags;
3. appends the routine prompt as one argv item;
4. spawns a durable `routine` Activity through `ActivitySupervisor`;
5. records the scheduled time and routine origin on the Activity.

Run now uses the same launch path with the current time as its scheduled time.
The returned process-backed `routine` record opens in the terminal surface;
only the stable `routines` core Activity renders the manager. “Run again” on
an ended run resolves the current TOML definition, so updated prompt, flags,
workspace, overlap, and launcher policy are not silently replaced by stale
PTY argv.

Planner cursor is committed atomically before scheduled fires are spawned. This
prevents a crash during spawn from repeatedly treating the same instant as
unobserved. Spawn failures remain visible as last errors; they do not roll the
planner cursor backward. A launch reservation closes the gap between deciding
overlap eligibility and the new Activity becoming visible to the supervisor.

`run_now` refreshes changed inputs first and uses the same reservation/launch
path, but its timestamp is the current instant rather than advancing the cron
planner.

## UI and tools

The Routines Activity shows enabled/running state, schedule, timezone, preset,
next fire, prompt, policy, workspace, and per-definition diagnostics. It
is a complete control surface over the same TOML files:

- New and Edit expose the lean routine definition rather than a separate
  database model.
- Open TOML and double-click keep direct source editing first-class.
- Duplicate creates a paused copy so a copied schedule cannot double-fire.
- Trash moves the exact definition to the operating-system Trash.
- Row and empty-surface context menus expose run, stop, edit, open, duplicate,
  reveal, copy path, reload, and Trash actions.
- Live runs stop through the ordinary Activity lifecycle.

Arrow keys, Home/End, and Enter navigate and run the selected routine.
Cmd/Ctrl+N creates, Cmd/Ctrl+R reloads, Cmd/Ctrl+O opens the TOML, F2 edits,
Cmd/Ctrl+. stops live runs, Cmd/Ctrl+Backspace/Delete confirms Trash, and
Shift+F10 opens the accessible row menu.

The UI does not poll. The native scheduler publishes changes when definitions,
launcher availability, planner state, or runs change; reopening the surface
also performs one explicit refresh.

Every catalog entry carries its exact source path and a SHA-256
`sourceRevision`. Update, duplicate, and Trash require that revision, so a UI
or MCP caller cannot silently overwrite a definition edited elsewhere.

MCP exposes:

| Canonical | Alias | Notes |
|---|---|---|
| `routines.list` | `routines_list` | catalog, status, source path/revision |
| `routines.run` | `routines_run` | launch now as a durable Activity |
| `routines.create` | `routines_create` | create canonical TOML |
| `routines.update` | `routines_update` | atomic, revision-guarded replace |
| `routines.duplicate` | `routines_duplicate` | new id, always initially paused |
| `routines.trash` | `routines_trash` | revision-guarded system Trash |

Reveal stays UI-local because it controls Finder/Explorer rather than routine
state.

## Relevant code

- `src-tauri/src/routines.rs`
- `src-tauri/src/routine_runtime.rs`
- `src/services/routines.js`
- `src/stores/routines.js`
- `src/mimir/activities/RoutinesActivity.vue`
