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
| `workspace` | folder the run starts in; required when the preset's working directory is "workspace" (routines have no open workspace to inherit), ignored for home/custom presets |
| `interactive` | defaults to `false` (headless one-shot run); `true` opens the agent's live session seeded with the prompt, so follow-up messages can be typed in the terminal |

Five-field cron uses conventional minute/hour/day/month/week-day numbering.
The runtime normalizes it into the seconds-aware scheduler format.

A routine without a `schedule` is manual-only: the planner never arms it and
`enabled` has no effect on it, but Run now in the UI launches it exactly like a
scheduled fire. An empty `schedule = ""` string is
rejected — omit the key instead, so a typo never silently disarms a schedule.

`interactive` picks the argv adapter, not the launch path. Headless runs force
the agent's one-shot mode (`codex exec …`, `claude --print …`, `pi --print …`;
Gemini has no headless adapter and is rejected). Interactive runs pass the
prompt as the CLI's ordinary opening message — positional for Codex, Claude,
and Pi, `--prompt-interactive` for Gemini — so the spawned PTY is the agent's
normal live session with all preset flags intact. An interactive session stays
open until the user closes it; with `overlap = "skip"` the next scheduled fire
is skipped while it is.

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

The Routines Activity shows enabled/running state, a humanized schedule
("Weekdays 09:30", "Every 15 min", or "Manual"), preset, next fire, prompt,
policy, workspace, and per-definition diagnostics. It is a complete control
surface over the same TOML files:

- New and Edit expose the lean routine definition rather than a separate
  database model. The form never asks for an id or timezone: the id is
  derived from the title (slugged and uniquified, fixed after creation) and
  the timezone is stamped from the system so wall-clock times mean what the
  user expects. Explicit values in hand-written TOML are preserved on edit.
- The session is a two-way choice, defaulting to **Interactive** for new
  routines: the run opens the agent's live session with the prompt as the
  first message, and follow-ups are typed straight into the terminal.
  **One-shot** keeps the classic headless report run. Hand-written TOML
  without the flag stays one-shot. Picking one-shot with a Gemini preset is
  rejected in the form, since Gemini has no headless adapter; and when an
  interactive session is combined with a schedule and skip-overlap, the form
  notes that fires are skipped until the previous session is closed.
- The trigger is a two-way choice, defaulting to **On demand** (manual-only).
  **On a schedule** opens a builder — every day / weekdays / weekly with day
  chips / hourly / minute interval — that compiles to five-field cron and
  previews the result ("Runs Mon, Fri 18:30 — 30 18 * * 1,5 · Europe/Berlin").
  A raw cron mode remains the escape hatch, and definitions whose cron the
  builder cannot express open in that mode with the text intact.
- The agent is picked from the launcher presets configured under Settings →
  Coding agents, decorated with live detection state. Missing binaries and
  vanished presets stay selectable but flagged, so editing never silently
  drops a routine's agent.
- When the picked preset runs in "the workspace", the form shows a required
  Workspace field prefilled from the workbench; for other presets the field
  is hidden because the runtime ignores it. The runtime diagnostic for a
  missing workspace says to set one on the routine rather than repeating the
  workbench's "requires an open workspace" phrasing.
- Overlap and missed-fire policies live in an Advanced disclosure as
  two-option segments; the missed policy only appears for scheduled routines.
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

Reveal stays UI-local because it controls Finder/Explorer rather than routine
state.

These handlers support the Routine UI and runtime; they are not in the public
agent catalog. Agents edit the authoritative TOML using the `mimir-config`
skill.

## Relevant code

- `src-tauri/src/routines.rs`
- `src-tauri/src/routine_runtime.rs`
- `src/services/routines.js`
- `src/stores/routines.js`
- `src/mimir/activities/RoutinesActivity.vue`
- `src/mimir/activities/routineSchedule.js` — cron ↔ builder-state mapping and
  the humanized schedule labels
