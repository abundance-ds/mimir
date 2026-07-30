# Tracker

Tracker is Mimir's first-party, opt-in desktop activity instrument. It replaces
the separate Argus Python/menu-bar application with a Rust-owned collector and
SQLite store plus a native Vue Activity surface. Its stable built-in app id and
Rust-helper name are both `tracker`.

Tracker is hard-coded into Mimir, not installed from an App manifest. It is
visible in `Settings > Apps` so the user can discover and configure it, but is
disabled by default and stays out of Tools and Go to until enabled. Disabling
retains history and settings while stopping sampling, AI work, nudges,
notifications, launch-at-login, and the Tracker menu-bar item.

## Product contract

`enabled` and `armed` are deliberately separate:

| State | Collection | Presentation and recovery |
|---|---|---|
| disabled | no sampling, permission request, AI, nudge, or menu-bar item | configuration and retained history remain in SQLite; Tracker is hidden from launch surfaces |
| needs-access | enabled and armed, but no title observation until macOS Accessibility is granted | Settings and the Activity surface explain the blocked permission |
| paused | enabled but not armed; the current activity closes into an `OFF` interval | menu-bar and dashboard remain available |
| armed | elapsed-time sampling, classification, reporting, and eligible nudges run | closing the Mimir window hides it; the process and Tracker continue |
| break | one explicit persisted `Break` interval runs until its wall-clock end | break state survives renderer/window recreation and Mimir relaunch |
| unsupported | configuration/history remain usable, but native collection is unavailable | current collection support is macOS |
| error | durable data remains queryable; the diagnostic is visible | the worker retries on later ticks where applicable |

The default enabled configuration polls every 15 seconds, confirms a changed
activity for 20 seconds, and backdates AFK to the actual input-idle boundary
after five minutes. These are persisted configuration values rather than
tick-count assumptions. App Nap, suspend, and delayed work therefore stretch
wall-clock intervals instead of fabricating a number of samples.

Tracker is installed during native bootstrap and flushed before the Routine and
Activity shutdown sequence. Normal Mimir window close remains hide-on-close;
explicit Quit follows the existing dirty-editor guard and then closes the
current Tracker block, stores shutdown time, and checkpoints SQLite. Launch at
login defaults on when Tracker is enabled, starts the first workbench window
hidden through an internal background-launch flag, and is automatically removed
when Tracker is disabled. A normal launch or Dock reopen still reveals Mimir.

## Native authority

`src-tauri/src/tracker/` owns the complete runtime:

- `model.rs`: configuration, status, activity, query, report, classification,
  and import IPC types;
- `platform.rs`: macOS app/title/domain/idle evidence and permission access,
  with cross-platform compile stubs;
- `engine.rs`: confirmation, AFK/OFF/Break transitions, merging, and queueing;
- `store.rs`: schema, indexed queries, classifications, AI usage, nudge
  history, import transactions, recovery, and checkpoints;
- `report.rs`: exact clipped aggregates, local-day/DST splitting, heatmap,
  streak, and rankings;
- `import.rs`: preview and one-shot Argus migration;
- `runtime.rs`: worker lifecycle, tray, autostart, AI batches, nudges, events,
  and Tauri commands.

The renderer is a projection over that authority:

- `src/services/tracker.js` is the sole invoke/event bridge;
- `src/stores/tracker.js` owns one reconciled Pinia status projection;
- `src/mimir/apps/TrackerApp.vue` and `src/mimir/apps/tracker/` own the
  dashboard;
- `src/shared/ui/settings/TrackerSettingsPanel.vue` owns opt-in, privacy,
  runtime, and migration controls.

The dashboard is a flat time instrument rather than a generic card grid. Day
uses one exact-width timeline ruler; Week, Month, and All use ledgers, stacked
daily evidence, composition, rankings, and a weekday/hour heatmap. The activity
log remains the inspectable evidence layer, and Classifications is the manual
correction surface. All geometry is SVG/CSS using Mimir theme tokens; no
localhost server or bundled Argus dashboard is involved.

## Evidence collection and privacy

Tracker stores only evidence needed to reproduce the timeline:

| Evidence | Default | Implementation and boundary |
|---|---|---|
| frontmost app and bundle id | on while enabled | native `NSWorkspace`; no Accessibility permission |
| window title | on while enabled | native macOS Accessibility API query; capped at 512 characters |
| browser domain | off | per-browser AppleScript Automation; URL is parsed immediately and only the normalized host is retained |
| input idle time | on while enabled | `IOHIDSystem` idle duration; converted to an AFK boundary |
| Mimir pane context | on for Mimir itself | renderer sends only a bounded context label such as editor, terminal, or agent |
| screenshot or screen pixels | never | not implemented or requested |

Permissions are lazy. Disabled Tracker rejects the Accessibility command in
Rust. Enabling does not itself open System Settings; the user chooses the
visible access action. Turning title collection off removes the Accessibility
requirement and app identity continues through `NSWorkspace`. Browser
Automation is a second explicit switch and a denied browser degrades to
app-level evidence.

Window titles and browser domains are the most sensitive local data Mimir
persists. They are not added to `mimir_state`, Business graph context, public
agent tools, or automatic MCP projection. Tracker has no public agent tools.
Titles are also excluded from AI prompts by default; the separate
`includeWindowTitlesInAi` switch is required to send them.

## Timeline and classification

The engine keys observations by bundle/app plus optional browser domain and
Mimir context. A short foreground glance does not fragment the timeline:
Tracker keeps the prior interval until the new key has remained present for
the configured confirmation window, then places the transition at the first
observation of that candidate.

