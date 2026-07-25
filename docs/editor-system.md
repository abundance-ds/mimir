# Editor System

Status: Feature-complete (2026-05-11). 56/56 features audited and passing. All 5 phases done plus quality pass.

## Architecture Overview

The editor is a Vue 3 application with CodeMirror 6 as the editing surface. File I/O and reference storage go through Tauri commands. Session state, settings, comments, and references persist to disk at `~/.mim/`.

```
App.vue  →  useEditorUIStore (UI shell)
         →  useFileStore (tab-file lifecycle, recent files, save-state transitions)
         →  autoSaveController.js + saveStatus.js (auto-save debounce and footer/tab save UX)
         →  useCommentsStore (comment CRUD, persistence)
         →  useSettingsStore (settings persistence, Pinia app-level)
         →  EditorSurface (CM6 instance via codemirror/core.js, Compartments for settings)
         →  editorExtensions (computed: ghost + citations + comments + formatting)
         →  nativeMenu.js (macOS desktop TOP TITLE menu; Windows APP HEADER handled by AppHeader)
         →  fileSystem.js → Tauri commands → disk
         →  session.js → Tauri commands → ~/.mim/session.json
         →  references.js → Tauri commands → ~/.mim/references/library.json
         →  export/pdf.js → Tauri command → typst_export.rs → PDF
         →  export/docx.js → JS docx package → write_binary_file → DOCX
```

## Entry Point

`src/main.js` mounts `src/editor/App.vue` by default. The `?view=agents` route lazy-loads the Panel instead.

## Component Tree

18 Vue components, 3110 lines total.

| Component | File | Lines | Purpose |
|---|---|---:|---|
| `App.vue` | `src/editor/App.vue` | — | Root shell. Wires composables, platform menus, keyboard shortcuts, session restore, CM6 extensions, reference library, comments, settings provider, and narrow-window shell behavior. Business logic extracted into composables (useContentSync, useCommentMutations, useDiffReview, useTabManagement) and saveFeedback store. |
| `SettingsDialog` | `src/shared/ui/SettingsDialog.vue` | 119 | Unified settings dialog (shared between Editor and Panel). 9 sections in 2 groups: AppearanceSection, EditorSection, PanelSection, AISection, ToolsSection, UsageSection, AuditSection, ShortcutsSection, AboutSection. Shared form CSS: `src/shared/ui/settings/settings-form.css`. `Cmd+,` opens settings in both Editor and Panel. |
| `SidebarExport` | `components/sidebar/SidebarExport.vue` | 486 | Export panel: PDF/DOCX format chips, template/font/citation style settings, save dialogs. |
| `IssueContextBar` | `components/IssueContextBar.vue` | 93 | Context bar for board files (issues). Inline-editable title, status dropdown, priority dropdown, "Send to Agent" button. Shown above EditorSurface when current file has `meta`. Updates metadata via `fileStore.updateMeta()`. |
| `SidebarNotes` | `components/sidebar/SidebarNotes.vue` | 257 | Comment threads from useCommentsStore. Replies, resolve, delete, click-to-scroll. |
| `EditorSurface` | `components/workspace/EditorSurface.vue` | 303 | CM6 editor instance. Receives content prop, exposes formatting/edit commands (including strikethrough, blockquote, horizontal-rule), emits change/selection-change/cursor/selection-command/comment/active-formats/ask-agent. Reads settings via useSettingsStore(), reconfigures Compartments (font, size, wrap, spellcheck). `@contextmenu.prevent` on CM6 host wires to `EditorContextMenu`. `format()` calls `view.focus()` after executing commands. |
| `RewriteOverlay` | `components/workspace/RewriteOverlay.vue` | 206 | Cmd+K inline rewrite: instruction input, diff view, accept/reject. |
| `SidebarRefs` | `components/sidebar/SidebarRefs.vue` | 158 | Reference library (real data). Search, filter, BibTeX import. |
| `Sidebar` | `components/sidebar/Sidebar.vue` | 94 | Sidebar container with resize handle. Routes to active panel; becomes a temporary overlay beside the rail in narrow editor windows. |
| `SidebarOutline` | `components/sidebar/SidebarOutline.vue` | 78 | Presentational document outline. Receives heading data from the CM6 outline extension and scrolls by document position. |
| `AppFooter` | `components/shell/AppFooter.vue` | 81 | Status bar: document stats/selection info, actionable save-state status, zoom, and view mode switcher. Hides low-priority controls at very narrow widths. |
| `EditorToolbar` | `components/workspace/EditorToolbar.vue` | 74 | Formatting toolbar (top mode). Button layout: `[H1 H2 H3] [B I S] [• 1. ☐] [> ―] [Link Image Code] [$ Cite]`. All buttons use `@mousedown.prevent` and have `title` tooltips with keyboard shortcuts. `activeFormats` prop highlights buttons when cursor is in formatted text. Uses `v-if` in parent (no `collapsed` prop). Horizontally scrolls instead of wrapping in narrow windows. |
| `AppRail` | `components/shell/AppRail.vue` | 63 | Left rail: icon buttons for sidebar panel modes. Slightly compresses and hides text labels in very narrow windows. |
| `AppHeader` | `components/shell/AppHeader.vue` | 520 | Top bar: custom window chrome with sidebar toggle. On Windows only, also exposes File/Edit menus inside the existing APP HEADER. |
| `TabStrip` | `components/workspace/TabStrip.vue` | 550 | Draggable tabs via pointer events (not HTML5 DnD). Source tab collapses to zero width during drag; a ghost clone shows where it will land. Reorder: ghost snaps into a tab-width gap at the drop position. Tear-off (>40px from strip): ghost floats at cursor, native ghost window follows outside webview. Cross-window transfer via Rust `tab_drag_resolve` + `emit_to`. New-window transfer uses `get_cursor_position` for OS-level coords. TransitionGroup FLIP animates reorder. Escape cancels. Arrival pulse on received tabs. |
| `SidebarAgents` | `components/sidebar/SidebarAgents.vue` | 21 | Agent sessions panel. |
| `SidebarHistory` | `components/sidebar/SidebarHistory.vue` | 18 | Git-backed version history panel. Timeline of commits touching the active file ("Current" marker for HEAD). Click a version → opens diff viewer via `useDiffStore().activate()` with `review.type: 'history'`. |
| `EditorContextMenu` | `components/workspace/EditorContextMenu.vue` | 155 | Right-click context menu with macOS spellcheck suggestions (via `spell_suggest` Rust command), cut/copy/paste/select-all. When text is selected, also shows "Add Comment" and "Ask AI" items. |
| `PreviewPane` | `components/workspace/PreviewPane.vue` | 17 | Live markdown preview via marked. Shown in split/preview view modes. |

