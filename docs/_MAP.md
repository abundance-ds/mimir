# Codebase map

Read the owning document before a change. Also check [gotchas.md](gotchas.md)
and [issues.md](issues.md); UI work also requires
[design-system.md](design-system.md).

Doc rules: write for expert agents that can read the code. Keep only
non-obvious invariants, decisions with their reason, ownership, and locations.
No UI walk-throughs, test listings, dated results, or history. One owner per
topic; other docs link to it.

## Product shape

- `src/main.js` mounts the Tauri workbench. `?view=editor` mounts the Editor
  alone.
- `src/mimir/WorkbenchApp.vue` composes Sidebar, Activity, and Editor panes.
- `src-tauri/src/lib.rs` initializes native runtimes and registers commands.
- Renderer IPC belongs in `src/services/`; shared state belongs in Pinia stores.

## Change routing

| Area | Owning document | Main source |
|---|---|---|
| Workbench, navigation, Go to | [workbench-design.md](workbench-design.md) | `src/mimir/components/`, `src/mimir/composables/`, `src/mimir/quickOpenResults.js`, `src/stores/workbench.js`, `src/shared/shortcuts.js` |
| Tokens, themes, controls | [design-system.md](design-system.md) | `src/shared/styles/`, `src/shared/ui/` |
| Shell chrome: bars, bands, footers, layers | [chrome-ui.md](chrome-ui.md) | `src/shared/ui/chrome/`, `src/shared/styles/pane-chrome.css`, `src/mimir/paneControls.js`, `src/mimir/paneChromeInventory.js` |
| Activities, terminals, agents | [activities.md](activities.md), [agent-setup.md](agent-setup.md) | native `activities/`, `activity_commands.rs`, `launchers.rs`, `agent_packages.rs`; renderer Activity stores and surfaces |
| Files and Project Git | [files.md](files.md) | `file_index*.rs`, `file_open.rs`, `workspace_files.rs`, `git.rs`, `managed_git.rs`; Files Activity and stores |
| Business graph and Team Git | [business-graph.md](business-graph.md) | native `business_graph/`, `workspace_config.rs`; graph service, store, and app |
| Scribe | [meetings.md](meetings.md) | native `meetings/`, `meeting_filing.rs`; Scribe service, store, and app |
| Tracker | [tracker.md](tracker.md) | native `tracker/`; Tracker service, store, app, and settings |
| Editor, diffs, comments | [editor-system.md](editor-system.md), [comments.md](comments.md) | `src/editor/`, file/diff/comment stores; native `document_files.rs`, `document_reviews.rs`, `spelling.rs` |
| Shared Scratchpad | [scratchpad.md](scratchpad.md) | native `scratchpad.rs`; Scratchpad service, store, and Editor components |
| Inline and provider AI | [ai-system.md](ai-system.md), [inline-ai.md](inline-ai.md) | native `ai*`; `src/services/ai/`, Inline AI, ghost extension |
| Tools and agent API | [agent-interface.md](agent-interface.md), [mcp.md](mcp.md) | `tool_*`, `mimir_cli.rs`, `connections.rs`, `connections/`, `shell_exec.rs`, `bin/mimir*`, `skills/` |
| Apps | [apps-system.md](apps-system.md) | `apps.rs`, app catalog, hosts, and SDK |
| Routines | [routines.md](routines.md) | `routines.rs`, `routine_runtime.rs`, Routine store and Activity |
| Chat | [chat.md](chat.md) | native `chat/`; chat service, store, and surfaces |
| Settings and stored state | [settings.md](settings.md) | `local_settings.rs`, `persistence.rs`, `session.rs`, session and settings stores |
| Bootstrap, shutdown, IPC | [runtime-architecture.md](runtime-architecture.md), [ipc.md](ipc.md) | `lib.rs`, bootstrap composables, quit and close guards |
| Security boundaries | [security.md](security.md) | native validation, capabilities, keychain, tool projection |
| Build, test, release | [building.md](building.md), [testing.md](testing.md), [updates.md](updates.md) | package scripts, `scripts/`, CI, Tauri configuration, `ipc_fixtures.rs`, `upgrade_fixtures.rs`, `harness/` |

Tests normally sit beside renderer source. Native unit tests sit in their Rust
module; cross-process CLI tests are in `src-tauri/tests/`.

## Local data

| Path | Contents |
|---|---|
| `~/.mimir/private/` | Private graph, skills, and agents |
| `~/.mimir/team-graph/` | Mimir-managed Team Git checkout |
| `<workspace>/.mimir/workspace.toml` | Workspace identity and Project/Graph link |
| `~/.mimir/activities/` | Durable Activity database |
| `~/.mimir/meetings/`, `meetings.json` | Scribe database, owned artifacts, configuration |
| `~/.mimir/models.json`, `models/stt/` | AI model state; downloaded Whisper models |
| `~/.mimir/tracker/` | Tracker database |
| `~/.mimir/chat.sqlite3`, `chat.json` | Chat history and configuration |
| `~/.mimir/routines/`, `routines-state.json`, `launchers.json` | Routine definitions, planner cursor, launcher presets |
| `~/.mimir/apps/`, `app-data/<app-id>/` | Local App definitions and data |
| `~/.mimir/scratchpad.md`, `scratchpad-history.json`, `scratchpad-links.json` | Shared Scratchpad, timeline, prepared links |
| `~/.mimir/settings.json`, `session.json`, `proposals.json`, `document-reviews/` | Workbench and Editor state |
| `~/.mimir/bin/` | Installed `mimir` CLI |
| `~/.mimir/keys.env` | Debug-only key fallback |
| `~/.agents/skills/` | Projected Mimir skills and unrelated user skills |

Other roots: `bin/` CLIs, `skills/` packaged skills, `scripts/` verification
and release helpers, `harness/` fixture pages for browser checks, `deploy/chat/`
chat service.
