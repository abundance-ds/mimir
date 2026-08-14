# Codebase map

Routing map: a subsystem's canonical owners, docs, and tests. Source is
canonical for implementation detail. Before editing, check
[gotchas.md](gotchas.md) (constraints) and [issues.md](issues.md) (defects);
for UI work read [design-system.md](design-system.md).

## Product shape

One Tauri window, three mounted panes:

| Pane | Owner | Contents |
|---|---|---|
| Sidebar | `src/mimir/components/WorkbenchSidebar.vue` | Tools, Chats/rooms, fresh-run sources, active Activities, Settings |
| Activity | `src/mimir/components/ActivityHost.vue` | terminal/agent PTYs, Files, Routines, Chats, app instances |
| Editor | `src/editor/App.vue` | Markdown tabs, inline AI, ghost completion, diff review, comments |

`src/mimir/WorkbenchApp.vue` composes the panes;
`src/mimir/components/WorkbenchShell.vue` and `src/stores/workbench.js` own
resizing, rails, widths, and Activity navigation history.

## Entry points

- `src/main.js` mounts `src/mimir/App.vue`; `?view=editor` mounts
  `src/editor/App.vue` as a standalone editor surface.
- `src-tauri/src/main.rs` → `src-tauri/src/lib.rs`: main window; initializes
  Activities, Routines, Tracker, tool registry, MCP endpoint, file indexing,
  chat runtime, and `mimir`.
- Startup ordering: Rust registers core tools during Tauri setup; the renderer
  starts the MCP socket only after installing tool-relay listeners; editor
  hydration completes before its persistence watcher. See
  [runtime-architecture.md](runtime-architecture.md) and [ipc.md](ipc.md).

## Change routing

| Change | Read | Canonical owners | Focused tests |
|---|---|---|---|
| Tauri bootstrap/window/quit | [runtime architecture](runtime-architecture.md), [IPC](ipc.md), [persistence](persistence.md) | `src-tauri/src/lib.rs`, `src/editor/windowCloseGuard.js`, `appQuit.js` | close/quit/session tests; relevant Rust module |
| Workbench panes/navigation | [workbench design](workbench-design.md) | `WorkbenchApp.vue`, `WorkbenchShell.vue`, `stores/workbench.js`, responsive/resize/key modules | Workbench/Shell/resize/responsive/key tests |
| Activity/PTY/agent lifecycle | [activities](activities.md), [agent setup](agent-setup.md), [persistence](persistence.md) | native `activities/`, `activity_commands.rs`, `launchers.rs`; renderer Activity stores/surfaces | native supervisor/model/status/scrollback; Activity stores/components |
| Team chat and chat-linked agents | [Chats](chat.md), [security](security.md), [MCP](mcp.md) | native `chat/`; chat service/store; Chat Activity/sidebar/header/settings; `deploy/chat/` | native chat/db; chat service/store/components; production protocol smoke |
| MCP/tool/provider | [MCP](mcp.md), [IPC](ipc.md), [security](security.md) | `tool_registry.rs`, `tool_bridge.rs`, `tool_runtime.rs`, `tool_server.rs`, renderer relays | four Rust tool modules; `toolRuntime.test.js`, app host/catalog tests |
| Files/tree/search/preview/mutation | [files](files.md), [Editor](editor-system.md), [security](security.md) | `file_index.rs`, `workspace_files.rs`, Files store/service/activity/row, Editor typed-preview path | native file modules; workspace/file stores; Files Activity; Editor preview tests |
| Apps/SDK/local tools | [Apps](apps-system.md), [IPC](ipc.md), [security](security.md) | `apps.rs`, Apps catalog store/service/settings, embedded/launch-plan hosts, SDK | `apps.rs`; catalog/settings/app host tests |
| Business graph/Issue Board/CRM | [Business graph](business-graph.md), [MCP](mcp.md), [persistence](persistence.md) | native `business_graph/`; graph service/store; `BusinessGraphApp.vue` and projection components; Workbench Start Work handoff | native graph modules/fixtures/performance; graph store/service/app/projection/CLI tests |
| Tracker/Argus migration | [Tracker](tracker.md), [persistence](persistence.md), [security](security.md) | native `tracker/`; Tracker service/store; `TrackerApp.vue`, tracker components, Apps Settings panel; Workbench optional-app projection | native engine/store/report/import/runtime; tracker service/store/app/settings/timeline/classification tests |
| Routines/scheduler | [Routines](routines.md), [persistence](persistence.md) | `routines.rs`, `routine_runtime.rs`, Routine store/service/activity | native schema/runtime; Routine store/service/activity |
| Scribe meetings/capture/transcription/follow-up | [Scribe meetings](meetings.md), [security](security.md), [persistence](persistence.md) | native `meetings/`, `crates/mimir-meeting-{audio,detect}`; Scribe service/store/app/settings; meeting hooks in `routine_runtime.rs` | Gherkin evidence; native runtime/audio/detection/STT/job/tool tests; Scribe service/store/app; packaged macOS hardware |
| Editor/tabs/diffs/proposals | [Editor](editor-system.md), [IPC](ipc.md), [persistence](persistence.md) | `editor/App.vue`, editor composables/CodeMirror, editor stores, proposal coordinator in `lib.rs` | editor/store/composable tests; proposal Rust logic |
| Inline/ghost/provider AI | [AI system](ai-system.md), [inline AI](inline-ai.md), [security](security.md) | native `ai*` modules/resources; renderer `services/ai/`, `InlineAI.vue`, ghost extension | native AI tests; AI service/model/InlineAI/ghost tests |
| Settings/theme/layout persistence | [settings](settings.md), [persistence](persistence.md) | `stores/settings.js`, `local_settings.rs`, settings UI, workbench persistence | native settings; settings store/UI/workbench tests |
| Installed app updates | [updates](updates.md), [building](building.md) | `stores/appUpdate.js`, `services/appUpdates.js`, update toast/settings, native restart guard, Tauri updater config | update store/UI/native-lifecycle tests; release artifact and feed tests |
| Build/test/release | [building](building.md), [testing](testing.md) | package scripts, Vite/Vitest config, `src/test/setup.js`, CI workflow, command drift, supply-chain inventory, and source-bound release helpers | full verification set; script unit checks; `src-tauri/tests/mimir_cli_contract.rs` |

