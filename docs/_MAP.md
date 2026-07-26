# Codebase map

Read this file first, then [gotchas.md](gotchas.md), then the system document
for the area being changed. Documentation describes the current Mim 0.1.0
product; Git carries its history.

## Product shape

Mim is one Tauri window with three mounted panes:

| Pane | Owner | Contents |
|---|---|---|
| Sidebar | `src/mim/components/WorkbenchSidebar.vue` | core surfaces, installed Apps/CLI launchers, live and archived Activities, Settings |
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

## Frontend map

### Workbench and Activities

- `src/mim/WorkbenchApp.vue`: top-level orchestration and core Activity records
- `src/mim/components/`: three-pane shell, rails, sidebar, recent-project
  switcher, quick-open, pane host
- `src/mim/activities/TerminalActivity.vue`: xterm-backed terminal and agent UI
- `src/mim/activities/FilesActivity.vue`: recent-first inbox, actionable folder
  browser, multi-selection, context menus, and keyboard file operations
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

- `src/stores/workspaceFiles.js`: workspace index, directory navigation,
  filters, selection, explicit refresh, and bounded searches
- `src/services/fileIndex.js`: native index/search wrappers
- `src/services/workspaceFileOperations.js`: create, rename, duplicate, Trash,
  reveal, default-app open, and folder-list wrappers
- `src/mim/components/QuickOpen.vue`: global Cmd/Ctrl+P file jump
- `src/services/fileSystem.js`: editor open/save wrappers
- `src/stores/files.js`: open tabs, dirty state, recent editor files

See [files.md](files.md).

### Apps

- `src/stores/appsCatalog.js`: catalog selection and Activity preparation
- `src/services/appsCatalog.js`: native catalog, launch, data, and tool relay
- `src/shared/ui/settings/AppsSettingsSection.vue`: search, launch, diagnostics,
  local scaffold/duplicate/title/Trash operations, and definition navigation
- `src/shared/ui/settings/AppSettingsSectionRows.vue`: keyboard catalog rows
- `src/mim/apps/`: embedded host, launch-plan host, Changes, and local app surfaces
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
- `src/editor/components/workspace/`: tabs, CodeMirror surface, inline AI, diffs
- `src/editor/codemirror/`: editor core, formatting, live preview, ghost, comments
- `src/editor/composables/`: file, tab, content, diff, comment, and key handling
- `src/stores/files.js`, `diff.js`, `comments.js`, `editorUI.js`: editor state
- `src/services/ai/`: inline/ghost model transport and provider helpers
- `src/services/ai/tools/`: renderer implementations for workspace MCP tools
- `src/services/comments/`: pseudo-XML parser and agent prompt builder

See [editor-system.md](editor-system.md), [inline-ai.md](inline-ai.md), and
[comments.md](comments.md).

### Shared UI

- `src/shared/styles/`: Tailwind tokens, themes, editor bridge, diff styles
- `src/shared/ui/SettingsDialog.vue`: Appearance, Editor, Models, CLI tools,
  Apps, Shortcuts, and About
- `src/shared/ui/settings/`: settings sections, progressive launcher rows, and
  exact CLI-flag parsing
- `src/stores/settings.js`: persisted settings and cross-window theme sync
- `src/shared/fonts.js`: editor font choices

See [design-system.md](design-system.md) and
[workbench-design.md](workbench-design.md).

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
- `bin/mimx.mjs`: tool discovery, generic calls, and editor shortcuts
- `bin/pi-mim-extension.ts`: dynamic Pi registration of current Mim tools

See [mcp.md](mcp.md).

### Files, Apps, and Routines

- `src-tauri/src/file_index.rs`: recent-first index and bounded content search
- `src-tauri/src/file_index_commands.rs`: native index command surface
- `src-tauri/src/workspace_files.rs`: workspace-scoped browse and mutation
  commands, traversal protection, system Trash, reveal, and default-app open
- `src-tauri/src/file_open.rs`: supported CLI file-open handling
- `src-tauri/src/apps.rs`: TOML catalog, safe local definition operations,
  launch resolution, app data, HTTP
- `src-tauri/src/routines.rs`: TOML schema, cron parsing, planner rules
- `src-tauri/src/routine_runtime.rs`: scheduler, launcher resolution, Activity runs
- `src-tauri/src/git.rs`: Git status used by the built-in Changes app

### Editor AI and persistence

- `src-tauri/src/ai.rs`: non-streaming generation command
- `src-tauri/src/ai_proxy.rs`: streaming provider bridge for inline AI
- `src-tauri/src/ai_keys.rs`: keychain and debug key resolution
- `src-tauri/src/ai_models.rs`: model registry
- `src-tauri/src/ai_providers.rs`, `ai_transport.rs`, `ai_usage.rs`: provider
  formats, network policy, and normalized usage
- `src-tauri/src/persistence.rs`: atomic JSON/byte writes and corrupt quarantine

## Local data

| Path | Owner |
|---|---|
| `~/.mim/launchers.json` | launcher presets |
| `~/.mim/activities/` | durable Activity records and scrollback |
| `~/.mim/apps/` | local app TOML and app directories |
| `~/.mim/app-data/` | app-owned JSON values |
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
| [agent-setup.md](agent-setup.md) | launchers, automatic agent connection, `mimx` |
| [activities.md](activities.md) | universal execution lifecycle |
| [mcp.md](mcp.md) | registry, transport, domains, dynamic providers |
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
