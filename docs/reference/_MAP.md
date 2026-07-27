# Codebase map

This archived map routes Mim's dense implementation notes. Do not preload it or
[gotchas.md](gotchas.md); use it only when source and focused `mimx help` are
insufficient. Source remains canonical for local syntax and obvious behavior.

## Product shape

Mim is one Tauri window with three mounted panes:

| Pane | Owner | Contents |
|---|---|---|
| Sidebar | `src/mim/components/WorkbenchSidebar.vue` | stable Tools, fresh-run sources, live and archived Activities, Settings |
| Activity | `src/mim/components/ActivityHost.vue` | terminal/agent PTYs, Files, Routines, and launched app instances |
| Editor | `src/editor/App.vue` | Markdown tabs, inline AI, ghost completion, diff review, comments |

`src/mim/WorkbenchApp.vue` composes the panes and connects them to the Rust
runtimes. `src/mim/components/WorkbenchShell.vue` and
`src/stores/workbench.js` own resizing, pane rails, widths, and Activity
navigation history.

## Entry points

- `src/main.js` mounts `src/mim/App.vue` by default.
- `?view=editor` mounts `src/editor/App.vue` as a standalone editor surface.
- `src-tauri/src/main.rs` calls the Tauri library entry in
  `src-tauri/src/lib.rs`.
- `src-tauri/src/lib.rs` creates the main window and initializes Activities,
  Routines, the tool registry, the MCP endpoint, file indexing, and `mimx`.

Startup is split: Rust registers core tools during Tauri setup, but the
renderer starts the MCP socket only after installing tool-relay listeners.
Editor session hydration completes before its persistence watcher and native
listeners are installed. See
[runtime-architecture.md](runtime-architecture.md) and [ipc.md](ipc.md).

## Change routing

| Change | Read | Canonical owners | Focused tests |
|---|---|---|---|
| Tauri bootstrap/window/quit | [runtime architecture](runtime-architecture.md), [IPC](ipc.md), [persistence](persistence.md) | `src-tauri/src/lib.rs`, `src/editor/windowCloseGuard.js`, `appQuit.js` | close/quit/session tests; relevant Rust module |
| Workbench panes/navigation | [workbench design](workbench-design.md), [acceptance](acceptance.md) | `WorkbenchApp.vue`, `WorkbenchShell.vue`, `stores/workbench.js`, responsive/resize/key modules | Workbench/Shell/resize/responsive/key tests |
| Activity/PTY/agent lifecycle | [activities](activities.md), [agent setup](agent-setup.md), [persistence](persistence.md) | native `activities/`, `activity_commands.rs`, `launchers.rs`; renderer Activity stores/surfaces | native supervisor/model/status/scrollback; Activity stores/components |
| MCP/tool/provider | [MCP](mcp.md), [IPC](ipc.md), [security](security.md) | `tool_registry.rs`, `tool_bridge.rs`, `tool_runtime.rs`, `tool_server.rs`, renderer relays | four Rust tool modules; `toolRuntime.test.js`, app host/catalog tests |
| Files/tree/search/preview/mutation | [files](files.md), [Editor](editor-system.md), [security](security.md) | `file_index.rs`, `workspace_files.rs`, Files store/service/activity/row, Editor typed-preview path | native file modules; workspace/file stores; Files Activity; Editor preview tests |
| Apps/SDK/local tools | [Apps](apps-system.md), [IPC](ipc.md), [security](security.md) | `apps.rs`, Apps catalog store/service/settings, embedded/launch-plan hosts, SDK | `apps.rs`; catalog/settings/app host tests |
| Business graph/Issue Board/CRM | [Business graph](business-graph.md), [MCP](mcp.md), [persistence](persistence.md) | native `business_graph/`; graph service/store; `BusinessGraphApp.vue` and projection components; Workbench Start Work handoff | native graph modules/fixtures/performance; graph store/service/app/projection/CLI tests |
| Routines/scheduler | [Routines](routines.md), [persistence](persistence.md) | `routines.rs`, `routine_runtime.rs`, Routine store/service/activity | native schema/runtime; Routine store/service/activity |
| Editor/tabs/diffs/proposals | [Editor](editor-system.md), [IPC](ipc.md), [persistence](persistence.md) | `editor/App.vue`, editor composables/CodeMirror, editor stores, proposal coordinator in `lib.rs` | editor/store/composable tests; proposal Rust logic |
| Inline/ghost/provider AI | [AI system](ai-system.md), [inline AI](inline-ai.md), [security](security.md) | native `ai*` modules/resources; renderer `services/ai/`, `InlineAI.vue`, ghost extension | native AI tests; AI service/model/InlineAI/ghost tests |
| Settings/theme/layout persistence | [settings](settings.md), [persistence](persistence.md) | `stores/settings.js`, `local_settings.rs`, settings UI, workbench persistence | native settings; settings store/UI/workbench tests |
| Build/test/release | [building](building.md), [testing](testing.md) | package scripts, Vite/Vitest config, `src/test/setup.js`, CI workflow, `scripts/check-tauri-commands.mjs` | full verification set; `src-tauri/tests/mimx_contract.rs` |

