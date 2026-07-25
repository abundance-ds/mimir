# Panel System

Audience: coding agents. Purpose: understand, locate, and extend the mim terminal.

## What The Panel Is

The Panel is the **primary Tauri window** (label `main`) that opens on launch. It hosts AI chat agents with streaming conversations, tool execution, and file change proposals. The Editor opens on demand in `editor-*` windows from the Panel.

The design split:

- **Panel** (primary window, label `main`): chat conversations with AI, tool execution, file change proposals. Opens on launch.
- **Editor** (secondary, labels `editor-*`): writing, editing, reviewing diffs, accepting/rejecting agent changes. Opened via "Editor" header button or auto-restored if a session has open files.

Agent file changes appear as compact `FileChangeCard`s in the Panel chat. Accept/reject happens directly from the card (writes files via Tauri invoke, no Editor window required). A "Review" button optionally opens a diff in the Editor.

## Current Status

**Working:** Two-column layout (sidebar + chat), AI SDK streaming chat through Rust transport, session/project CRUD with dual-path persistence (`~/.mim/` disk + localStorage fallback), tool calls (`read`, `search`, `edit`), proposal cards with accept/reject, model picker with Auto + effort/thinking controls, NewChat landing, Project Home view (includes new-chat creation), session management (pin/rename/archive/delete/export), drag-and-drop session reordering, attention states with status strip, file indexing with @ autocomplete, git clone, SQLite usage ledger.

**Not yet built:** Cross-window event bridge, Editor diff overlay for proposals.

## File Map

### Panel app (`src/panel/`)

| File | Purpose |
|---|---|
| `App.vue` | Root component. Imports individual panel stores + calls `initializePanelStores()`, assembles PanelHeader + Sidebar + ChatView. |
| `styles.css` | Panel CSS custom properties (warm paper theme) and base reset. Loaded via dynamic import in `main.js`. |
| `agentsWindow.js` | Tauri window helpers: `openOrFocusEditorWindow()`, `autoRestoreEditorWindow()`. |

### Components (`src/panel/components/`)

| File | Purpose |
|---|---|
| `PanelHeader.vue` | Full-width header: traffic-light spacer, sidebar toggle, back/forward nav, session title with inline rename, three-dots menu (rename/pin/export/archive), Open Editor button. |
| `Sidebar.vue` | Column 1: persistent search bar with collapse-all button, pinned sessions (top, subtle divider), project tree with session rows, "+ Add project" at bottom, footer (Open Editor, Settings). Drag-and-drop reorder within and between projects. |
| `SidebarRow.vue` | Reusable row: icon slot, label, shortcut, active/dim states. |
| `NewChat.vue` | Landing screen: centered composer with search-as-you-type, skill chip attachment, collapsible skills/workflows lists, recent chats, project context. Accessed via Project Home; shows when active session has zero messages. |
| `ChatView.vue` | Column 2: message list, proposal stack, composer. Quick prompts empty state (fallback). |
| `ChatMessage.vue` | Single message: user bubble (right-aligned, file attachments) or assistant response (text with streaming reveal, collapsible reasoning/thinking blocks, tool calls, streaming wait dots, copy-on-hover). |
| `Composer.vue` | Textarea input, model picker, control picker, send/stop button, cost display, status dot. |
| `ModelPicker.vue` | Dropdown model selection with provider sections, Auto mode, disabled state for missing keys. |
| `ControlPicker.vue` | Dropdown for effort/thinking control per model (None/Low/Medium/High). |
| `ToolCallBlock.vue` | Pending: inline approval card with risk badge. Completed: compact 28px one-liner with animated status, semantic icons, human labels, context, expandable detail. |
| `FileChangeCard.vue` | Proposal card: file path, +/- delta, rationale snippet, accept/reject/review buttons, status badge. Accept writes files directly via Tauri invoke. Review opens a diff in the Editor (optional). |
| `AddProjectDialog.vue` | Single-purpose project dialogs for New Folder and Clone Repository. Open Folder launches the native picker directly from the sidebar menu. |
| `ProjectContextMenu.vue` | Right-click menu: settings (opens Project Home), reveal in Finder, remove. Works on system projects (remove hidden). Rename removed (project names = folder names). |
| `SessionContextMenu.vue` | Right-click menu: rename, pin/unpin, export, archive, delete. |
| `ProjectHome.vue` | Full-panel view for per-project settings: description, project prompt (AGENTS.md), personal instructions, permissions (approval mode override, per-project tool access, session approval chips), stats, activity timeline (audit episodes + compliance indicators + compliance report export), remove. Navigating to a session auto-closes it. |
| ~~`PanelSettingsDialog.vue`~~ | **Deleted.** Replaced by unified `src/shared/ui/SettingsDialog.vue` (shared with Editor). Panel sidebar imports and opens it with `initial-section="models"`. |
| ~~`ProjectSettingsDialog.vue`~~ | **Deleted.** Replaced by `ProjectHome.vue` (full-panel view instead of modal). |

