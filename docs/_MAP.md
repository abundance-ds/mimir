# Codebase map

Read the owning document before a change. Also check [gotchas.md](gotchas.md)
and [issues.md](issues.md); UI work also requires
[design-system.md](design-system.md).

## Product shape

- `src/main.js` mounts the Tauri workbench. `?view=editor` mounts the Editor
  alone.
- `src/mimir/WorkbenchApp.vue` composes Sidebar, Activity, and Editor panes.
- `src-tauri/src/lib.rs` initializes native runtimes and registers commands.
- Renderer IPC belongs in `src/services/`; shared state belongs in Pinia stores.

## Change routing

| Area | Owning document | Main source |
|---|---|---|
| Workbench and navigation | [workbench-design.md](workbench-design.md) | `src/mimir/components/`, `src/mimir/composables/`, `src/stores/workbench.js` |
| Shell chrome: bars, bands, footers, layers | [chrome-ui.md](chrome-ui.md) | `src/shared/ui/chrome/`, `src/shared/styles/pane-chrome.css`, `src/mimir/paneControls.js`, `src/mimir/paneChromeInventory.js` |
| Activities, terminals, agents | [activities.md](activities.md), [agent-setup.md](agent-setup.md) | native `activities/`, `activity_commands.rs`, `launchers.rs`; renderer Activity stores and surfaces |
| Files and Project Git | [files.md](files.md) | `file_index*.rs`, `workspace_files.rs`, `git.rs`, `managed_git.rs`; Files Activity and stores |
| Business graph and Team Git | [business-graph.md](business-graph.md) | native `business_graph/`; graph service, store, and app |
| Scribe | [meetings.md](meetings.md) | native `meetings/`, `meeting_filing.rs`; Scribe service, store, and app |
| Tracker | [tracker.md](tracker.md) | native `tracker/`; Tracker service, store, app, and settings |
| Editor, diffs, comments | [editor-system.md](editor-system.md), [comments.md](comments.md) | `src/editor/`, file/diff/comment stores |
| Shared Scratchpad | [scratchpad.md](scratchpad.md) | native `scratchpad.rs`; Scratchpad service, store, and Editor components |
| Inline and provider AI | [ai-system.md](ai-system.md), [inline-ai.md](inline-ai.md) | native `ai*`; `src/services/ai/`, Inline AI, ghost extension |
| Tools and agent API | [agent-interface.md](agent-interface.md), [mcp.md](mcp.md) | `tool_*`, `mimir_cli.rs`, `bin/mimir*` |
| Apps | [apps-system.md](apps-system.md) | `apps.rs`, app catalog, hosts, and SDK |
| Routines | [routines.md](routines.md) | `routines.rs`, `routine_runtime.rs`, Routine store and Activity |
| Chat | [chat.md](chat.md) | native `chat/`; chat service, store, and surfaces |
| Settings and stored state | [settings.md](settings.md) | `local_settings.rs`, `persistence.rs`, session and settings stores |
| Bootstrap, shutdown, IPC | [runtime-architecture.md](runtime-architecture.md), [ipc.md](ipc.md) | `lib.rs`, bootstrap composables, quit and close guards |
| Security boundaries | [security.md](security.md) | native validation, capabilities, keychain, tool projection |
| Build, test, release | [building.md](building.md), [testing.md](testing.md), [updates.md](updates.md) | package scripts, CI, Tauri configuration, release scripts |

Tests normally sit beside renderer source. Native unit tests sit in their Rust
module; cross-process CLI tests are in `src-tauri/tests/`.

## Local data

| Path | Contents |
|---|---|
| `~/.mimir/private/` | Private graph, skills, and agents |
| `~/.mimir/team-graph/` | Mimir-managed Team Git checkout |
| `<workspace>/.mimir/workspace.toml` | Workspace identity and Project/Graph link |
| `~/.mimir/activities/` | Durable Activity database |
| `~/.mimir/meetings/` | Scribe database and owned artifacts |
| `~/.mimir/tracker/` | Tracker database |
| `~/.mimir/settings.json`, `session.json`, `proposals.json` | Workbench and Editor state |
| `~/.mimir/keys.env` | Debug-only key fallback |
| `~/.agents/skills/` | Projected Mimir skills and unrelated user skills |

Other roots: `bin/` contains CLIs, `skills/` contains packaged skills,
`scripts/` contains verification and release helpers, and `deploy/chat/`
contains the chat service.
