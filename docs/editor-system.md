# Editor

The Editor is Mim's stable authoring and review surface. It stays mounted while
the selected Activity changes.

## Files and tabs

`src/editor/App.vue` orchestrates:

- Markdown and text tabs
- open, recent, new, save, save as, close confirmation, and autosave
- session restoration from `~/.mim/session.json`
- dirty/save/error feedback
- tab selection, ordering, and cross-window transfer
- configurable font, size, line width, wrapping, spellcheck, toolbar, and theme

`src/stores/files.js` owns open files and save state.
`src/editor/composables/useContentSync.js` keeps CodeMirror, the file store, and
the attached document bridge synchronized.

## CodeMirror surface

`src/editor/codemirror/core.js` creates the editor and reconfigurable
compartments. `formatting.js` implements Markdown formatting commands.
`livePreview.js` provides Typora-style in-editor rendering by hiding inactive
syntax markers and replacing images, tables, and rules with widgets. There is
no separate rendered preview pane.

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

## Agent bridge

`src/editor/App.vue` exposes methods used by the MCP relay:

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
- `src/editor/components/workspace/DiffView.vue`
- `src/editor/components/workspace/BatchDiffView.vue`
- `src/editor/components/workspace/InlineAI.vue`
- `src/editor/codemirror/`
- `src/editor/composables/`
- `src/stores/files.js`, `src/stores/diff.js`, `src/stores/comments.js`
