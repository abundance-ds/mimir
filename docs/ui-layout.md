# UI Layout And Windows

Status: two-app split implemented. Editor Vue shell ported from mock, Panel component tree built.

## Key Files

| File | Role |
|---|---|
| `src/panel/App.vue` | mim terminal root shell (primary window, label `main`) |
| `src/panel/components/` | Panel navigator, chat, composer, model/control pickers, tool/proposal display |
| `src/stores/panel/` | Panel stores: sessions, chat instances, projects, workflows, persistence, cross-store actions |
| `src/editor/App.vue` | Editor shell (secondary, labels `editor-*`) |
| `src/panel/agentsWindow.js` | `openOrFocusEditorWindow()`, `autoRestoreEditorWindow()` |
| `src/editor/agentsWindow.js` | `openPanelWindow()` — focuses `main` |
| `src/shared/windowChrome.js` | Shared Tauri overlay titlebar options for custom app chrome |
| `src/main.js` | Chooses root Vue component from URL params |
| `src/shared/styles/app.css`, `src/panel/styles.css` | Global/editor styles and Panel styles |
| `src-tauri/tauri.conf.json` | Product/window title, dimensions, file associations |
| `src-tauri/capabilities/default.json` | Tauri window/webview permissions |
| `src-tauri/src/file_open.rs` | `PendingFilePaths` state, `take_pending_files` command, `filter_file_args()`, `open_files_in_editor()`, `create_editor_window()` |
| `src/editor/composables/useFileOpen.js` | Listens for `mim://open-file` event, checks `take_pending_files` on mount |

## Current Shell

`src/editor/App.vue` assembles components from `src/editor/components/`:

- `AppHeader` — top bar with sidebar toggle and Windows app menus
- `AppRail` — left rail with icon buttons for sidebar panels and agents
- `Sidebar` — resizable sidebar with 7 panel modes (agents, export, history, notes, outline, refs, and more); in narrow editor windows it opens as a temporary overlay beside the rail
- `TabStrip` — open file tabs with dirty indicators
- `EditorToolbar` — formatting toolbar (toggle on/off)
- `EditorSurface` — editor area (currently contenteditable; target: CodeMirror)
- `PreviewPane` — markdown preview for split/preview view
- `AppFooter` — status bar with zoom, view mode, selection info
- `SettingsDialog` — toolbar mode settings

Note: the old `src/App.vue` (pre-port, not mounted) also had command palette, export sheet, and full AI/comment/citation/ghost settings. Those features are not yet ported to the new component tree.

The shell is intentionally dense and grounded:

- left rail, not persistent file tree
- docked panels at normal widths; narrow-window overlays only when a dock would crowd the workspace
- low radius and minimal shadow
- comments/issues/references as rows/records, not rounded cards
- AI text edits are inline/proposal-based; broader chat lives in the Panel

## Naming

Visible product name: `mim terminal`

- Primary window (label `main`): the Panel — opens on launch
- Editor windows (labels `editor-*`): opened on demand from the Panel

Internal package/library names now use `mim-terminal`.

## Multi-Window Model

Window labels:

```txt
main                mim terminal (primary window, opens on launch)
editor-*            Editor windows (opened on demand from Panel)
```

Routes:

- `/` renders the Panel (`src/panel/App.vue`) — the default.
- `/?view=editor` renders the Editor (`src/editor/App.vue`).
- `/?new=1&window=<label>` renders `src/editor/App.vue` as an empty unsaved editor window.

Window creation is programmatic — the Panel is created in `.setup()` and `app.windows` in `tauri.conf.json` is empty. Editor windows are created via `create_editor_window()` in `src-tauri/src/file_open.rs`.

File association and opening:

- `tauri.conf.json` `bundle.fileAssociations` registers `.md`, `.markdown`, `.txt` — OS double-click opens in the Editor.
- `tauri-plugin-single-instance` routes file args from a second launch to the running instance.
- `src-tauri/src/file_open.rs` holds `PendingFilePaths` state and exposes `take_pending_files`, `filter_file_args()`, `open_files_in_editor()`, `create_editor_window()`.
- `src/editor/composables/useFileOpen.js` listens for `mim://open-file` and checks `take_pending_files` on mount.
- macOS `RunEvent::Opened` handler in `src-tauri/src/lib.rs` routes `file://` URLs to `open_files_in_editor()`.