## Frontend map

- Workbench shell: `src/mimir/WorkbenchApp.vue` (orchestration),
  `src/mimir/components/` (shell, rails, sidebar, project switcher,
  quick-open, pane host), `src/mimir/composables/` (Activity lifecycle,
  bootstrap, keyboard routing, resize, pointer reorder),
  `src/mimir/quickOpenResults.js` (grouping, scope grammar, ranking, bounds). Docs:
  [workbench-design.md](workbench-design.md).
- Activities: `src/mimir/activities/` (Terminal, Files, App, Routines, Chat
  surfaces), `src/stores/activities.js` (records),
  `src/stores/activityRuntime.js` (native lifecycle, PTY I/O, resume),
  `src/stores/launchers.js`, `src/services/activities.js`,
  `src/services/launchers.js`. Docs: [activities.md](activities.md),
  [agent-setup.md](agent-setup.md).
- Chat: `src/stores/chat.js`, `src/services/chat.js`,
  `src/services/chatNotifications.js`,
  `src/mimir/activities/ChatActivity.vue`,
  `src/mimir/components/ChatSidebarSection.vue`. Docs: [chat.md](chat.md).
- Files: `src/stores/workspaceFiles.js` (index/tree state),
  `src/services/fileIndex.js`, `src/services/workspaceFileOperations.js`,
  `src/mimir/files/` (selection/favorites/mutations/drop composables),
  `src/mimir/components/FileTreeRow.vue`, `src/services/fileSystem.js`,
  `src/stores/files.js` (typed tabs, dirty state, recents). Docs:
  [files.md](files.md).
- Apps: `src/stores/appsCatalog.js`, `src/services/appsCatalog.js`,
  `src/mimir/apps/` (Today, Business graph, Tracker, embedded/launch-plan hosts),
  `src/shared/ui/settings/AppsSettingsSection.vue`,
  `src/apps/sdk/mimir-sdk.js`. Docs: [apps-system.md](apps-system.md).
- Tracker UI: `src/mimir/apps/TrackerApp.vue`,
  `src/mimir/apps/tracker/` (timeline, overview, log, classifications),
  `src/stores/tracker.js`, `src/services/tracker.js`, and
  `src/shared/ui/settings/TrackerSettingsPanel.vue`. Docs:
  [tracker.md](tracker.md).
- Business graph UI: `src/mimir/apps/BusinessGraphApp.vue` (scope/projection
  shell), `src/mimir/apps/business-graph/` (board, portfolio, timeline,
  inspector, dispatch bar, create flows), `src/stores/businessGraph.js`,
  `src/services/businessGraph.js`. Docs: [business-graph.md](business-graph.md).
- Routines: `src/stores/routines.js`, `src/services/routines.js`,
  `src/mimir/activities/RoutinesActivity.vue`,
  `src/mimir/activities/routineSchedule.js` (cron ↔ builder mapping). Docs:
  [routines.md](routines.md).