## Frontend map

### Workbench and Activities

- `src/mim/WorkbenchApp.vue`: top-level orchestration and core Activity records
- `src/mim/composables/useActivityLifecycle.js`: Activity creation, close,
  archive, and status-tracking lifecycle extracted from WorkbenchApp
- `src/mim/composables/useWorkspaceBootstrap.js`: startup hydration, settings
  load, and restore sequence
- `src/mim/composables/useWorkbenchKeyboardRouting.js`: global keyboard dispatch
  for workbench-level shortcuts
- `src/mim/composables/useWorkbenchResize.js`: pane drag with rAF-coalesced
  store writes and exact flush on release
- `src/mim/composables/usePointerReorder.js`: drag-to-reorder for sidebar rows
- `src/mim/components/`: three-pane shell, rails, sidebar, recent-project
  switcher, quick-open, pane host
- `src/mim/activities/TerminalActivity.vue`: xterm-backed terminal and agent UI
- `src/mim/activities/FilesActivity.vue`: Project/Recent/Favorites composition,
  selection/action orchestration, Git decoration, and settings-backed favorites
- `src/mim/components/FileTreeRow.vue`: stateless tree-row presentation and ARIA
- `src/mim/activities/AppActivity.vue`: app-instance host selection
- `src/mim/activities/RoutinesActivity.vue`: complete file-backed routine CRUD,
  run/stop state, diagnostics, context menus, and keyboard control
- `src/stores/activities.js`: renderer Activity records
- `src/stores/activityRuntime.js`: native lifecycle, PTY I/O, resume, events
- `src/stores/launchers.js`: agent detection and launcher presets
- `src/services/activities.js`: Tauri Activity command wrappers
- `src/services/launchers.js`: Tauri launcher command wrappers

See [activities.md](activities.md) and [agent-setup.md](agent-setup.md).

### Files

- `src/stores/workspaceFiles.js`: metadata index/search state plus lazy
  directory children, expansion, and refresh caches
- `src/services/fileIndex.js`: native index/search wrappers
- `src/services/workspaceFileOperations.js`: inspect/list/create/rename,
  duplicate, Trash, reveal, and default-app wrappers
- `src/mim/activities/FilesActivity.vue`: Files state composition and operations
- `src/mim/components/FileTreeRow.vue`: tree/secondary-row rendering
- `src/mim/components/QuickOpen.vue`: global Cmd/Ctrl+P file jump
- `src/services/fileSystem.js`: editor text and binary I/O wrappers
- `src/stores/files.js`: typed tabs, clean-preview reuse, dirty state, recents

See [files.md](files.md).

### Apps

- `src/stores/appsCatalog.js`: catalog selection and Activity preparation
- `src/services/appsCatalog.js`: native catalog, launch, data, and tool relay
- `src/shared/ui/settings/AppsSettingsSection.vue`: search, launch, diagnostics,
  local scaffold/duplicate/title/Trash operations, and definition navigation
- `src/shared/ui/settings/AppSettingsSectionRows.vue`: keyboard catalog rows
- `src/mim/apps/`: Today, Business graph, embedded host, launch-plan
  host, and local app surfaces
- `src/mim/apps/BusinessGraphApp.vue`: scope/projection shell, graph loading,
  context trail, inspector orchestration, and Start Work event
- `src/mim/apps/business-graph/`: Board, list, portfolio, CRM, timeline,
  relationship graph, inspector, and create-flow components
- `src/stores/businessGraph.js`, `src/services/businessGraph.js`: graph
  projection state and typed native command boundary
- `src/apps/sdk/mim-sdk.js`: app bridge for data, files, HTTP, tools, and editor
- `src/apps/sdk/theme-base.css`: optional shared app theme base

See [apps-system.md](apps-system.md).

### Routines

- `src/stores/routines.js`: live catalog, source-aware mutations, and run state
- `src/services/routines.js`: native CRUD/reveal commands and change events
- `src/mim/activities/RoutinesActivity.vue`: scheduler control surface

See [routines.md](routines.md).

### Editor

