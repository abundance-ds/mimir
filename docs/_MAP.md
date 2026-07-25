# _MAP.md — Codebase Navigation for AI Agents

> Read this first. Then `gotchas.md`. Then the system doc for whatever you're changing.

## What This Is

**Mim Panel** is a desktop app: terminal on the left, markdown editor on the right, MCP tool server bridging them to Claude Code. Built with Tauri v2 + Vue 3 + CodeMirror 6. Forked from "Shoulders" (legacy). See "Live vs Dead" below.

## Entry Point

`src/main.js` reads `?view=` URL param. Only the default matters:
- **(default) → `src/mim/MimPanel.vue`** — THE APP. Terminal left + editor right + MCP tool server on port 17532.
- `editor` → `src/editor/App.vue` — standalone editor window (spawned for additional editor windows)
- `panel` → **DEAD** — `src/panel/App.vue` — legacy mim chat panel, never launched
- `ghost` → floating tab drag preview

## Live vs Dead Code

~60% of the JS/Vue codebase is dead. The app is MimPanel.vue which uses only: editor, terminal, tool server, and shared utilities. Everything else is leftover from mim terminal.

### LIVE — always executes in Mim Panel

| Layer | Files | Purpose |
|-------|-------|---------|
| Shell | `src/mim/MimPanel.vue` | Main window: terminal + editor + tool server lifecycle |
| Editor | `src/editor/**` (all) | Markdown editor: App.vue orchestrator, CM6 extensions, components, composables |
| Terminal | `src/panel/components/TerminalPanel.vue` | Multi-tab xterm.js terminal (only panel component that's live) |
| Tool Server | `src/services/toolServer.js` | MCP bridge: dispatches Claude Code tool calls to AI tools + editor commands |
| AI Tools | `src/services/ai/tools/*` | 11 tools exposed via MCP: read, list, search, edit, create, shell, comment_add, comment_reply, search_web, annotate_docx, show |
| File I/O | `src/services/fileSystem.js` | Tauri file read/write wrappers |
| Stores | `stores/files.js`, `diff.js`, `comments.js`, `editorUI.js`, `settings.js`, `saveFeedback.js` | Editor and app state |
| Export | `src/services/export/docx.js`, `pdf.js`, `complianceReport.js` | Document export |
| DOCX | `src/services/docx/reader.js`, `writer.js` | DOCX read/annotate |
| Comments | `src/services/comments/parser.js`, `prompt.js` | Comment parsing |
| References | `src/services/references.js`, `bibtexParser.js`, `citationFormatter.js` | Bibliography |
| Shared | `src/shared/**` (all) | Utilities, styles, composables, UI components, icons |
| Audit | `src/services/audit.js` | Tool execution audit logging (used by gate.js) |
| Data | `src/services/dataDir.js` | ~/.mim/ path resolution |
| CLI | `bin/mimx.mjs` | CLI for Claude Code to control editor |
| Rust | `src-tauri/src/*` (most modules) | Backend: PTY, file I/O, tool server, AI proxy, audit, usage, git, refs, export |

### LIVE — editor AI features (reachable, may be disabled by user)

| File | Purpose |
|------|---------|
| `src/services/ai/ghost.js` | Ghost autocomplete (double-tap +) — calls ai_generate through Rust |
| `src/services/ai/inlineTransport.js` | Cmd+K inline AI agent (read + suggest_edit tools) |
| `src/services/ai/client.js` | ai_generate invoke wrapper (used by ghost) |
| `src/editor/codemirror/ghost.js` | CM6 ghost extension |
| `src/editor/components/workspace/InlineAI.vue` | Inline AI overlay |

### GRAY ZONE — loaded but shouldn't be

`MimPanel.vue` calls `initializePanelStores()` which loads the entire panel store graph. TerminalPanel.vue uses `useSessionStore()` for `activeProject` (cwd). This pulls in:

| File | Why loaded | Actually needed? |
|------|-----------|-----------------|
| `stores/panel/persistence.js` | Called by MimPanel on mount | Partially — loads settings, theme sync |
| `stores/panel/sessions.js` | TerminalPanel reads `activeProject` | Just the project cwd |
| `stores/panel/projects.js` | Sessions depends on it | Just workspace paths |
| `stores/panel/ui.js` | Persistence initializes it | Marginal |
| `stores/panel/chat.js` | Persistence initializes it | **NO** |
| `stores/panel/board.js` | Persistence initializes it | **NO** |
| `stores/panel/skills.js` | Persistence initializes it | **NO** |
| `stores/panel/apps.js` | Persistence initializes it | **NO** |
| `stores/panel/helpers.js` | Chat depends on it | **NO** |
| `stores/panel/actions.js` | Persistence calls it | **NO** |

### DEAD — entire Panel/Chat system (never rendered)

**~35 Vue components:**
- `src/panel/App.vue` — panel shell
- `src/panel/components/ChatView.vue`, `Composer.vue`, `ChatMessage.vue`, `NewChat.vue` — chat UI
- `src/panel/components/Sidebar.vue`, `SidebarRow.vue`, `PanelHeader.vue` — panel nav
- `src/panel/components/ModelPicker.vue`, `ControlPicker.vue`, `ContextDonut.vue` — AI controls
- `src/panel/components/ToolCallBlock.vue`, `ProposalActionBar.vue` — tool display
- `src/panel/components/AddProjectDialog.vue`, `ProjectHome.vue` — project UI
- `src/panel/components/SessionContextMenu.vue`, `ProjectContextMenu.vue` — context menus
- `src/panel/components/AppView.vue`, `AppStandard.vue`, `AppCustom.vue`, `AppSetup.vue` — apps UI
- `src/panel/components/board/*` — all 10 board/kanban components
- `src/panel/components/project/*` — ProjectActivity, ProjectPermissions, ProjectSettings
- `src/panel/composables/*` — useKanbanDrag, useSessionSearch, useStreamReveal
- `src/panel/agentsWindow.js`

**~10 AI chat services:**
- `src/services/ai/bridgeFetch.js` — LLM API proxy (Claude Code does its own calls)
- `src/services/ai/chatTransport.js` — tool loop agent
- `src/services/ai/sdkAdapter.js` — AI SDK model creation
- `src/services/ai/context.js` — context window calculations
- `src/services/ai/errors.js` — AI error classification
- `src/services/ai/recovery.js` — poisoned message recovery
- `src/services/ai/modelControls.js` — model parameter controls
- `src/services/ai/systemPrompt.js` — system prompt builder
- `src/services/ai/workspaceMeta.js` — workspace metadata

**Other dead services:**
- `src/services/skills/loader.js`, `bundled.js` — skills discovery
- `src/services/apps/seeder.js` — app seeding
- `src/services/session.js` — session file I/O
- `src/services/attachments.js`, `attachmentPicker.js` — chat attachments
- `src/services/appUpdater.js` — auto-update checker
- `src/services/telemetry.js` — anonymous telemetry
- `src/services/board/loader.js` — board entry loader

**Dead files (already broken):**
- `src/editor/codemirror/references.js` — zero imports, never used
- `src/editor/components/workspace/RewriteOverlay.vue` — never mounted
- `src/services/ai/rewrite.js` — only imported by dead RewriteOverlay

**Dead subsystems:**
- `src/apps/*` — entire custom app platform (bridge, runner, runtime, SDK)
- `web/*` — Nuxt portal, admin dashboard, licensing
- `sidecar/docx-worker/` — .NET DOCX sidecar (spike)

### Dead Rust commands (only called by dead Panel/Chat code)

`ai_abort`, `ai_cleanup`, `ai_config_dir`, `ai_key_status`, `ai_model_registry`, `ai_proxy_stream`, `ai_set_api_key`, `app_*` (all 9), `copy_dir`, `diff_open`, `git_clone`, `git_clone_authenticated`, `git_init`, `git_status`, `list_bundled_apps`, `list_bundled_skills`, `notify_file_updated`, `open_files_in_editor`, `proposal_apply`, `proposal_create`, `proposal_list`, `proposal_reject`, `proposal_send`, `push_proposals`, `read_bundled_profile`, `reveal_in_finder`, `search_sessions`, `usage_record`, `tool_execution_record`

Note: `ai_generate` is live (ghost suggestions). `shell_exec`, `search_file_content`, `list_dir`, `create_dir`, `delete_path`, `docx_*`, `ref_*`, `read_text_file`, `write_text_file`, `read_binary_file`, `write_binary_file` are all live via tool server.

## Directory Structure

`[DEAD]` = unreachable from MimPanel, leftover from mim terminal. `[GHOST]` = editor AI feature, needs API keys.

```
src/
  main.js                          # Vue app bootstrap, view router
  mim/MimPanel.vue                 # PRIMARY SHELL: terminal + editor + tool server
  editor/                          # LIVE — Markdown editor surface
    App.vue                        # Editor orchestrator (1528 LOC — GOD FILE)
    codemirror/                    # CM6 extensions: core, comments, citations, formatting, ghost, livePreview, merge, outline
    codemirror/references.js       # [DEAD] zero imports, citations.js handles this
    components/shell/              # AppHeader, AppFooter
    components/workspace/          # EditorSurface, TabStrip, InlineAI [GHOST], DiffView, BatchDiffView, PreviewPane, EditorToolbar, NewTabPage, DiffBar
    components/workspace/RewriteOverlay.vue  # [DEAD] never mounted
    components/sidebar/            # Sidebar, CommentCard, SidebarExport, SidebarHistory, SidebarNotes, SidebarOutline, SidebarRefs
    components/IssueContextBar.vue
    composables/                   # useTabManagement, useContentSync, useFileOpen, useDiffReview, useCommentMutations, useCommentPositions, useDocumentBridge, useKeyboardShortcuts, useProposalBridge, useScrollSync, useSubmitReview, useDeferredMarkdownPreview
    autoSaveController.js          # Debounced auto-save
    saveStatus.js                  # Save state machine
    sessionPersist.js              # Editor session restore
    nativeMenu.js                  # macOS native menu bar
    agentsWindow.js                # Spawn agent windows via Tauri
  panel/                           # [DEAD] except TerminalPanel
    components/TerminalPanel.vue   # LIVE — multi-tab xterm.js terminal (only live panel component)
    App.vue                        # [DEAD] panel shell
    components/                    # [DEAD] ChatView, Composer, Sidebar, NewChat, ChatMessage, ToolCallBlock, ProposalActionBar, PanelHeader, ModelPicker, ControlPicker, ContextDonut, AddProjectDialog, ProjectHome, SessionContextMenu, ProjectContextMenu, SidebarRow, AppView/*
    components/board/              # [DEAD] all 10 kanban/board components
    components/project/            # [DEAD] ProjectActivity, ProjectPermissions, ProjectSettings
    composables/                   # [DEAD] useKanbanDrag, useSessionSearch, useStreamReveal
    agentsWindow.js                # [DEAD]
    styles.css                     # Loaded by MimPanel (side effect)
  services/
    ai/                            # Mixed live/dead
      client.js                    # [GHOST] ai_generate wrapper (ghost suggestions)
      ghost.js                     # [GHOST] inline completion engine
      inlineTransport.js           # [GHOST] Cmd+K inline AI agent
      rewrite.js                   # [DEAD] only imported by dead RewriteOverlay
      sdkAdapter.js                # [DEAD] AI SDK model creation for chat
      bridgeFetch.js               # [DEAD] LLM API proxy for chat
      chatTransport.js             # [DEAD] chat tool loop agent
      context.js                   # [DEAD] context window/budget calcs
      errors.js                    # [DEAD] AI error classification
      recovery.js                  # [DEAD] poisoned message recovery
      modelControls.js             # [DEAD] model parameter controls
      systemPrompt.js              # [DEAD] system prompt builder
      workspaceMeta.js             # [DEAD] workspace metadata for AI context
    ai/tools/                      # LIVE — exposed to Claude Code via MCP tool server
      index.js                     # Tool assembler: createMimTools(context)
      read.js, list.js, search.js  # Read tools (file, dir, project search)
      edit.js, create.js           # Write tools
      shell.js                     # Shell execution
      searchWeb.js                 # OpenAlex/CrossRef/arXiv search
      commentAdd.js, commentReply.js # Comment tools
      annotateDocx.js              # DOCX annotation tool
      show.js                      # Display board entries as cards
      gate.js                      # Approval gate (runs in bypass mode for tool server)
      pathPermission.js            # Path access control
      pathHandlers.js              # Path resolution (@issues/, @knowledge/, @library.json)
      helpers.js                   # Tool utilities
      textMatch.js                 # Typographic-aware text matching
    board/loader.js                # [DEAD] board entry loader (kanban)
    comments/parser.js             # LIVE — comment tag parser
    comments/prompt.js             # LIVE — comment prompt builder
    docx/reader.js                 # mammoth.js: .docx → HTML → markdown
    docx/writer.js                 # docx-worker sidecar: annotate .docx with tracked changes
    export/docx.js                 # Markdown → .docx via docx npm package
    export/pdf.js                  # Markdown → PDF via Rust typst backend
    export/complianceReport.js     # Audit trail → DOCX compliance report
    skills/loader.js               # [DEAD] skill discovery
    skills/bundled.js              # [DEAD] built-in skills
    apps/seeder.js                 # [DEAD] app seeding
    fileSystem.js                  # LIVE — Tauri file I/O wrappers
    toolServer.js                  # LIVE — MCP tool server: dispatches Claude Code tool calls
    session.js                     # [DEAD] session file I/O for chat
    audit.js                       # LIVE — audit event logging (used by gate.js)
    references.js                  # LIVE — bibliography/citation management
    attachments.js                 # [DEAD] chat attachments
    attachmentPicker.js            # [DEAD] chat attachment picker
    appUpdater.js                  # [DEAD] auto-update checker
    telemetry.js                   # [DEAD] anonymous telemetry
    dataDir.js                     # LIVE — ~/.mim/ path resolution
    bibtexParser.js                # LIVE — BibTeX → JSON parser
    citationFormatter.js           # LIVE — citation style formatting
  stores/
    index.js                       # Store registry
    files.js                       # LIVE — file state, open files, save state, recent files
    diff.js                        # LIVE — diff/review state
    comments.js                    # LIVE — parsed comments, active comment tracking
    editorUI.js                    # LIVE — editor UI: panel, view mode, zoom, settings
    settings.js                    # LIVE — 25+ user preferences, cross-window sync
    saveFeedback.js                # LIVE — transient save status display
    panel/                         # Mostly [DEAD] — loaded by initializePanelStores but unused
      chat.js                      # [DEAD] chat instances, AI SDK, approval queues
      sessions.js                  # GRAY — TerminalPanel reads activeProject for cwd
      projects.js                  # GRAY — sessions depends on it for workspace paths
      board.js                     # [DEAD] kanban state
      apps.js                      # [DEAD] app discovery
      skills.js                    # [DEAD] skill discovery
      ui.js                        # GRAY — panel UI state, loaded by persistence
      actions.js                   # [DEAD] cross-store orchestration
      persistence.js               # GRAY — called by MimPanel, loads too much
      helpers.js                   # [DEAD] chat instance Map
  apps/                            # [DEAD] — entire custom app platform
    bridge.js                      # [DEAD] iframe postMessage bridge
    runner.js                      # [DEAD] app lifecycle orchestrator
    runtime.js                     # [DEAD] runtime context
    sdk/mim-sdk.js           # [DEAD] auto-injected SDK
    sdk/theme-base.css             # [DEAD] app iframe theme
  shared/
    hfu.js                         # "Hidden From User" — wraps/strips <hfu> tags for context injection
    lineDelta.js                   # LCS-based line diff stats + path disambiguation
    platform.js                    # Platform detection (macos/windows/linux), modifier keys
    windowChrome.js                # macOS traffic light positions, window background colors
    saveState.js                   # SAVE_STATE enum: idle/dirty/saving/saved/failed
    proposalEvents.js              # Tauri event name constants for proposals
    fonts.js                       # Editor font definitions (Sans/Serif/Mono/Slab)
    utils/path.js                  # basename(), dirname() with ~ abbreviation
    composables/usePopover.js      # Floating UI wrapper
    composables/useSidebarResize.js # Draggable sidebar width
    composables/useVerticalResize.js # Draggable vertical height
    icons/                         # 4 custom SVGs: CollapseAll, ProviderAnthropic/Google/OpenAI
    ui/SettingsDialog.vue          # Modal with 9 tabbed sections
    ui/SegmentedControl.vue        # Button group radio
    ui/WorkingIndicator.vue        # Animated 3x3 grid loading indicator
    ui/settings/                   # AppearanceSection, EditorSection, AISection, PanelSection, ToolsSection, UsageSection, AuditSection, ShortcutsSection, AboutSection
    styles/                        # CSS architecture (all token-based, 5 themes)
      app.css                      # Tailwind v4 + design token imports
      base.css                     # Resets, scrollbar, user-select
      themes.css                   # 5 themes: Parchment/Studio/Glacier/Slate/Monokai
      fonts.css                    # @font-face declarations
      editor-content.css           # CM6 theme bridge, ghost styling
      preview-content.css          # Rendered markdown typography
      diff.css                     # Merge view styling
      settings-form.css            # Form controls, toggles, dropdowns

src-tauri/                         # Rust desktop backend (all compiled, but many commands are dead)
  src/
    main.rs                        # Tauri entry
    lib.rs                         # 92 commands registered, proposal coordinator, file ops (1363 LOC — GOD FILE)
    pty.rs                         # LIVE — terminal: portable-pty, background reader, UTF-8 chunking
    shell_exec.rs                  # LIVE — async shell execution (tool server shell tool)
    tool_server.rs                 # LIVE — MCP Axum HTTP server on port 17532
    file_open.rs                   # LIVE — CLI arg filtering, editor window creation
    file_search.rs                 # LIVE — recursive file content search (tool server search tool)
    references.rs                  # LIVE — CSL JSON bibliography CRUD
    git.rs                         # LIVE — git file history (editor SidebarHistory)
    audit.rs                       # LIVE — SQLite audit log
    usage.rs                       # LIVE — SQLite usage DB
    typst_export.rs                # LIVE — markdown → PDF via Typst
    docx_worker.rs                 # LIVE — bridge to docx-worker binary
    ai.rs                          # [GHOST] ai_generate for ghost suggestions
    ai_proxy.rs                    # [GHOST] streaming proxy for ghost/inline AI
    ai_providers.rs                # [GHOST] provider translation
    ai_models.rs                   # [GHOST] model registry
    ai_keys.rs                     # [GHOST] key resolution
    ai_transport.rs                # [GHOST] HTTP transport
    ai_usage.rs                    # [GHOST] token/cost normalization
    apps.rs                        # [DEAD] app manifests, window lifecycle, HTTP protocol
    search.rs                      # [DEAD] full-text search of AI session files
  resources/
    ai-models.json                 # [GHOST] model catalog
    profile.json                   # Runtime profile

web/                               # [DEAD] — Nuxt portal, admin dashboard, licensing
bin/mimx.mjs                      # LIVE — CLI for Claude Code to control editor
sidecar/docx-worker/              # [DEAD] — .NET DOCX sidecar (spike, never integrated)
profiles/default.json             # Profile manifest
```

## Key Architecture Patterns

### Tool Server (MCP) — THE CORE INTEGRATION
Rust starts Axum on port 17532 (`tool_server.rs`). Claude Code and mimx CLI call tools via JSON-RPC. JS `toolServer.js` dispatches to 11 AI tools + 10 editor commands. Approval runs in bypass mode (external agents handle their own approval). This is how the terminal (Claude Code) controls the editor.

### File I/O
All file access through Tauri invoke wrappers (`src/services/fileSystem.js`). Never Node fs or browser File API.

### Store Architecture
Pinia setup stores. Only editor stores (`files.js`, `diff.js`, `comments.js`, `editorUI.js`) and `settings.js` are meaningfully used. Panel stores are loaded by `initializePanelStores()` but mostly idle — TerminalPanel only reads `activeProject` from sessions store for cwd.

### Data Directory
`~/.mim/` — references, keys.env fallback. Sessions/skills/projects dirs exist but unused.

## Branding

- Desktop app: **Mim Panel** (tauri.conf.json, window header)
- Tauri identifier: `dev.mim.panel`
- Internal package/Cargo: `mim_terminal`
- localStorage prefix: `mim:` (legacy)

---

## Health Report

### Scale of dead code

| Category | Live files | Dead files | % dead |
|----------|-----------|------------|--------|
| Panel components | 1 (TerminalPanel) | ~35 | 97% |
| Panel stores | 0 (2 gray) | 8 | 100% |
| AI services | 3 (ghost) | 9 | 75% |
| AI tools | 13 | 0 | 0% (all exposed via MCP) |
| Other services | 8 | 7 | 47% |
| Editor | all live | 2 (RewriteOverlay, references.js) | ~3% |
| Apps system | 0 | 5 | 100% |
| Web portal | 0 | all | 100% |
| Rust modules | 12 | 2 | 14% |

**Rough estimate: ~40 dead JS/Vue files, ~15,000 dead LOC out of ~55,000 total.**

### GOD Files (>500 LOC, live only)

| File | LOC | Issue |
|------|-----|-------|
| `src/editor/App.vue` | 1528 | Editor orchestrator: content sync, comments, inline AI, diffs, shortcuts, session restore, tabs, native menu, mim* APIs. Legitimate complexity but could extract comments wiring. |
| `src-tauri/src/lib.rs` | 1363 | 92 commands + proposal coordinator (~500 LOC). Extract proposals to `proposals.rs`. |
| `src/panel/components/TerminalPanel.vue` | 740 | Multi-tab xterm.js + resize + zoom + PTY. Could extract tab management. |
| `src/editor/components/shell/AppHeader.vue` | 707 | File menu, recent files, window controls. |
| `src/editor/codemirror/comments.js` | 662 | CM6 comment extension. Single-purpose, cohesive. |
| `src/editor/codemirror/livePreview.js` | 618 | CM6 live preview. Single-purpose, cohesive. |
| `src/editor/components/workspace/TabStrip.vue` | 612 | Tab bar + drag-out + close confirm. |

### Known Technical Debt

- `initializePanelStores()` loads 8 dead stores on every boot — should be trimmed to only what TerminalPanel needs
- HTML and LaTeX export not implemented (UI placeholders in SidebarExport)
- `console.log` remains in `fileSystem.js` and `export/pdf.js`
- `commentsForFile()` in `stores/comments.js` has dead parameter
- `?view=panel` route in main.js still works but is dead

---

## Quick Lookup: "I Need To Change X"

**Live systems:**
- **Editor** → [editor-system.md](editor-system.md). Entry: `src/editor/App.vue`. Performance: [editor-performance.md](editor-performance.md).
- **Terminal** → Rust PTY: `src-tauri/src/pty.rs`. Vue: `panel/components/TerminalPanel.vue`.
- **Tool server (MCP)** → Rust: `src-tauri/src/tool_server.rs`. JS: `services/toolServer.js`. CLI: `bin/mimx.mjs`. Tools: `services/ai/tools/`.
- **File I/O** → Service: `src/services/fileSystem.js`. Store: `src/stores/files.js`. Rust: `src-tauri/src/lib.rs`.
- **Settings** → Store: `src/stores/settings.js`. Dialog: `src/shared/ui/SettingsDialog.vue`.
- **Themes** → [design-system.md](design-system.md) §2. Tokens: `src/shared/styles/themes.css`. 5 themes.
- **Comments** → [comments.md](comments.md). CM6: `codemirror/comments.js`. Store: `stores/comments.js`. Tools: `tools/commentAdd.js`, `commentReply.js`.
- **Diff review** → [proposal-bridge.md](proposal-bridge.md). Store: `stores/diff.js`.
- **DOCX** → Reader: `services/docx/reader.js`. Writer: `services/docx/writer.js`. Tool: `tools/annotateDocx.js`.
- **Export** → PDF: `services/export/pdf.js` (Typst). DOCX: `services/export/docx.js`.
- **Citations** → Rust: `references.rs`. CM6: `codemirror/citations.js`. Service: `services/references.js`.
- **Audit** → Rust: `audit.rs`. JS: `services/audit.js`.
- **Tests** → Config: `vitest.config.js`. Run: `bun run test`. Co-located: `foo.test.js`.
- **Tauri commands** → Registration: `lib.rs`. Capabilities: `capabilities/default.json`.

**Ghost (editor AI, needs API keys):**
- **Ghost suggestions** → CM6: `codemirror/ghost.js`. Client: `services/ai/ghost.js`.
- **Inline AI / Cmd+K** → [inline-ai.md](inline-ai.md). Transport: `services/ai/inlineTransport.js`. Component: `InlineAI.vue`.

**Dead (reference only — do not extend):**
- **Panel chat** → [panel-system.md](panel-system.md), [ai-chat.md](ai-chat.md). DEAD.
- **Board/kanban** → [board-system.md](board-system.md). DEAD.
- **Skills** → [skills-system.md](skills-system.md). DEAD.
- **Apps** → [apps-system.md](apps-system.md). DEAD.
- **Telemetry** → `services/telemetry.js`. DEAD.
- **Web portal** → `web/`. DEAD.

## System Docs Index

**Live systems:**

| System | Doc |
|--------|-----|
| Editor system | [editor-system.md](editor-system.md) |
| Editor performance | [editor-performance.md](editor-performance.md) |
| Editor components | [editor-components.md](editor-components.md) |
| Comments | [comments.md](comments.md) |
| Inline AI (ghost) | [inline-ai.md](inline-ai.md) |
| Proposal bridge / diffs | [proposal-bridge.md](proposal-bridge.md) |
| Design system / themes | [design-system.md](design-system.md) |
| Audit system | [audit-system.md](audit-system.md) |
| AI permissions (gate) | [permissions.md](permissions.md) |
| Building & CI | [building.md](building.md) |
| Gotchas | [gotchas.md](gotchas.md) |
| Issues | [issues.md](issues.md) |
| Agent setup (Claude Code) | [agent-setup.md](agent-setup.md) |
| Roadmap | [mim-panel-roadmap.md](mim-panel-roadmap.md) |
| Synthesis (target feature set) | [synthesis.md](synthesis.md) |

**Dead systems (reference only):**

| System | Doc |
|--------|-----|
| Panel system | [panel-system.md](panel-system.md) |
| AI chat & tools | [ai-chat.md](ai-chat.md) |
| AI infrastructure | [ai-infra.md](ai-infra.md) |
| AI model selection | [ai-model-selection.md](ai-model-selection.md) |
| AI SDK + Vue | [ai-sdk-vue-integration.md](ai-sdk-vue-integration.md) |
| Apps system | [apps-system.md](apps-system.md) |
| Skills system | [skills-system.md](skills-system.md) |
| Board system | [board-system.md](board-system.md) |
| UI layout (multi-window) | [ui-layout.md](ui-layout.md) |
| Web design system | [web-design-system.md](web-design-system.md) |
| Composer UX handover | [handover-composer-ux.md](handover-composer-ux.md) |
| Provenance timeline | [handover-provenance-timeline.md](handover-provenance-timeline.md) |
