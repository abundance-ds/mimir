# Editor

The Editor is Mimir's stable authoring and review surface. It stays mounted while
the selected Activity changes.

## Files and tabs

`src/editor/App.vue` composes the visible surface and delegates stable
subsystems:

- Markdown and text tabs
- open, recent, new, save, save as, close confirmation, and autosave
- dirty/save/error feedback
- tab selection, ordering, and cross-window transfer
- configurable font, size, line width, wrapping, paper-style line numbers,
  spellcheck, Markdown toolbar, and theme

| Subsystem | Owner |
|---|---|
| startup restore, fallback draft, reactive persistence | `useEditorSessionLifecycle.js` |
| native menu/focus synchronization and application Quit | `useEditorNativeLifecycle.js` |
| proposal registration, native events, and review projection | `useEditorProposalLifecycle.js` |
| clean-buffer refresh after external workspace edits | `useExternalFileSync.js` |
| public Mimir/MCP editor inspection and mutation contract | `useEditorCommandApi.js` |
| tab close/reorder/new behavior | `useTabManagement.js` |
| CodeMirror/store/document synchronization | `useContentSync.js` |

These controllers own their timers, watchers, and native listener cleanup.
`App.vue` owns their ordering because hydration must finish before native
surfaces are installed.

`src/stores/files.js` owns open files and save state.
`src/editor/composables/useContentSync.js` keeps CodeMirror, the file store, and
the attached document bridge synchronized.

The Editor also consumes the debounced native workspace watcher. A changed
open text file is read by path and replaced only if its buffer is still clean
when that asynchronous read completes. Unchanged content is ignored and dirty
buffers retain ownership. CodeMirror applies accepted disk content as one
minimal changed range, preserving the surrounding editor state without a
polling loop or full-workspace reload.

Tabs are typed as `text`, `pdf`, or `external`. Files passes native
`WorkspaceEntry.openBehavior`; other `mimirOpen` callers are classified through
`workspace_file_inspect` before any read. Only text enters CodeMirror and the
UTF-8 read/save path. `FilePreviewPage.vue` owns non-text routing;
`PdfPreview.vue` dynamically loads PDF.js, reads bytes through
`read_binary_file`, caps render pixel ratio, and cancels/destroys stale render
tasks on path change or unmount.

Files single-click creates a clean preview tab. `stores/files.js` reuses the
first clean preview for later preview opens; a pinned open or text mutation
clears preview status. Resource previews cannot become dirty or save, and do
not mount inline AI, formatting, the footer, or CodeMirror. Preserve
`kind`/`preview`/`meta` in tab transfer paths; session restoration currently
excludes non-text tabs entirely, so resource previews never enter the startup
UTF-8 hydration path.

Session hydration is one transaction shared by the embedded and standalone
Editor. It completes before the fallback draft, persistence watcher, file-open
queue, native-menu sync, quit guard, and public bridge listeners are installed.
Missing dirty named files recover as drafts; missing clean files disappear.
See [persistence.md](persistence.md) and
[runtime-architecture.md](runtime-architecture.md).

## CodeMirror surface

`src/editor/codemirror/core.js` creates the editor and reconfigurable
compartments. `formatting.js` implements Markdown formatting commands.
`livePreview.js` provides Typora-style in-editor rendering by hiding inactive
syntax markers and replacing images, tables, and rules with widgets. There is
no separate rendered preview pane.

Line numbers are an optional compartment. Their gutter shares the editor paper
instead of adding a separate slab or divider. The current line uses a quiet,
theme-aware fill on its number cell; with line numbers hidden, the same fill
moves to the editor row. It never uses a colored edge or stripe.
`EditorToolbar.vue` is mounted only for Markdown/draft documents when enabled;
`mousedown.prevent` keeps the selection owned by CodeMirror while a formatting
command runs.

The active document remains plain Markdown on disk.

## Review flow

Substantial MCP file edits become proposals:

```text
tool call
  -> renderer tool handler
  -> proposal registered in Rust
  -> existing Editor tab opens or activates
  -> full-document diff
  -> accept or reject
```

`src/stores/diff.js`, `src/editor/composables/useProposalBridge.js`, and
`useDiffReview.js` own single- and multi-file review. Inline AI uses the same
diff surface. The Editor never silently applies a proposed replacement.

The native coordinator in `src-tauri/src/lib.rs` owns proposal lifecycle across
callers/windows, while the renderer owns presentation and dirty buffers.
Editors register path/dirty/active snapshots so Rust can delegate an apply to
the correct in-memory owner instead of overwriting disk. Accept/reject is not
complete until `proposal_respond` succeeds; failure leaves the diff open.

## Agent bridge

`useEditorCommandApi.js` defines the methods exposed by `src/editor/App.vue`
and used by the MCP relay:

- open, list tabs, inspect active tab/content/selection/comments
- replace selection or full content
- reveal path/line/offset
- save
- display a proposal for review
- resolve, reopen, or delete a comment

The public tool definitions and aliases are documented in [mcp.md](mcp.md).

## Inline intelligence

- Cmd/Ctrl+K opens the inline agent at the selection or cursor.
- `++` requests ghost completions at the cursor.
- API keys and model choices live in Settings > Models.

See [inline-ai.md](inline-ai.md).

## Comments

Review discussions are inline CodeMirror block widgets backed by pseudo-XML
stored in the Markdown itself. See [comments.md](comments.md).

## Relevant code

- `src/editor/App.vue`
- `src/editor/components/workspace/EditorSurface.vue`
- `src/editor/components/workspace/FilePreviewPage.vue`
- `src/editor/components/workspace/PdfPreview.vue`
- `src/editor/components/workspace/DiffView.vue`
- `src/editor/components/workspace/BatchDiffView.vue`
- `src/editor/components/workspace/InlineAI.vue`
- `src/editor/codemirror/`
- `src/editor/composables/`
- `src/stores/files.js`, `src/stores/diff.js`, `src/stores/comments.js`
- `src/services/fileSystem.js`, `src/services/workspaceFileOperations.js`

Primary cross-cutting tests are session restore/persist, window close/app Quit,
tab/preview management, proposal bridge/diff review, Editor settings, and the
relevant stores. See [files.md](files.md) for the open-classification boundary
and [testing.md](testing.md) for change routing.