All paths relative to `src/editor/`.

## Stores and Composables

Pinia stores (in `src/stores/`):

| File | Lines | Purpose |
|---|---:|---|
| `stores/settings.js` | 115 | `useSettingsStore` — unified settings (Pinia, app-level). Loads from `~/.mim/settings.json` (Tauri) or localStorage (browser). Persists via explicit `set(key, value)` with 300ms debounce. Applies theme, cross-window sync via `mim://settings-changed` Tauri event (emits to other windows only). Exposes `isDarkTheme` computed. Notable keys: `aiGhostModel`, `disabledTools`, `editorToolbarMode` (`top`/`none`, default: `top`). |
| `stores/editorUI.js` | 83 | `useEditorUIStore` — UI shell state: sidebar visibility, active panel, view mode, and zoom level. Includes narrow-window panel close helpers. Does not own file/content state. (Toolbar mode moved to settings store as `editorToolbarMode`.) |
| `stores/files.js` | 287 | `useFileStore` — tab-file lifecycle: open files array, active file index, recent-file tracking, dirty tracking, save-state/error tracking, save/save-as/close actions. Calls `fileSystem.js` for I/O. Auto-save scheduling lives in `src/editor/autoSaveController.js`. Board files (`path.includes('/board/')`) get frontmatter parsed on open — `file.meta` holds the YAML metadata, `file.content` holds the body only. On save, `serializeEntry(meta, body)` reconstructs the full file. `updateMeta(fileId, updates)` merges changes, stamps `updated`, and marks dirty. After saving a board file, emits `mim://board-changed` for kanban refresh. |
| `stores/comments.js` | 133 | `useCommentsStore` — thin reactive mirror of inline `<comment>` tags parsed by the CM6 extension. Active comment tracking for editor highlight sync. No persistence logic — the document text is the single source of truth. |
| `stores/saveFeedback.js` | 72 | `useSaveFeedbackStore` — save feedback state machine. Manages footer UI state (`savingVisible`, `savedVisible`, `savedLabel`) with timed transitions for "Saving..." / "Saved" / "Saved as X" feedback. |

