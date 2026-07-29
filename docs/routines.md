# Routines

Routines are file-defined prompts that launch CLI agent presets — on a cron
schedule, or manually with one click. A scheduled or manual run becomes an
ordinary durable Activity with status and scrollback.

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
| `enabled` | defaults to `true`; only governs scheduled fires |
| `schedule` | optional five-, six-, or seven-field cron expression; omit it entirely for a manual-only routine |
| `timezone` | IANA timezone or `local`; `local` resolves the `TZ` environment variable and falls back to UTC when `TZ` is unset |
| `preset` | ID from `~/.mimir/launchers.json` |
| `prompt` | final CLI prompt argument |
| `overlap` | `skip` or `parallel` |
| `missed` | `skip` or `run-once` |
| `workspace` | folder the run starts in; required when the preset's working directory is "workspace", ignored for home/custom presets |
| `interactive` | defaults to `false` (headless one-shot run); `true` opens the agent's live session seeded with the prompt |

Five-field cron uses conventional minute/hour/day/month/week-day numbering.
The runtime normalizes it into the seconds-aware scheduler format.

A routine without a `schedule` is manual-only: the planner never arms it and
`enabled` has no effect on it, but Run now launches it exactly like a scheduled
fire. An empty `schedule = ""` is rejected — omit the key instead.

`interactive` picks the argv adapter. Headless runs force one-shot mode
(`codex exec …`, `claude --print …`, `pi --print …`; Gemini has no headless
adapter and is rejected). Interactive runs pass the prompt as the CLI's
ordinary opening message. An interactive session stays open until the user
closes it; with `overlap = "skip"` the next scheduled fire is skipped while it
is.

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
3. appends the routine prompt as one argv item through the session's argv
   adapter (headless or interactive);
4. spawns a durable `routine` Activity through `ActivitySupervisor`;
5. records the scheduled time and routine origin on the Activity.

Run now uses the same launch path with the current time as its scheduled time.
"Run again" on an ended run resolves the current TOML definition, so updated
prompt, flags, workspace, overlap, and launcher policy take effect.

Planner cursor is committed atomically before scheduled fires are spawned. This
prevents a crash during spawn from repeatedly treating the same instant as
unobserved. Spawn failures remain visible as last errors; they do not roll the
planner cursor backward. A launch reservation closes the gap between deciding
overlap eligibility and the new Activity becoming visible to the supervisor.

`run_now` refreshes changed inputs first and uses the same reservation/launch
path, but its timestamp is the current instant rather than advancing the cron
planner.

## UI contract

- Id is derived from title (slugged, uniquified, fixed after creation); timezone
  is stamped from the system. Explicit values in hand-written TOML are preserved
  on edit.
- Trigger defaults to manual-only; scheduled mode exposes a builder that compiles
  to five-field cron. Cron/builder mapping: `src/mimir/activities/routineSchedule.js`.
  Definitions whose cron the builder cannot express open in raw cron mode.
- Agent is picked from launcher presets configured under Settings. Missing
  binaries and vanished presets stay selectable but flagged.
- When the preset runs in "the workspace", the form requires a Workspace field.

For launcher presets see [agent-setup.md](agent-setup.md).

Every catalog entry carries its exact source path and a SHA-256
`sourceRevision`. Update, duplicate, and Trash require that revision, so the UI
cannot silently overwrite a definition edited elsewhere.

Private registry handlers:

| Canonical | Alias | Notes |
|---|---|---|
| `routines.list` | `routines_list` | catalog, status, source path/revision |
| `routines.run` | `routines_run` | launch now as a durable Activity |
| `routines.create` | `routines_create` | create canonical TOML; `schedule` optional (omit for manual), `interactive` optional (defaults to headless) |
| `routines.update` | `routines_update` | atomic, revision-guarded replace |
| `routines.duplicate` | `routines_duplicate` | new id, always initially paused |
| `routines.trash` | `routines_trash` | revision-guarded system Trash |

These handlers support the Routine UI and runtime; they are not in the public
agent catalog. Agents edit the authoritative TOML using the `mimir-config`
skill (`skills/mimir-config`).

## Relevant code

- `src-tauri/src/routines.rs`
- `src-tauri/src/routine_runtime.rs`
- `src/services/routines.js`
- `src/stores/routines.js`
- `src/mimir/activities/RoutinesActivity.vue`
- `src/mimir/activities/routineSchedule.js` — cron ↔ builder-state mapping and
  the humanized schedule labels