- Scribe: `src/stores/meetings.js`, `src/services/meetings.js`,
  `src/mimir/apps/ScribeApp.vue`, `src/mimir/apps/scribe/`, and the persistent
  sidebar recording control. Docs: [meetings.md](meetings.md).
- Editor: `src/editor/App.vue` (orchestration, editor bridge),
  `src/editor/composables/` (session/native/proposal lifecycle, command API,
  content sync, document bridge, keyboard),
  `src/editor/components/workspace/` (tabs, surface, inline AI, diffs),
  `src/editor/codemirror/` (core factory, formatting, live preview, ghost,
  comments), `src/stores/files.js` + `diff.js` + `comments.js` +
  `editorUI.js`, `src/services/ai/` (+ `src/services/ai/tools/`),
  `src/services/comments/`. Docs: [editor-system.md](editor-system.md),
  [inline-ai.md](inline-ai.md), [comments.md](comments.md),
  [ai-system.md](ai-system.md).
- Shared UI/settings: `src/shared/styles/` (tokens, themes, diff styles),
  `src/shared/ui/SettingsDialog.vue`, `src/shared/ui/settings/`,
  `src/shared/ui/UpdateToast.vue`, `src/stores/settings.js`,
  `src/stores/appUpdate.js`, `src/services/appUpdates.js`, `src/shared/workbenchZoom.js`,
  `src/shared/fonts.js`. Docs: [design-system.md](design-system.md),
  [settings.md](settings.md), [updates.md](updates.md).

## Rust map

- Activity runtime: `src-tauri/src/activities/` (model, supervisor,
  scrollback, store, status), `src-tauri/src/activity_commands.rs`,
  `src-tauri/src/launchers.rs` (presets, detection, argv, MCP injection),
  `src-tauri/src/mimir_cli.rs` (installs `mimir`, skills, Pi extension).
  Docs: [activities.md](activities.md), [agent-setup.md](agent-setup.md).
- MCP/tools: `src-tauri/src/tool_registry.rs`, `src-tauri/src/tool_bridge.rs`,
  `src-tauri/src/tool_runtime.rs`, `src-tauri/src/tool_server.rs`,
  `src-tauri/src/connections.rs` (Google/Slack/Granola),
  `src-tauri/src/shell_exec.rs`; CLI `bin/mimir.mjs`, `bin/mimir-skills.mjs`,
  `bin/pi-mimir-extension.ts`; end-to-end contract test
  `src-tauri/tests/mimir_cli_contract.rs`. Docs: [mcp.md](mcp.md),
  [agent-interface.md](agent-interface.md).
- Chat: `src-tauri/src/chat/` (WebSocket session, SQLite/FTS cache,
  membership/unread, room-bound tools). Docs: [chat.md](chat.md).
- Business graph: `src-tauri/src/business_graph/` (store, runtime, markdown,
  migration, context, performance), `src-tauri/src/business_graph/tools/`
  (per-domain MCP modules). Docs: [business-graph.md](business-graph.md).
- Tracker: `src-tauri/src/tracker/` (platform sampler, engine, SQLite store,
  reports, Argus import, lifecycle/AI/nudges). Docs:
  [tracker.md](tracker.md).
- Files: `src-tauri/src/file_index.rs`,
  `src-tauri/src/file_index_commands.rs`, `src-tauri/src/workspace_files.rs`,
  `src-tauri/src/file_open.rs`, `src-tauri/src/git.rs`. Docs:
  [files.md](files.md).
- Apps/Routines: `src-tauri/src/apps.rs`, `src-tauri/src/routines.rs`,
  `src-tauri/src/routine_runtime.rs`. Docs: [apps-system.md](apps-system.md),
  [routines.md](routines.md).
- Scribe: `src-tauri/src/meetings/`,
  `src-tauri/crates/mimir-meeting-audio/`, and
  `src-tauri/crates/mimir-meeting-detect/`. Docs:
  [meetings.md](meetings.md).
- AI: `src-tauri/src/ai.rs`, `src-tauri/src/ai_proxy.rs`,
  `src-tauri/src/ai_keys.rs`, `src-tauri/src/ai_models.rs`,
  `src-tauri/src/ai_providers.rs`, `src-tauri/src/ai_transport.rs`,
  `src-tauri/src/ai_usage.rs`. Docs: [ai-system.md](ai-system.md).
- Persistence/settings: `src-tauri/src/session.rs`,
  `src-tauri/src/persistence.rs`, `src-tauri/src/local_settings.rs`. Docs:
  [persistence.md](persistence.md), [settings.md](settings.md).

IPC relays, cancellation, file-open queuing, proposal events, and server lease
ordering: [ipc.md](ipc.md).

