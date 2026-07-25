# LOG.md

## How to use this file

ULTRA CONCISE!!! One line per entry. Date, decision or event, rationale if non-obvious. No prose. No detail. Detail belongs in the relevant system doc.

---

## 2026-05-16

- **Refined editor save UX.** Added tested save-state enum/controller/status policy, actionable footer save states, stable auto-save mode text, footer view/zoom polish, and line-width setting.

## 2026-05-13

- **Pinia migration.** Replaced 6 composables with 13 Pinia stores (`src/stores/`). usePanelStore.js (1615 lines) split into 8 focused modules. Sidebar prop drilling eliminated (13→6 props). Test count 136→362. Chat SDK instances stay in module-level Map with _chatVersion bridge.

## 2026-05-10

- **Decision: centralized data.** All mim terminal project data lives in `~/.mim/projects/{project_id}/`. Workspace folder gets only a `.mim.json` marker with `project_id`. Keeps user folders clean for git/sync. See architecture.md.
- **Decision: references are global.** Reference library is global (`~/.mim/references/`), not project-scoped.
- **Decision: sessions belong to projects.** Sessions are strictly project-scoped, stored in `~/.mim/projects/{project_id}/sessions/`. Non-project chats use a synthetic "General" project.
- **Decision: Panel is 2 columns.** Column 1: project/session navigator. Column 2: chat conversation. No review pane in Panel — diffs/review happen in Editor.
- **Decision: implement AI SDK streaming path through Rust transport.** Use AI SDK provider adapters + `ToolLoopAgent` + `bridgeFetch.js` + Rust `ai_proxy_stream`; keep `ai_generate` for ghost/rewrite.
- **Decision: review before mutation.** Panel never directly inserts into Editor. All agent changes go through proposals. Accept/reject is bidirectional (Panel and Editor).
- Created `plan-panel.md` and `plan-panel-alt.md` for Panel design.
- **Revised `plan-panel-alt.md`:** full rewrite incorporating all review feedback. Thread→session terminology, 2-column layout (no review pane in Panel), file-change cards, Editor-owns-diffs design, AI SDK streaming architecture, project-scoped sessions, cross-window Rust messaging, pending-changes model.
- Added Claude prompt-caching implementation plan after reviewing v0.2.x `tauriFetch.js`; v0.3.x should use provider-aware Anthropic cache policy, not URL substring detection.
- Revised Claude caching plan to use Anthropic top-level automatic `cache_control`; explicit breakpoints are later optimization only.
- Implemented Anthropic automatic prompt caching plus cache read/write usage normalization and harness visibility.
- **Decision: folder structure.** Editor in `src/editor/`, Panel in `src/panel/`, shared in `src/shared/` + `src/services/`. `src/main.js` routes between apps. Updated plan-panel-alt.md with concrete file paths.
- **Decision: model UX.** Two controls only: Model plus Effort/Thinking; `Auto` is model choice; Haiku labels are None/Low/Medium/High. See docs/ai-model-selection.md.
- **Built: Panel component tree.** Broke monolithic AgentsPanel.vue into 11 components under `src/panel/`: App.vue, TopBar, Sidebar, SidebarRow, ChatView, ChatMessage, Composer, ModelPicker, ControlPicker, ToolCallBlock, FileChangeCard + usePanelStore composable. Build passes. Design follows Panel.html mock.
- **Created `docs/panel-system.md`.** Full handoff doc: architecture, file map, streaming flow diagram, data model, decisions, next steps, gotchas. Added to _MAP.md.
- **Docs audit and update.** Deleted `codex-app.md` (wrong file — OpenAI docs). Updated `_MAP.md`, `editor-system.md`, `ui-layout.md`, `README.md` to reflect editor/panel split, Vue port state, dead old root files (`src/App.vue`, `src/AgentsPanel.vue`, `src/styles.css`). Added `plan-vue-mock.md` to Systems table.
- **Built: NewChat landing screen.** Created `src/panel/components/NewChat.vue` — centered composer with search-as-you-type, collapsible skills/workflows lists, recent chats, skill chip attachment, project context row. Wired into App.vue: shows when active session has zero messages, auto-transitions to ChatView on first send. Ported from Panel.html mock.

