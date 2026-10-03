# Tracker

Tracker is a first-party, opt-in activity timeline. Disabled by default.
Collection supported on macOS.

## State and lifecycle

| State | Meaning |
|---|---|
| disabled | No sampling, permission request, AI, notifications, login launch, or menu item |
| armed | Sampling and eligible classification/nudges run |
| paused | Tracker remains visible but records an `OFF` interval |
| break | A persisted manual break runs until its end |
| needs-access | Window-title collection waits for Accessibility |
| error/unsupported | Stored history remains available |

- `enabled` and `armed` are separate native config fields. Hiding UI is not
  disabling.
- Window close does not stop tracking. Application Quit closes the current
  interval and checkpoints SQLite.
- Enabling Tracker adds login launch; disabling removes it but retains data.

## Evidence and privacy

- App and bundle identity use `NSWorkspace`; no permission needed.
- Window titles use Accessibility, capped at 512 characters, requested lazily.
- Browser domains are separately opt-in (`collect_browser_domains`); only the
  normalized host is retained.
- No screenshots, pixels, or full browser URLs.
- Tracker data is absent from Graph context, Mimir context, and agent tools.
  Titles enter AI only after explicit opt-in (`include_window_titles_in_ai`).

## Timeline and classification

- A changed foreground activity must survive the configured confirmation
  window before it splits the timeline.
- AFK starts at the observed idle boundary, not at the later sampling tick.
  Pause, shutdown, and relaunch gaps become explicit `OFF` intervals.
- Manual rules always beat imported and AI rules. Unknown keys remain visible
  and durable even when AI classification is off.
- AI classification and nudges use the normal model and credential policy,
  bounded batches, durable retries, and one daily cost cap.
- Reports clip intervals to the exact query range and respect local-day and DST
  boundaries.

## Storage and migration

`~/.mimir/tracker/tracker.sqlite` is the WAL-mode authority for configuration,
intervals, rules, jobs, AI usage, nudges, and imports. A damaged database and
its sidecars move to a timestamped `.corrupt-<ms>.sqlite` sibling; a newer
schema fails closed. Disabling never deletes history.

Argus import is one idempotent SQLite transaction. It refuses to run while
Tracker is enabled or the legacy Argus process is live, preserves source files,
and keeps existing manual Tracker rules.

Native ownership is `src-tauri/src/tracker/`. Renderer ownership is the Tracker
service, store, app, and Settings panel. `mimir://tracker-changed` is only an
invalidation; install its listener before reading native status.