## Other directories

| Path | Contents |
|---|---|
| `bin/` | `mimir` CLI, skills storage, Pi extension |
| `deploy/chat/` | team chat server stack; ops runbook `deploy/chat/README.md` |
| `harness/` | standalone HTML/JS harnesses for Business graph views |
| `skills/` | repo-local agent skills (`skills/mimir-config`, `skills/mimir-graph`, `skills/mimir-meetings`) |
| `scripts/` | build/test/release/check scripts, including SPDX/license generation and exact source-bound artifact staging |
| `.github/workflows/build.yml` | CI |

## Local data

| Path | Owner |
|---|---|
| `~/.mimir/launchers.json` | launcher presets |
| `~/.mimir/activities/` | Activity SQLite event/checkpoint store and legacy v1 migration files |
| `~/.mimir/apps/` | local app TOML and app directories |
| `~/.mimir/app-data/` | app-owned JSON values |
| `~/.mimir/graph/private/` | private local Business graph Markdown |
| `~/.mimir/tracker/tracker.sqlite` | Tracker configuration, timeline, classifications, usage, nudges, and imports |
| `~/.mimir/routines/` | routine TOML |
| `~/.mimir/routines-state.json` | next-fire planner state |
| `~/.mimir/meetings.json` | native Scribe settings, excluding credentials |
| `~/.mimir/meetings/` | meeting database, channel audio, content, artifacts, and exports |
| `~/.mimir/models/stt/` | verified Scribe local model artifacts and state |
| `~/.mimir/settings.json` | editor/workbench/settings data |
| `~/.mimir/session.json` | open editor tabs, drafts, recents, and zoom |
| `~/.mimir/models.json` | inline/ghost AI provider and model registry |
| `~/.mimir/bin/` | installed `mimir` |
| `~/.mimir/pi/mimir-tools.ts` | installed Pi extension |
| `~/.mimir/skills/` | canonical skills, revisions, manifests, Claude snapshots |
| `~/.mimir/connections/granola.sqlite` | native Granola cache when no predecessor cache exists |
| `~/.agents/skills/` | Mimir-managed catalog/personal projection plus unrelated user skills |
| `~/.mimir/keys.env` | debug-only plaintext key fallback |

## Documentation

| Document | Purpose |
|---|---|
| [agent-interface.md](agent-interface.md) | public agent tools, discovery CLI, skills contract |
| [synthesis.md](synthesis.md) | product laws |
| [acceptance.md](acceptance.md) | release behavior contract |
| [building.md](building.md) | prerequisites, dev loop, packaging |
| [updates.md](updates.md) | signed update feed, UI states, restart safety |
| [testing.md](testing.md) | verification suite, test topology, change-to-test routing |
| [runtime-architecture.md](runtime-architecture.md) | bootstrap, hydration ordering, shutdown |
| [ipc.md](ipc.md) | service boundary, commands/events, relay ordering, proposal coordination |
| [persistence.md](persistence.md) | write ownership, atomic writes, quarantine |
| [settings.md](settings.md) | settings mutation, flush, cross-window sync |
| [security.md](security.md) | trusted-local model and capability boundaries |
| [ai-system.md](ai-system.md) | model registry, credentials, providers, transport |
| [agent-setup.md](agent-setup.md) | launchers, client attachment, resume, MCP injection |
| [activities.md](activities.md) | execution lifecycle, PTY, scrollback, status |
| [chat.md](chat.md) | chat architecture and room-linked agents; ops in `deploy/chat/README.md` |
| [mcp.md](mcp.md) | registry contract, loopback transport, public projection |
| [business-graph.md](business-graph.md) | GraphStore, ontology, scopes, projections, tools, migration |
| [tracker.md](tracker.md) | optional collector, timeline, privacy, AI/nudges, Argus migration |
| [files.md](files.md) | file index, search, quick-open, typed tabs |
| [apps-system.md](apps-system.md) | local app formats and SDK |
| [routines.md](routines.md) | scheduler and routine TOML |
| [meetings.md](meetings.md) | Scribe capture, transcription, recovery, follow-up, UX, privacy |
| [editor-system.md](editor-system.md) | Markdown editor and review flow |
| [inline-ai.md](inline-ai.md) | Cmd+K and ghost completion |
| [comments.md](comments.md) | pseudo-XML comments and inline UI |
| [workbench-design.md](workbench-design.md) | shell interaction grammar |
| [design-system.md](design-system.md) | tokens, styling rules, banned patterns |
| [gotchas.md](gotchas.md) | non-obvious constraints |
| [issues.md](issues.md) | known defects |
