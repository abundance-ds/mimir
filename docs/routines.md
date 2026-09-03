# Routines

Routines are TOML-defined manual or scheduled runs. Each run launches an agent
package or CLI preset as a normal durable Activity.

One file under `~/.mimir/routines/` defines one Routine:

```toml
id = "morning-review"
title = "Morning review"
schedule = "0 9 * * 1-5"
timezone = "Europe/Berlin"
agent = "morning-review"
overlap = "skip"
missed = "run-once"
workspace = "/path/to/workspace"
```

- Omit `schedule` for manual-only. An empty value is invalid.
- Use either `agent`, or the `preset` and `prompt` pair.
- `timezone` is an IANA name. `local` falls back to UTC when the GUI process
  lacks `TZ`.
- `overlap` is `skip` or `parallel`; `missed` is `skip` or `run-once`.
- Headless mode uses each client’s one-shot adapter. Gemini has no supported
  headless adapter. Interactive mode opens the seeded live session.
- Project package and skill resolution uses the Routine workspace.

`routine_runtime.rs` watches definitions and launchers, owns the planner, and
stores its cursor in `~/.mimir/routines-state.json`. It commits the cursor
before spawn so a crash cannot repeat the same scheduled instant. A reservation
closes the overlap race before the new Activity becomes visible.

Run now and Run again use the same path as a scheduled fire and resolve the
current TOML, package, and launcher. Updates and Trash require the current
`sourceRevision`, so the UI cannot overwrite an external edit. Invalid
definitions remain visible without disabling valid ones.

Native ownership is `routines.rs` and `routine_runtime.rs`. Renderer ownership
is the Routine service, store, Activity, and cron builder. Private registry
handlers support that UI but are not public agent tools.