## 2026-05-11

- **UI fixes.** Sidebar items left-aligned (button reset `text-align: left`). Removed "x keys, y sessions" from sidebar footer. Search-as-you-type now requires `@` prefix — regular typing is the chat message.
- **Decision: generic file I/O, not domain commands.** Session/settings persistence uses generic `read_text_file`/`write_text_file`/`create_dir`/`list_dir`/`delete_path` in Rust. JS service layer (`src/services/dataDir.js`) composes these into domain operations. Follows v0.2.x pattern.
- **Built: Rust file I/O commands.** Added `create_dir`, `list_dir`, `delete_path` to `lib.rs`. Now 6 file commands total.
- **Built: `src/services/dataDir.js`.** Service layer for data dir, projects, sessions, and settings. Wraps Tauri invoke calls into domain operations.
- **Built: disk persistence for Panel sessions.** `usePanelStore.js` now saves sessions to `~/.mim/projects/{projectId}/sessions/{id}.json` via dataDir service. Falls back to localStorage when not running in Tauri (browser dev). Debounced 500ms.
- **Decision: start clean.** v0.3 does not auto-migrate from `~/.mim/` (v0.2.x). Fresh install.
- **Decision: icons are Tabler or Phosphor, not Lucide.** Current Lucide imports must be replaced across all Panel components.
- **Created `docs/plan-panel-wiring.md`.** Comprehensive plan: 7 workstreams covering persistence, AI smoke test, icon switch, popover, settings, usage ledger, cross-window bridge. Includes agent handoff notes.
- **Fixed: Panel chat now works.** Root cause: Chat instances stored on reactive session objects broke Vue's reactivity tracking of the Chat's internal `ref()` values. Fix: adopted v0.2.x proven pattern — Chat instances live in a module-level `Map` outside Vue, accessed via `getChatInstance()` with a `_chatVersion` counter bridge. Computeds read `chat.state.messagesRef.value` directly. `sendMessage` is NOT awaited.
- **Fixed: Anthropic 400 from Word Bridge tools.** `z.object({})` omits `type: "object"` which Anthropic requires. Removed Word Bridge tools from the chat tool set for now.
- **Studied v0.2.x chat system in depth.** Key learnings documented in `gotchas.md`: Chat Map pattern, parts array reference reuse, `sendMessage` async timing, tool schema requirements. Architecture updated in `panel-system.md`.
- **Created `docs/ai-sdk-vue-integration.md`.** Authoritative reference for AI SDK + Vue integration: Chat Map pattern, reactivity architecture, transport chain, message format, tool definitions, persistence, cancel/abort, and v0.2.x patterns to port.
- **Executed panel-wiring W1–W4, W6–W7.** Fixed 3 persistence bugs (markRaw, project metas, message serialization). Replaced all Lucide icons with Tabler webfont across 9 Panel components. Built `usePopover()` composable with `@floating-ui/vue` for auto-flipping dropdowns. AI smoke test: 46/46 provider tests pass (Anthropic/OpenAI/Google). Built `useEditorSettings` composable for editor settings persistence to `~/.mim/settings.json`. Ported SQLite usage ledger from v0.2.x — `usage.rs` with `usage_record`/`usage_query_month`/`usage_get_setting`/`usage_set_setting`, wired `onUsage` in Panel store. W5 (cross-window bridge) deferred per plan — blocked on editor Phase 2.
- **Documented editor hot path.** Added `docs/editor-performance.md` for edit-path rules, deferred preview/outline/document bridge budgets, and current outline benchmark.
- **Fixed editor polish issues.** Default docked sidebar now starts collapsed, Parchment editor uses surface while sidebar uses mid chrome, git clone/init commands are registered, and settings inject fallback is service-safe.
- **Refined editor chrome.** Sidebar title bars use surface plus rule, sidebar toggle is stateful with hover action icons, and active file tabs have a clearer filing-tab edge.
- **Corrected editor navigation ownership.** Removed normal-mode document tab styling from native header; document navigation belongs to workspace tab strip, sidebar titles belong to panels.