System intervals are explicit:

- `AFK` begins at `observed_at - idle_duration`, not at the later poll;
- `OFF` records pause, disable, clean shutdown/relaunch gaps, and app-not-running
  recovery with a reason;
- `Break` is a persisted manual interval and is not reclassified;
- `UNKNOWN` preserves unclassified evidence until a rule is available.

Mimir context receives a deterministic Work subcategory without AI. Exact
manual rules always win. An app-level manual rule also corrects matching
app-plus-domain history; a domain-specific rule remains exact. Unknown keys are
durably queued and grouped into bounded batches of 25.

AI classification uses Mimir's model registry, provider host policy, native
transport, and keychain-backed credentials. `auto` uses Mimir's configured
model policy; a concrete stored id pins that model. The prompt receives
app/bundle and optional domain, plus title only after the separate opt-in.
Usage and estimated cost are recorded in Tracker's database, retries are
durable, and the combined classification/nudge daily cost cap is enforced
before a new call. Manual corrections supersede both imported and AI rules.

## Nudges and breaks

Nudges are native notifications generated only for a current Leisure interval,
or Other when `nudgeOther` is explicitly enabled. The state machine enforces:

- a grace period before the first message;
- minimum spacing and a per-interval maximum;
- no nudge during the configured lunch window;
- an earned-break allowance after a sufficiently long Work interval;
- no end-of-day nudge after the configured daily Work threshold;
- the same daily AI cost cap as classification.

Mimir asks the selected model for a short, non-judgmental notification. Missing
credentials, provider failure, an invalid response, or a reached cost cap uses
a local bounded fallback message instead. Nudge session/time/source records are
durable so restarting the renderer cannot reset the maximum.

Break can be started or ended from the Activity surface or Tracker menu-bar
item. Rust rejects starting a break while Tracker is disabled. The default
menu action is 20 minutes; command input is clamped to 1–240 minutes.

## Persistence and recovery

Canonical storage is `~/.mimir/tracker/tracker.sqlite`. SQLite uses WAL mode,
foreign keys, an application schema version, and indexed time/key/source
queries. Tables cover:

- one configuration row and one runtime-state row;
- activity blocks;
- classification rules and durable classification jobs;
- AI usage;
- nudge events;
- completed imports and their report.

Configuration and runtime-state JSON are forward-compatible through serde
defaults. Invalid values recover to defaults with a diagnostic. A database
that cannot be opened or passes neither schema initialization nor integrity
handling is moved, with its WAL/SHM sidecars, to a
`tracker.corrupt-<timestamp>.sqlite` sibling before a clean database is
created. A database from a newer schema version fails closed instead of being
overwritten. Normal shutdown closes the live block and runs a WAL checkpoint.

Disabling never deletes history. To deliberately remove all Tracker data, quit
Mimir first and remove `~/.mimir/tracker/`; this is intentionally not combined
with the enable switch.

## Argus migration

Settings previews `~/.argus/activities.json` and
`~/.argus/classifications.json` by default. A custom directory and IANA
timezone are supported through IPC. Preview is read-only and reports counts,
source hash, prior-import state, and bounded diagnostics.

Safe cutover order:

1. Quit the legacy `/Applications/Argus.app` and prevent its launchd job from
   restarting.
2. Keep Tracker disabled.
3. Inspect the preview and confirm the import timezone.
4. Import once.
5. Review a Day and Classifications sample, then enable Tracker.

Import refuses while the legacy Argus executable is running or Tracker is
enabled. It hashes both source files, records completed hashes, and is
idempotent. The entire block/rule/import record write is one SQLite
transaction. Zero-duration, reversed, malformed timestamp, invalid category,
and system-category rule anomalies are skipped and counted; ambiguous
fall-back timestamps use the earlier start and later end. Existing manual
Tracker rules retain precedence. Argus source files are never changed or
deleted.

## IPC and events

Registered commands:

```text
tracker_status
tracker_config_update
tracker_set_enabled
tracker_set_armed
tracker_start_break
tracker_end_break
tracker_query
tracker_report
tracker_classifications
tracker_classification_update
tracker_import_preview
tracker_import_argus
tracker_accessibility_request
tracker_context_update
```

`mimir://tracker-changed` is a revision notification carrying the latest
status projection. Consumers install its listener before the initial
`tracker_status` drain. `mimir://tracker-open` asks the Workbench to reveal the
singleton Tracker Activity after a menu-bar click. Neither event is a durable
queue; SQLite remains authority.

## Verification

Focused native coverage includes transition confirmation, AFK backdating,
Mimir deterministic classification, exact range clipping, DST changes,
pagination, durable reopen, corruption quarantine, manual precedence,
transactional/idempotent migration, disabled privacy guards, and break
recovery. `tracker_status`, `tracker_query`, and `tracker_report` have typed
golden IPC fixtures shared with renderer tests.

Renderer coverage includes service command names, listener-before-drain store
hydration, complete configuration updates, built-in routing, optional enable
behavior, timeline geometry, manual rule correction, and dashboard hydration
from the Rust golden fixtures.

Run the full verification matrix from the repository root:

```bash
bun run test
bun run build
bun run check:commands
bun run docs:check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Real desktop smoke should cover disabled startup, lazy Accessibility,
title-off app-only collection, optional browser Automation, hide-on-close,
login relaunch, tray pause/break/open/Quit, sleep/wake, notifications, and an
Argus preview/import against a copied source directory.