Composables (in `src/editor/composables/`):

| File | Lines | Purpose |
|---|---:|---|
| `composables/useDeferredMarkdownPreview.js` | 139 | Deferred Markdown preview renderer. Custom `Marked` instance injects `data-source-line` attributes on block elements for scroll sync. Schedules work after edit sync/idle and renders immediately only when switching into split/preview. |
| `composables/useScrollSync.js` | 93 | Editor→preview scroll sync. Reads CM6 top visible line, interpolates between `[data-source-line]` anchors in the preview DOM, snaps to bottom. Active in split mode only. |
| `composables/useDocumentBridge.js` | 58 | Throttled document-context bridge. Writes browser fallback `mim:doc` and emits Tauri `document_context_send` outside the immediate edit path. |
| `composables/useSidebarResize.js` | 43 | Pointer drag logic for sidebar width. |
| `composables/useCommentPositions.js` | — | Comment position tracking for sidebar scroll sync. |
| `composables/useKeyboardShortcuts.js` | — | Centralized keyboard shortcut registration. |
| `composables/useProposalBridge.js` | — | Listens for `diff-open` events, stashes per-file `review` cache, exports `computeDiffFromReview()` for on-demand diff recomputation. |
| `composables/useSubmitReview.js` | 29 | Shared composable for sending comments + document content to Panel chat. Injects comments inline via `injectCommentsInline`, then invokes `comments_submit` + `focus_main_window` Tauri commands. Used by SidebarNotes and IssueContextBar's "Send to Agent". |
| `composables/useContentSync.js` | 67 | Debounced content propagation: CM6 → file store → document bridge → markdown preview. Exposes `flushEditorContent`, `scheduleContentSync`, `syncOpenFileSnapshot`. |
| `composables/useCommentMutations.js` | 80 | Comment tag CRUD on the CM6 document: addReply, resolve, unresolve, delete, updateText, clearAll. Provided to children via `provide('commentMutations', ...)`. |
| `composables/useDiffReview.js` | 193 | Diff accept/reject/navigate orchestration. Handles single-file, batch, inline-AI, and history diff modes. Sends `proposal_respond` to Rust for proposal lifecycle. |
| `composables/useTabManagement.js` | 216 | Tab lifecycle: select, close (with save confirmation dialog), drag-out, cross-window transfer, new file, reorder. Owns `closeConfirmFile` and `arrivedTabIndex` refs. |

Editor save helpers:

| File | Purpose |
|---|---|
| `src/editor/autoSaveController.js` | 1-second auto-save debounce. Flushes editor content before saving; skips disabled auto-save and untitled files. |
| `src/editor/saveStatus.js` | Pure presentation policy for tab dirty/failure attention and footer save labels/actions. |
| `src/shared/saveState.js` | Shared save-state enum (`idle`, `dirty`, `saving`, `saved`, `failed`). |

## Services

All in `src/services/`. 3318 lines total across 24 files.

