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
| debounced document context bridge (localStorage + Tauri IPC) | `useDocumentBridge.js` |

These controllers own their timers, watchers, and native listener cleanup.
`App.vue` owns their ordering because hydration must finish before native
surfaces are installed.

`src/stores/files.js` owns open files and save state.
`src/editor/composables/useContentSync.js` keeps CodeMirror, the file store, and
the attached document bridge synchronized.

In the embedded Workbench, named tabs opened inside a retained project record
that project as their owner. The tab strip projects the active project plus
global files and untitled drafts. Switching projects hides other project tabs;
it never closes them or discards their dirty buffers, previews, or review
state. Returning restores the workspace's last active available tab. Directly
opened files outside every retained project and untitled drafts remain global.
Nested retained projects own their files over a retained parent project.
The standalone Editor has no workspace filter and shows the complete tab set.
The Workbench flushes the current CodeMirror snapshot before it changes the
workspace projection, so a pending content-sync debounce cannot write the old
document into the arriving tab.

External file sync: the debounced workspace watcher replaces a changed open
file only if its buffer is clean when the async read completes. Dirty buffers
retain ownership. CodeMirror applies disk content as one minimal changed range.

Tabs are typed `text`, `pdf`, or `external` (classified via
`workspace_file_inspect`). Only text enters CodeMirror / UTF-8 read/save.
`FilePreviewPage.vue` owns non-text routing; `PdfPreview.vue` loads PDF.js
dynamically. Preview tabs: single-click opens clean preview; pinned open or
mutation clears preview. Preserve `kind`/`preview`/`meta` in tab transfer;
session restore excludes non-text tabs.

Tab widths adapt within a bounded range before the strip scrolls. A shortened
label keeps more of the start and a short identifying end, including the file
extension. Hover or keyboard focus shows the full name and parent directory.

Session hydration is one transaction shared by the embedded and standalone
Editor. It completes before the fallback draft, persistence watcher, file-open
queue, native-menu sync, quit guard, and public bridge listeners are installed.
Missing dirty named files recover as drafts; missing clean files disappear.
Named session entries retain their optional project owner so the same tab
projection survives an application restart.
See [persistence.md](persistence.md) and
[runtime-architecture.md](runtime-architecture.md).

## CodeMirror surface

`src/editor/codemirror/core.js` creates the editor and reconfigurable
compartments. `formatting.js` implements Markdown formatting commands.
`livePreview.js` provides Typora-style in-editor rendering by hiding inactive
syntax markers and replacing images, tables, and rules with widgets. There is
no separate rendered preview pane.

The default authoring face is bundled Commit Mono. Editor and diff surfaces
share a 1.35 line-height ratio and use weight 450 on light themes or 400 on dark
themes. The editor paper has 16px top and side padding. Normal and Wide line
widths cap content at 100ch and 120ch; Off follows the viewport. Markdown
headings stay within a compact 1.30/1.15/1.05 scale so they do not break the
editing rhythm. H1 uses explicit leading so its larger glyph box cannot crowd
the next row.

`EditorSurface.vue` asks CodeMirror to measure again after Commit Mono loads and
after a font, size, theme weight, or zoom change. Font loading does not block the
surface, and a completed load cannot measure a destroyed editor.

Line numbers are an optional compartment. Their gutter shares the editor paper
instead of adding a separate slab or divider. The current line always uses a
quiet, theme-aware row fill; when line numbers are visible, its number cell uses
the same fill and stronger ink. It never uses a colored edge or stripe.
`EditorToolbar.vue` is mounted only for Markdown/draft documents when enabled;
`mousedown.prevent` keeps the selection owned by CodeMirror while a formatting
command runs.

`markdownLists.js` rebinds Enter above the keymap `markdown()` installs, so
list continuation is always tight: Enter on an empty item leaves the list
instead of loosening it, and continuing an item in an already-loose list drops
the blank line CodeMirror would repeat. The command declines outside Markdown,
which is what lets it sit in the shared `core.js` keymap; the workbench
Markdown editors (`TodayApp.vue`, `GraphMarkdownEditor.vue`) build their own
CodeMirror states and each add the same extension.

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
A single-file review records the exact Editor file id. A project switch or tab
switch hides the review but keeps it active. The review can apply only after
its exact target tab becomes active again.

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