- `src/editor/App.vue`: editor orchestration and public Mim editor bridge
- `src/editor/composables/useEditorSessionLifecycle.js`: session hydration,
  persistence watcher, and close-guard coordination
- `src/editor/composables/useEditorNativeLifecycle.js`: native menu, window
  events, and Tauri listener setup/teardown
- `src/editor/composables/useEditorProposalLifecycle.js`: proposal polling,
  apply/reject coordination, and batch-diff orchestration
- `src/editor/composables/useEditorCommandApi.js`: editor bridge command surface
  exposed to MCP tools and the workbench
- `src/editor/composables/useContentSync.js`: debounced doc↔store content sync
- `src/editor/composables/useDocumentBridge.js`: cross-window document context
- `src/editor/composables/useKeyboardShortcuts.js`: editor keyboard chord dispatch
- `src/editor/components/workspace/`: tabs, CodeMirror surface, inline AI, diffs
- `src/editor/codemirror/core.js`: CodeMirror extension composition factory
- `src/editor/codemirror/`: formatting, live preview, ghost, comments
- `src/stores/files.js`, `diff.js`, `comments.js`, `editorUI.js`: editor state
- `src/services/ai/`: inline/ghost model transport and provider helpers
- `src/services/ai/tools/`: renderer implementations for workspace MCP tools
- `src/services/comments/`: pseudo-XML parser and agent prompt builder

See [editor-system.md](editor-system.md), [inline-ai.md](inline-ai.md), and
[comments.md](comments.md). Shared provider/model infrastructure is in
[ai-system.md](ai-system.md).

### Shared UI

- `src/shared/styles/`: Tailwind tokens, themes, editor bridge, diff styles
- `src/shared/ui/SettingsDialog.vue`: Appearance, Editor, Models, CLI tools,
  Apps, Shortcuts, and About
- `src/shared/ui/settings/`: settings sections, progressive launcher rows, and
  exact CLI-flag parsing
- `src/stores/settings.js`: persisted settings and cross-window theme sync
- `src/shared/workbenchZoom.js`: interface zoom ladder, key chords, and native
  webview zoom application
- `src/shared/fonts.js`: editor font choices

See [design-system.md](design-system.md) and
[workbench-design.md](workbench-design.md). Settings persistence and
cross-window behavior are in [settings.md](settings.md).

## Rust map

### Activity runtime

- `src-tauri/src/activities/model.rs`: shared Activity DTO and lifecycle states
- `src-tauri/src/activities/supervisor.rs`: PTY ownership and persistence
- `src-tauri/src/activities/scrollback.rs`: bounded byte-preserving replay
- `src-tauri/src/activities/status.rs`: agent working/input/done inference
- `src-tauri/src/activity_commands.rs`: Tauri lifecycle and PTY commands
- `src-tauri/src/launchers.rs`: presets, detection, exact argv, MCP injection
- `src-tauri/src/mimx.rs`: installs `mimx` and the Pi extension

### MCP and tools

- `src-tauri/src/tool_registry.rs`: transport-neutral canonical registry
- `src-tauri/src/tool_bridge.rs`: UI and app provider bridges
- `src-tauri/src/tool_runtime.rs`: core definitions and live provider ownership
- `src-tauri/src/tool_server.rs`: loopback MCP transport and legacy debug routes
- `src-tauri/src/shell_exec.rs`: bounded shell execution with sensitive-env filtering behind `shell.run`
- `bin/mimx.mjs`: tool discovery, generic calls, and editor shortcuts
- `bin/pi-mim-extension.ts`: dynamic Pi registration of current Mim tools

- `src-tauri/tests/mimx_contract.rs`: end-to-end MCP contract test — boots a
  real tool server on an ephemeral port and drives it via `bin/mimx.mjs` CLI
  invocations and raw JSON-RPC HTTP

See [mcp.md](mcp.md).

Provider relays, request cancellation, file-open queuing, proposal events, and
server lease ordering are mapped in [ipc.md](ipc.md).

### Files, Apps, and Routines

- `src-tauri/src/business_graph/`: bounded ontology, Markdown adapters,
  source-aware index/query/traversal, mutations, scopes, watchers, migration
  report, agent context, and performance contracts
- `src-tauri/src/business_graph/tools/`: per-domain MCP tool modules —
  `mod.rs` (registration + dispatch), `support.rs` (shared schema/result
  builders), `graph.rs`, `knowledge.rs`, `issues.rs`, `projects.rs`,
  `research.rs`
- `src-tauri/src/file_index.rs`: recent-first regular-file index and bounded
  content search