| File | Lines | Purpose |
|---|---:|---|
| `services/ai/tools/index.js` | 462 | Panel chat tool definitions (document, references, research, project, docxReview, shell). |
| `services/citationFormatter.js` | 455 | Pure JS citation formatter: APA 7th, Chicago, MLA 9th, IEEE, Vancouver. Zero dependencies. |
| `services/export/docx.js` | 437 | Generates DOCX from markdown using docx npm package. Parses with marked lexer, builds OOXML document, writes via write_binary_file. |
| `services/bibtexParser.js` | 321 | Standalone BibTeX parser: parses .bib text into structured entries. Zero dependencies. |
| `services/ai/sdkAdapter.js` | 247 | AI SDK model factory. |
| `services/dataDir.js` | 184 | Low-level data directory helpers: projects, sessions, settings. Wraps Tauri file invokes. |
| `services/ai/bridgeFetch.js` | 146 | Tauri fetch bridge for AI SDK. |
| `services/docxPath.js` | 11 | Shared DOCX path ref for workflow document selection. |
| `services/ai/modelControls.js` | 114 | Model/effort/thinking control state. |
| `services/fileSystem.js` | 105 | Thin async wrapper around Tauri file dialog + read/write invocations. Functions: openFileDialog, saveFileDialog, saveFile, readFile. |
| `services/ai/chatTransport.js` | 61 | AI SDK streaming transport for panel chat. |
| `services/ai/ghost.js` | 63 | Ghost suggestion prompts: requestGhostSuggestions. |
| `services/ai/tools/gate.js` | 59 | Tool gating logic. |
| `services/references.js` | 57 | Reference library CRUD: loadLibrary, addReference, removeReference, importBibtex, searchReferences, extractCitedKeys. Wraps Rust ref_* commands. |
| `services/ai/context.js` | 53 | Prefix/suffix extraction, documentIdFromPath. |
| `services/ai/tools/textMatch.js` | 51 | Text matching utilities for tools. |
| `services/session.js` | 48 | Saves and restores session state (open file paths, recent file paths, active index, sidebar, view mode, zoom) to ~/.mim/session.json. (Toolbar mode moved to settings persistence.) |
| `services/ai/recovery.js` | 47 | AI error recovery logic. |
| `services/ai/rewrite.js` | 45 | Selection rewrite prompts: requestSelectionRewrite. |
| `services/ai/client.js` | 44 | Tauri invoke wrapper for AI commands. |
| `services/ai/systemPrompt.js` | 119 | Core system prompt and chat instruction assembly. |
| `services/ai/errors.js` | 25 | AI error types. |
| `services/export/pdf.js` | 20 | Invokes Rust export_pdf command with markdown content, template, and settings. Returns PDF file path. |

## Shell Helpers

| File | Lines | Purpose |
|---|---:|---|
| `editor/nativeMenu.js` | 167 | Installs the macOS desktop TOP TITLE menu for File/Edit/View/Window/Help. Intentionally skipped on Windows and Linux to avoid adding an OS HEADER. |
| `shared/platform.js` | 24 | Small platform detection helpers plus primary modifier handling for Command on macOS and Ctrl elsewhere. |

## CM6 Extensions (`src/editor/codemirror/`)

8 extensions, ~1248 lines total. All wired to their backends in `src/editor/App.vue` via the `editorExtensions` computed property.

| File | Lines | Purpose | Backend |
|---|---:|---|---|
| `ghost.js` | 310 | `++` ghost suggestion extension: pending indicator, inline suggestion widget, hint line, Tab/Enter/Arrow accept, cycle, cancel. `GhostErrorWidget` shows auth errors inline with [Esc] dismiss (`.ghost-error-line` CSS). | `services/ai/ghost.js` |
| `citations.js` | 223 | `[@` citation autocomplete, viewport decorations, hover tooltips. | `services/references.js` (via `referenceLibrary` ref) |
| `core.js` | 175 | `createEditor()` factory: base CM6 setup, history, markdown language (with `Strikethrough` extension from `@lezer/markdown`), theme, keymaps, Compartments for settings (font, size, wrap, spellcheck). No gutter (line numbers, fold gutter removed). CSS variable bridge. `onActiveFormats` callback fires `detectActiveFormats` on every selection/doc change. | N/A (self-contained) |
| `comments.js` | 115 | Comment StateField with mapPos, range highlight decorations, click-to-highlight, active thread styling, bidirectional scroll. Gutter dots removed. | `stores/comments.js` (`useCommentsStore`) |
| `formatting.js` | 157 | 17 markdown formatting commands with syntax-tree-aware toggle: bold, italic, strikethrough, code, heading 1-4, bullet list, numbered list, checkbox, blockquote, horizontal rule, link, image, citation, math. Exports `detectActiveFormats(state)` for toolbar button highlighting. Uses `syntaxTree` from `@codemirror/language` to detect existing formatting and unwrap whole nodes instead of corrupting markup. | N/A (operates on CM6 state) |
| `livePreview.js` | — | Semi-WYSIWYG live preview: hides Markdown syntax (bold/italic/strikethrough/code/link markers, heading hashes, blockquote `>`, HR) when cursor is not on that line; replaces images with `<img>`, tables with HTML `<table>`, HR with `<hr>` widget. Uses `Decoration.replace({})` for hidden markers (CM6-native, no CSS hiding) and `Decoration.mark` for styling. ViewPlugin for inline decorations, StateField for block-level table decorations. Toggle via `poke()` dispatch. Setting: `editorLivePreview` (default: true). | N/A (operates on CM6 state) |
| `outline.js` | 99 | Debounced/idle CM6 outline extraction from the editor document. Emits heading level, text, line, and document position to Vue. | `SidebarOutline.vue` |
| `references.js` | 93 | Reference diagnostics: missing cite keys, duplicate keys. | `services/references.js` |