Important files:

- `src/main.js` selects the Editor root when `view=editor`; otherwise it mounts the Panel root.
- `src/panel/agentsWindow.js` exposes `openOrFocusEditorWindow()` (focuses existing `editor-*` or creates one) and `autoRestoreEditorWindow()`.
- `src/editor/agentsWindow.js` exposes `openPanelWindow()` which focuses the `main` window.
- `src/shared/windowChrome.js` keeps dynamic Tauri windows on the same overlay titlebar chrome as the main window.
- `src/panel/App.vue` and `src/panel/components/` own the two-column Panel shell; `src/stores/panel/` owns local projects/session metadata and streaming chat instances (split across 8 modules).
- `src-tauri/capabilities/default.json` grants window/webview permissions to `main` and `editor-*`.

Rust `focus_main_window` focuses or recreates the Panel window (used by the editor rail button). JS `getAllWebviewWindows` cannot see config-created windows, so this must go through Rust.

Rust event routing:

- `proposal_send` emits to `editor-*` windows.
- `proposal_respond` and `document_context_send` emit to `main` (the Panel).
- `tab_drag_resolve` hit-tests cursor position against all `editor-*` windows, emits `mim://tab-receive` via `emit_to` (window-scoped) to the target. JS listeners use `getCurrentWindow().listen()` to avoid receiving events meant for other windows.
- Document bridge includes `windowLabel` in its payload.

Tab drag mechanics:

- Pointer-event-based (not HTML5 DnD, which conflicts with Tauri's `-webkit-app-region`).
- Reorder within window, tear-off to new window at cursor position, cross-window transfer.
- Single-tab tear-off closes the source window.

Expected behavior:

- Panel opens on launch as the primary window.
- "Editor" button in Panel header calls `openOrFocusEditorWindow()` — focuses an existing `editor-*` or creates one.
- Panel auto-restores an editor window on mount if the saved session has open files (`autoRestoreEditorWindow()`).
- "Panel" button in Editor header calls `openPanelWindow()` which focuses `main`.
- Both cross-window buttons use the same pill style and sit in the top-right of their respective headers.
- Panel chat sessions can stream in parallel.
- Panel width defaults to 960x760 with 520px minimum width. Under 640px webview width, the Panel keeps the active content visible and turns the session sidebar into an overlay drawer controlled by the top-bar sidebar button. The drawer closes on scrim click, Escape, and narrow-width navigation actions.
- Editor windows keep the rail and workspace visible in small desktop widths. Under 760px webview width, editor sidebar panels open as a temporary overlay beside the rail and close on scrim click, Escape, and narrow-width navigation actions. Split view stacks editor over preview instead of squeezing two thin columns.
- Editor and Panel windows use native macOS traffic-light controls in a Tauri overlay titlebar. Vue headers reserve left-side space but do not draw fake OS buttons.

When multi-window behavior fails in Tauri but works in browser fallback, check `src-tauri/capabilities/default.json` first.

## Current Persistence

The new editor shell uses static data modules (`src/editor/data/`) — no persistence yet. The old `src/App.vue` shell used `localStorage` with `mim:` prefix (prototype naming, not a final settings schema).

Old shell localStorage keys (for reference during port):

- `mim:doc`
- `mim:comments`
- `mim:refs`
- `mim:theme`
- `mim:editorSize`
- `mim:author`
- `mim:referencesPath`
- `mim:commentsPath`
- `mim:panel:sessions:v1` for prototype Panel projects, session metadata, messages, usage, and proposal card statuses

`?new=1` editor windows are intentionally in-memory and bypass save-to-`mim:doc`.

Panel persistence is prototype-only. Durable session JSON belongs under `~/.mim/projects/{project_id}/sessions/` once the project/session store lands.

## Conventions

- Preserve dense, grounded editor UI.
- Prefer docked panels at normal widths; use overlay drawers only as a narrow-window fallback.
- Keep inline AI controls near text only when they relate to text insertion/rewrite.
- Keep full chat/agent workflows in the Panel (primary window), not the editor surface.

## Needs Sprint Owner Details

- Final window/tab/file-opening behavior.
- Final settings schema and persistence.
- Durable project/session persistence and proposal apply UI once real agent/review workflows mature.