- `src-tauri/src/file_index_commands.rs`: native index command surface
- `src-tauri/src/workspace_files.rs`: workspace-scoped inspect/browse/mutation,
  open classification, traversal protection, system Trash, reveal, and
  default-app open
- `src-tauri/src/file_open.rs`: supported CLI file-open handling
- `src-tauri/src/apps.rs`: TOML catalog, safe local definition operations,
  launch resolution, app data, HTTP
- `src-tauri/src/routines.rs`: TOML schema, cron parsing, planner rules
- `src-tauri/src/routine_runtime.rs`: scheduler, launcher resolution, Activity runs
- `src-tauri/src/git.rs`: Git status used by Files decorations and summaries

### Editor AI and persistence

- `src-tauri/src/ai.rs`: non-streaming generation command
- `src-tauri/src/ai_proxy.rs`: streaming provider bridge for inline AI
- `src-tauri/src/ai_keys.rs`: keychain and debug key resolution
- `src-tauri/src/ai_models.rs`: model registry
- `src-tauri/src/ai_providers.rs`, `ai_transport.rs`, `ai_usage.rs`: provider
  formats, network policy, and normalized usage
- `src-tauri/src/session.rs`: crash-safe editor session load/save commands
- `src-tauri/src/persistence.rs`: atomic JSON/byte writes and corrupt quarantine

See [persistence.md](persistence.md), [ai-system.md](ai-system.md), and
[security.md](security.md).

## Local data

| Path | Owner |
|---|---|
| `~/.mim/launchers.json` | launcher presets |
| `~/.mim/activities/` | durable Activity records and scrollback |
| `~/.mim/apps/` | local app TOML and app directories |
| `~/.mim/app-data/` | app-owned JSON values |
| `~/.mim/graph/private/` | private local Business graph Markdown |
| `~/.mim/routines/` | routine TOML |
| `~/.mim/routines-state.json` | next-fire planner state |
| `~/.mim/settings.json` | editor/workbench/settings data |
| `~/.mim/session.json` | open editor tabs, drafts, recents, and zoom |
| `~/.mim/models.json` | inline/ghost AI provider and model registry |
| `~/.mim/bin/` | installed `mimx` |
| `~/.mim/pi/mim-tools.ts` | installed Pi extension |
| `~/.mim/keys.env` | debug-only plaintext key fallback |

## Documentation

| Document | Purpose |
|---|---|
| [synthesis.md](synthesis.md) | product thesis and boundaries |
| [acceptance.md](acceptance.md) | release behavior contract |
| [building.md](building.md) | development, verification, packaging |
| [testing.md](testing.md) | test topology, environment limits, change-to-test routing |
| [runtime-architecture.md](runtime-architecture.md) | native/renderer authority, bootstrap, hydration, shutdown |
| [ipc.md](ipc.md) | commands/events, relay ordering, queues, proposal coordination |
| [persistence.md](persistence.md) | write ownership, serialization, quarantine, recovery |
| [settings.md](settings.md) | mutation, persistence, cross-window and MCP semantics |
| [security.md](security.md) | trusted-local model and exact capability boundaries |
| [ai-system.md](ai-system.md) | model registry, credentials, providers, transport |
| [agent-setup.md](agent-setup.md) | launchers, automatic agent connection, `mimx` |
| [activities.md](activities.md) | universal execution lifecycle |
| [mcp.md](mcp.md) | registry, transport, domains, dynamic providers |
| [business-graph.md](business-graph.md) | GraphStore, ontology, physical scopes, projections, tools, migration, and recovery |
| [files.md](files.md) | file index, search, quick-open |
| [apps-system.md](apps-system.md) | local app formats and SDK |
| [routines.md](routines.md) | scheduler and routine TOML |
| [editor-system.md](editor-system.md) | Markdown editor and review flow |
| [inline-ai.md](inline-ai.md) | Cmd+K and ghost completion |
| [comments.md](comments.md) | canonical pseudo-XML comments and inline UI |
| [workbench-design.md](workbench-design.md) | shell interaction and visual direction |
| [design-system.md](design-system.md) | styling tokens and UI rules |
| [gotchas.md](gotchas.md) | non-obvious implementation constraints |
| [issues.md](issues.md) | current known issues |
| [unified business graph delivery record](plans/unified-business-graph.md) | product decisions, parity contract, and completed delivery checklist |
| [Business Graph experience redesign](plans/business-graph-experience-redesign.md) | Scan/Peek/Focus UX contract, exhaustive control inventory, review gates, and two-pass review log |
| [Business Graph OPS redesign](plans/business-graph-ops-redesign.md) | OPS flow direction and implementation plan |