## Rust Backend (`src-tauri/src/`)

16 modules, 3883 lines total.

| File | Lines | Purpose |
|---|---:|---|
| `typst_export.rs` | 705 | Markdown-to-Typst conversion via pulldown-cmark, 5 templates (clean, academic, report, letter, compact), runs bundled typst sidecar (`src-tauri/binaries/typst-{target}`, falls back to system PATH), returns PDF path. |
| `ai_providers.rs` | 456 | Rust-native ghost/rewrite provider wire formats and API calls. |
| `ai_proxy.rs` | 391 | AI SDK streaming bridge, cancel, cleanup. |
| `ai_keys.rs` | 274 | Keychain/env/debug key fallback resolver. |
| `ai_models.rs` | 271 | Model registry/config loader and migration. |
| `usage.rs` | 258 | Usage ledger (SQLite at ~/.mim/usage.db). Commands: usage_record, usage_query_month, usage_get_setting, usage_set_setting. |
| `lib.rs` | 225 | Tauri command registration, file commands, plugin setup, devtools. macOS spellcheck: `enable_macos_spellcheck()` (NSUserDefaults), `spell_suggest()` (NSSpellChecker via objc2). |
| `references.rs` | 163 | Reference library read/write/import at ~/.mim/references/library.json. Commands: ref_list, ref_add, ref_remove, ref_import_bibtex. Cite key generation (lastName+year+suffix). |
| `ai.rs` | 128 | AI command surface (Tauri commands for ai_generate, ai_models, etc.). |
| `git.rs` | 102 | Git operations exposed as Tauri commands: clone, init, status, `git_file_log` (commit history for a file), `git_file_at_revision` (file content at a specific commit). Version history relies on user-managed git; mim terminal does not create commits. |
| `ai_transport.rs` | 96 | HTTP allowlist/timeout/redaction for AI requests. |
| `ai_usage.rs` | 68 | Usage normalization helpers. |
| `main.rs` | 3 | App entrypoint (calls lib::run). |

## CSS Bridge

`src/shared/styles/editor-content.css` maps the design system's Tailwind tokens to the CSS variable names used by `codemirror/core.js`:

```css
--ink: var(--color-ink);
--editor-paper: var(--color-surface);
--accent: var(--color-accent);
```

This file also defines ghost decoration styles (`.ghost-text`, `.ghost-loading`, `.ghost-hint-line`) and comment highlight styles used by CM6 extensions. These styles live outside Vue components because CM6 widgets render outside Vue's template system.

## Data Flow Diagrams

### 1. File Lifecycle

```
Open → Edit → Auto-save → Open Recent → Close → Session Restore

Command entry points:
macOS TOP TITLE native menu → nativeMenu.js → App.vue handlers
Windows APP HEADER File/Edit → AppHeader.vue → App.vue handlers
Linux keyboard shortcuts → App.vue handlers

Disk → fileSystem.readFile() → useFileStore.openFile() → openFiles[i].content
  → useFileStore.addRecentFile() → recentFiles
  → App.vue passes content prop to EditorSurface
    → CM6 doc state
      → CM6 updateListener marks dirty without serializing the full doc
        → App.vue debounces full-text sync to useFileStore
          → useDocumentBridge throttles panel/localStorage context
          → useDeferredMarkdownPreview schedules preview rendering outside source mode
          → auto-save controller flushes latest CM6 content, then fileSystem.saveFile() → Disk
          → saveStatus.js maps save state to tab/footer attention

Close → session.save() → ~/.mim/session.json
Launch → session.restore() → setRecentFiles → for each open path: readFile → openFile
```

Preview pane: `useDeferredMarkdownPreview` renders via `marked` only outside source mode, after debounced content sync or immediately on view-mode switch.

Outline pane: `outlineExtension()` derives headings from the CM6 document after document changes settle, so the sidebar no longer parses `currentFile.content` during Vue renders.