### State (`src/stores/panel/`)

| File | Purpose |
|---|---|
| `actions.js` | Cross-store commands for session selection, project Chat/Workflow starts, draft cleanup, project CRUD, and workflow delegation. |
| `sessions.js` | Pinia session/model store: project-scoped sessions, active session, model/control selection, import/export. Exposes `statusCounts` computed (counts of awaiting-review, error states for the status strip). |
| `chat.js` | Pinia chat store: AI SDK Chat instance lifecycle, active messages/status/errors, send/stop/regenerate, budget checks, tool config. |
| `projects.js` | Pinia project store: project list, expansion, folder linking/removal, project file indexing. |
| `workflows.js` | Pinia workflow store: workflow discovery, setup/run views, run lifecycle, import/remove. |
| `ui.js` | Pinia UI store: `statusFilter` (active status strip filter), `projectHomeId` (which project's home view is open), search state, dialog state. |
| `skills.js` | Pinia skills store: skill discovery, install/remove, skill file management. |
| `apps.js` | Pinia apps store: app discovery, install/remove, app lifecycle. |
| `helpers.js` | Shared pure helpers plus module-level `chatInstances` and `readHistories` Maps. |
| `persistence.js` | Store initialization, restore, persistence snapshots, theme sync, Tauri event listeners. |

### Composer (`src/panel/components/Composer.vue`)

**`+` menu** — attaches context before sending:
- Image (if model supports vision), Attach file (broad text/binary, 20 MB cap), Current document (from editor bridge), Skills (listed inline), Board entries (browsable list).
- Text formats (`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.yml`, `.xml`) are read as text and wrapped in `<hfu><attached-file>` tags. Images (png/jpg/gif/webp), PDF, and text formats supported — see `src/services/attachments.js` for the canonical media-type list.
- Attachment service: `src/services/attachments.js` (media types, validation, 20 MB cap). File picker: `src/services/attachmentPicker.js` (Tauri native dialog).
- Drag-and-drop: Tauri `onDragDropEvent`, reads binary or text per media type.

**`@` mention** — inline anywhere in message text. Searches skills, project files, and board entries. Keyboard navigation: ArrowUp/Down to select, Enter to confirm, Escape to dismiss.

**Context chips** — unified chip area above the textarea. Chip types: skills, project files, document context, board entries (`{ type: 'board-entry', id, label }`). One skill chip max; project-file chips are deduplicated.

**Auto session-entry linking** — when board-entry chips are present at send time, the session's `linkedEntries` array is populated automatically.

### Terminal

**Rust PTY backend:** `src-tauri/src/pty.rs` — multi-PTY manager with ID-based Tauri events, UTF-8 safe byte splitting, and zero-dimension resize guard.

**Vue component:** `src/panel/components/TerminalPanel.vue` — multi-tab xterm.js terminal. Chunked writes, right-click tab menu (rename/close), drag tab reorder, lazy spawn on first tab focus, theme sync with panel.

- Wired in `panel/App.vue` inside `panel-content` (compresses chat area, not sidebar). Vertical resize via `src/shared/composables/useVerticalResize.js`.
- Store state: `terminalOpen` in `ui.js`, `terminalHeight` in `settings.js`.
- Toggle: header button + `Ctrl/Cmd+`` shortcut. `Cmd+W` closes the active tab; closing the last tab closes the panel.
- PTY spawns in active project's `workspacePath` (falls back to `$HOME`).
- Shell defaults: `zsh` (macOS), `bash` (Linux), `powershell.exe` (Windows).
- Dependencies: `portable-pty` (Rust), `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`.

### Other Panel components and helpers

| File | Purpose |
|---|---|
| `src/panel/components/ContextDonut.vue` | SVG donut showing context-window % usage; hard-blocks sends at `isContextBlocked`. |
| `src/panel/composables/useStreamReveal.js` | Typewriter reveal for streaming assistant text. |
| `src/panel/composables/useSessionSearch.js` | Full-text session search (backed by `search_sessions` in `src-tauri/src/search.rs`). |
| `src/shared/composables/usePopover.js` | Popover positioning via Floating UI. |
| `src/stores/panel/helpers.js` | `getToolLabel()`, `getToolIcon()`, `getToolContext()` — tool display helpers. |

**Session order:** custom drag order stored per-project in `sessionOrder` (`Record<string, string[]>` in persisted settings). Falls back to newest-first when no custom order exists. Pinned sessions float to the top of the sidebar.

**Session archive:** `archiveSession()` / `restoreArchivedSession()` in `sessions.js`; `doneSession()` / `undoArchive()` in `actions.js`.

### Shared AI services (`src/services/ai/`)

Both Editor and Panel import from here. Panel uses the streaming path; Editor uses the non-streaming path.

| File | Used by Panel | Purpose |
|---|---|---|
| `bridgeFetch.js` | **Yes** | Fetch-compatible wrapper → Rust `ai_proxy_stream`. Sets Tauri event listeners, returns `ReadableStream`. Sends dummy auth; Rust replaces with real keys. |
| `sdkAdapter.js` | **Yes** | `createSdkModel()` factory, `buildProviderOptions()`, `normalizeSdkUsage()`, `addUsage()`. Creates AI SDK provider models using bridgeFetch. |
| `chatTransport.js` | **Yes** | `createMimChatTransport()`. Wraps `ToolLoopAgent` + `DirectChatTransport`. Fresh agent per request, up to 8 tool steps. |
| `modelControls.js` | **Yes** | `modelMenuItems()`, `controlForModel()`, `resolveConcreteModel()`, `AUTO_MODEL_ID`. Drives model/control picker UI. |
| `tools/index.js` | **Yes** | `createMimTools()`: 12 tools (read, list, search, edit, create, comment_*, search_web, annotate_docx, show, shell). Tools execute in Panel JS process. |
| `client.js` | **Yes** | Thin Tauri invoke wrappers for `ai_config_dir`, `ai_model_registry`, `ai_key_status`, `ai_set_api_key`. Used for settings. |
| `ghost.js` | No | Ghost suggestion prompt. Editor-only. |
| `rewrite.js` | No | Selection rewrite prompt. Editor-only. |
| `context.js` | No | Prefix/suffix slicing for ghost. Editor-only. |
| `errors.js` | No | Error message mapping. Available if needed. |

### Rust AI backend (`src-tauri/src/`)

| File | Purpose |
|---|---|
| `ai_proxy.rs` | **Streaming bridge for Panel.** `ai_proxy_stream`, `ai_abort`, `ai_cleanup`. Resolves API key, validates host, streams raw provider bytes via Tauri events keyed by `correlationId`. |
| `ai.rs` | Non-streaming `ai_generate` for ghost/rewrite. Not used by Panel chat. |
| `ai_models.rs` | Model registry. Creates `~/.mim/models.json`. Default models, pricing, capabilities. |
| `ai_keys.rs` | Key resolution: keychain → env → `.env` → `keys.env` (debug). Keychain service `com.mim.terminal`. |
| `ai_providers.rs` | Rust-native provider adapters for `ai_generate` only. Do not extend for Panel. |
| `ai_transport.rs` | Shared HTTP helpers: `post_json`, `build_headers`, `validate_url_host`, `redact_error`. Host allowlist. |
| `ai_usage.rs` | Normalized usage shape with cache-aware cost calculation. |
| `lib.rs` | Registers all commands. Manages `AiStreamState` for active streaming sessions. |

## Architecture: How Streaming Chat Works

```
User types in Composer → Composer emits "send" →
  ChatView calls store.sendMessage(text) →
    useChatStore gets Chat from chatInstances Map →
      chat.sendMessage({ text }) (NOT awaited) →
        AI SDK Chat pushes user message to messagesRef →
          Vue reactivity triggers re-render (NewChat → ChatView) →
        createMimChatTransport (chatTransport.js) →
          ToolLoopAgent.stream() → streamText() →
            createSdkModel (sdkAdapter.js) →
              @ai-sdk/anthropic (or openai/google) →
                bridgeFetch.js →
                  invoke('ai_proxy_stream') (Rust) →
                    Rust resolves real API key from keychain →
                    Rust validates URL against host allowlist →
                    reqwest streams HTTP to provider →
                    Tauri events: ai-stream-chunk-{correlationId} →
                  ReadableStream back to AI SDK →
                AI SDK parses SSE, detects tool calls →
              ToolLoopAgent executes tools (JS-side, up to 8 steps) →
              Re-sends to model with tool results →
            Streaming text + tool results back →
          DirectChatTransport returns UIMessageStream →
        Chat updates messagesRef → Vue reactivity re-renders →
      ChatMessage components display streaming text/tools
```

Key boundaries:
- AI SDK owns provider wire format, streaming, and tool-call protocol.
- Rust owns secrets, HTTP transport, host allowlist, and cancellation.
- Provider API keys never enter JavaScript.
- Chat instances live in a plain Map outside Vue reactivity. Components access `chat.state.messagesRef.value` directly for reactive updates.

See [ai-sdk-vue-integration.md](ai-sdk-vue-integration.md) for chat reactivity architecture.

## Data Model

### Session (in useSessionStore)

```js
{
  id: 'thread_1715...',
  projectId: 'general',         // 'general' is the Personal project
  label: 'Check citation coverage',
  modelId: 'auto',           // or concrete like 'claude-sonnet-4-6'
  controlId: 'default',      // effort/thinking control
  proposals: [{ id, targetText, replacement, rationale, status, path }],
  usage: { inputTokens, outputTokens, estimatedCost, ... },
  createdAt: '2026-05-10T...',
  updatedAt: '2026-05-10T...',
  archived: false,
  pinned: false,
  lastViewedAt: '2026-05-11T...',
  lastError: '',
  chat: Chat,                // AI SDK Chat instance (not serialized)
}
```

### Project

```js
{
  id: 'general',
  name: 'Personal',
  path: 'Panel-wide chats',
  system: true,              // system projects can't be deleted
  workspacePath: null,       // Personal has no workspace
  createdAt: '2026-05-10T...',
}
```

### Persistence

Current: dual-path. In Tauri, sessions persist to `~/.mim/projects/{project_id}/sessions/{id}.json` via `dataDir.js`. In browser, falls back to localStorage key `mim:panel:sessions:v1`. Debounced 500ms writes.

## What To Build Next

1. **Cross-window event bridge** — Rust commands + Tauri event listeners for Panel ↔ Editor messaging (open diff, scroll, accept/reject).
2. **Editor diff overlay** — CM6 extension for inline proposed changes with accept/reject chrome.

See [gotchas.md](gotchas.md) for Panel-specific gotchas.

## Related Docs

- [ai-system.md](ai-system.md) — AI overview hub. Detail: [ai-infra.md](ai-infra.md) (Rust), [ai-chat.md](ai-chat.md) (chat + tools).
- [ai-model-selection.md](ai-model-selection.md) — model picker UX: Auto mode, effort/thinking controls.
- [LOG.md](LOG.md) — decision ledger.