Performance contract and timing budgets are documented in [editor-performance.md](editor-performance.md).

### 2. Settings

```
useSettingsStore() → Pinia store (app-level, no provide/inject)
  │
  ├─ SettingsDialog.vue → useSettingsStore() → reads/writes reactive refs (font, size, wrap, etc.)
  │   → auto-save (300ms debounce) → ~/.mim/settings.json
  │
  └─ EditorSurface.vue → useSettingsStore() → watches settings refs
      → reconfigures CM6 Compartments (fontFamily, fontSize, lineNumbers, lineWrapping, spellcheck)
      → CM6 view updates immediately
```

Editor setting keys:

| Key | Values | Default |
|---|---|---|
| `editorFontFamily` | `'sans'` / `'serif'` / `'mono'` / `'slab'` | `'mono'` |
| `editorFontSize` | number | `16` |
| `editorToolbarMode` | `'top'` / `'none'` | `'top'` |
| `editorLineWidth` | `'normal'` / `'wide'` / `'off'` | — |
| `editorLivePreview` | boolean | `true` |
| `editorAutoSave` | boolean | — |
| `editorSpellCheck` | boolean | `false` |

Font system: `src/shared/fonts.js` is the single source of truth for editor font options and key-to-family mapping.

Settings dialog: 9 sections in 2 groups — AppearanceSection, EditorSection, PanelSection, AISection, ToolsSection, UsageSection, AuditSection, ShortcutsSection, AboutSection. Shared form CSS: `src/shared/ui/settings/settings-form.css`. `Cmd+,` opens settings in both Editor and Panel.

### 3. AI Ghost / Rewrite

```
Ghost:
  User types "++" in CM6
    → ghost.js extension triggers
      → getSuggestions callback (from App.vue editorExtensions computed)
        → services/ai/ghost.js → requestGhostSuggestions()
          → Tauri invoke ai_generate → Rust AI kernel → LLM
            → suggestions returned → ghost.js shows inline widget
              → Tab accepts, Escape dismisses

Rewrite:
  User selects text, presses Cmd+K
    → CM6 onSelectionCommand → App.vue onSelectionCommand
      → rewriteState ref set → RewriteOverlay.vue shown
        → User enters instruction, submits
          → services/ai/rewrite.js → requestSelectionRewrite()
            → Tauri invoke → Rust AI kernel → LLM
              → diff shown in overlay
                → Accept: editorSurfaceRef.replaceRange() → CM6 transaction
                → Reject: rewriteState = null → overlay dismissed
```

### 4. Citations

```
Reference Library Load:
  App.vue onMounted → loadLibrary() → Tauri invoke ref_list
    → Rust reads ~/.mim/references/library.json
      → CSL-JSON array → referenceLibrary ref

Citation Autocomplete:
  User types "[@" in CM6
    → citations.js autocomplete triggers
      → getReferences callback → referenceLibrary.value
        → fuzzy match → dropdown shown
          → select → inserts [@key] in document

CM6 citationExtensions → getReferences → referenceLibrary ref → Rust ref_list

BibTeX Import:
  SidebarRefs → paste BibTeX text → services/bibtexParser.js
    → parsed entries → services/references.js addReference()
      → Tauri invoke ref_add → Rust writes to library.json
        → reloadReferenceLibrary() → UI updates
```

References are global (`~/.mim/references/`), not project-scoped.

### 5. Export

```
PDF:
  SidebarExport → user selects template/settings → Export button
    → services/export/pdf.js → Tauri invoke export_pdf
      → Rust typst_export.rs:
        1. Convert markdown to Typst markup (pulldown-cmark)
        2. Wrap in template (clean/academic/report/letter/compact)
        3. Collect cited references → write .bib temp file
        4. Write .typ temp file
        5. Run typst CLI → PDF
      → Return PDF path → SidebarExport shows result

DOCX:
  SidebarExport → Export button
    → services/export/docx.js:
      1. Parse markdown with marked lexer
      2. Walk tokens → build docx.Document (paragraphs, runs, tables)
      3. Pack to Uint8Array
      4. Tauri invoke write_binary_file → Disk
    → SidebarExport shows result
```

### 6. Comments

```
Create:
  User selects text → context menu "Add Comment" (or Cmd+Shift+M)
    → App.vue onComment → selectPanel('notes')
    → SidebarNotes shows new comment input

Persist:
  App.vue onComment → builds <comment> tag, dispatches CM6 transaction
    → tag is inline in the document, saved with the file

CM6 commentTagField parses tags on every doc change → useCommentsStore (reactive mirror)

Bidirectional Scroll:
  Sidebar click → App.vue onSelectComment → editorSurfaceRef.scrollToPos(from)
  Gutter click → commentsExtension onCommentClick → sidebar highlights active
```

### 7. Version History

```
View:
  User opens History sidebar panel
    → SidebarHistory.vue mounts
      → Tauri invoke git_file_log(path)
        → Rust git.rs reads git log for file
          → array of { hash, date, message } → timeline UI ("Current" marker on HEAD)

Diff:
  User clicks a historical version
    → useDiffStore().activate({ original: historicalContent, modified: currentContent, review: { type: 'history' } })
      → DiffBar shows "Restore" / "Close" (not "Accept All" / "Reject All")
        → Restore: applies historical content to editor
        → Close: dismisses diff view

Content retrieval:
  → Tauri invoke git_file_at_revision(path, hash)
    → Rust git.rs reads blob at revision → file content string
```

Relies on user-managed git. mim terminal does not create commits.

### 8. Board File Editing

```
Open board file:
  fileSystem.readFile() → useFileStore.openFile()
    → path.includes('/board/') detected
      → parseBoardEntry(content) splits YAML frontmatter from body
        → file.meta = parsed YAML metadata (title, status, priority, etc.)
        → file.content = markdown body only (frontmatter stripped)
          → IssueContextBar renders above EditorSurface (when file.meta exists)
            → editable title, status dropdown, priority dropdown, "Send to Agent"

Edit metadata:
  IssueContextBar → fileStore.updateMeta(fileId, { status: 'review' })
    → Object.assign(file.meta, updates, { updated: new Date().toISOString() })
    → markFileDirty()

Save:
  writeFile(file) detects file.meta
    → serializeEntry(meta, body) → "---\nyaml\n---\n\nbody"
      → saveFile(path, fullContent) → disk
    → emit('mim://board-changed', { entryId })
      → Panel board store reloads kanban

Send to Agent:
  IssueContextBar "Send to Agent" → useSubmitReview.submitReview()
    → injects comments inline → Tauri invoke comments_submit
      → Panel receives payload in chat
    → Tauri invoke focus_main_window
```

### 9. Spellcheck

```
Enable:
  Settings → Writing → Spellcheck toggle
    → useSettingsStore().set('editorSpellCheck', true)
      → EditorSurface watches setting
        → reconfigures spellcheckCompartment in core.js
          → sets spellcheck="true" on .cm-content
      → Tauri: enable_macos_spellcheck() sets WebContinuousSpellCheckingEnabled
        → WKWebView renders red underlines (macOS only; no-op stubs on other platforms)

Context menu:
  User right-clicks misspelled word in CM6
    → EditorSurface @contextmenu.prevent → EditorContextMenu.vue
      → Tauri invoke spell_suggest(word) → Rust NSSpellChecker via objc2
        → up to 5 suggestions shown in menu
      → Also shows: cut/copy/paste/select-all
      → With selection: also shows "Add Comment" and "Ask AI"
```

## Conventions

- Services are async, return plain data, never import Vue reactivity.
- Composables wrap services in reactive state.
- CM6 extensions use Compartments for dynamic reconfiguration (settings, formatting).
- All sidebar panels follow consistent header/chip/row pattern from design-system.md.
- Editor feature modules export CodeMirror extensions/effects, not mutate app state directly.
- Feature modules communicate upward through callbacks/events/effects.
- Do not put AI/provider logic in editor extensions; call service wrappers from the app shell.
- Keep Markdown clean; do not write comments/AI/citation metadata into source Markdown.
- `useEditorUIStore` owns UI-only shell state. `useFileStore` owns file/content state. `useCommentsStore` owns comment state. `useSettingsStore` owns settings state. Do not merge them.

## What's Next

- Delete `src/styles.css` (last dead file).
- Replace the remaining browser fallback `localStorage` panel bridge with direct Tauri read events when the Panel no longer needs browser mode support.
- Implement HTML and LaTeX export backends.
