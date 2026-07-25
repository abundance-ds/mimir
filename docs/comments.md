# Comments System

Comments are spatial annotations stored as inline XML tags directly in markdown files. The sidebar shows height-aligned cards that scroll in sync with the editor. Comments are binary: they exist or they don't. There is no "resolved" state — when a comment is done, it is removed.

## Architecture

```
CommentCard.vue (5-mode state machine, self-managed)
  ↕ props/emits
SidebarNotes.vue (scroll-synced column, filter chips, autoEdit tracking)
  ↕ inject('commentMutations')
App.vue (CM6 extension wiring, mutation functions, comment creation)
  ↕ CM6 transactions + Pinia store (reactive mirror)
commentTagField (CM6 StateField, parses tags from doc) ←→ useCommentsStore (thin read-only mirror, no persistence)
```

Comments live in the document text as `<comment>` tags. The CM6 extension parses tags on every doc change, hides them with replace decorations, and shows the anchor text with highlight marks. Position tracking is implicit — tags move with the text because they are part of it. The Pinia store is a thin reactive mirror that receives parsed comment data from the CM6 state; it holds no persistence logic.

## Storage Format

Comments are inline XML in the markdown file:

```
Some text <comment id="c-..." author="user" text="Fix this" created="2025-...">annotated passage<reply id="r-..." author="ai" text="Done" ts="2025-..."/></comment> more text.
```

No external files, no `~/.mim/comments/` directory. The document is the single source of truth.

## Data Model

Parsed by `parseCommentTags()` in `src/services/comments/parser.js`:

```js
Comment {
  id,                          // 'c-{timestamp36}-{rand}'
  author,                      // 'user' | 'ai'
  text,                        // comment body (from tag attribute)
  created,                     // ISO timestamp
  replies: [Reply],
  tagFrom, tagTo,              // raw doc positions of full <comment>...</comment>
  contentFrom, contentTo,      // raw doc positions of visible anchor text
  anchorText,                  // the text between open tag and first <reply> or </comment>
}

Reply {
  id, author, text, ts
}
```

## Parser

`src/services/comments/parser.js` exports:

- `parseCommentTags(text)` — returns `{ comments, cleanText, offsetMap }`. `cleanText` is the document with all tag markup removed (anchor text preserved). `offsetMap` maps clean-text positions to raw-text positions.
- `stripCommentTags(text)` — removes all `<comment>` tags, keeping only anchor text (no replies). Used by export and clipboard.
- `buildCommentTag(comment)` — serialises a comment object back to an XML tag string.
- `cleanToRawPos(offsetMap, cleanPos)` — maps a position in clean text to the corresponding position in raw text (used by AI tools to find anchor text that may be adjacent to existing tags).
- `escapeAttr` / `unescapeAttr` — XML attribute escaping.

## Card State Machine

CommentCard self-manages its mode from `active` and `autoEdit` props plus internal `editing` ref:

```
mode = editing   → if editing ref is true
       expanded  → if active prop is true
       collapsed → default
```

| Mode | Header | Body | Replies | Reply input |
|------|--------|------|---------|-------------|
| collapsed | author + time + reply count (informational). Done ✓ on hover (`opacity-0 group-hover:opacity-100`). | 2-line clamp, ink-2 | no | no |
| expanded | author + time + Done ✓ (always visible) + ⋯ context menu (Edit only) | full body, ink | yes (each reply has hover ⋯ → Edit/Delete) | yes (always visible, auto-grow) |
| editing | textarea + Save/Cancel | — | — | — |

Transitions:
- Click collapsed card → expanded. Deactivating resets editing state.
- New comment (empty text + autoEdit) enters editing mode, textarea focused via retry loop.
- Escape/blur on empty draft deletes the comment.
- Click Done ✓ removes the comment. Undo toast (4s) with CM6 undo.
- Double-click body in expanded mode enters editing mode.
- Reply input always visible in expanded — no gating "Reply" button.

## CM6 Extension

`src/editor/codemirror/comments.js` uses a four-layer approach to hide inline comment tags while keeping the anchor text fully editable:

### Layer 1: StateField (`commentTagField`)

On create and every doc change, parses the full document via `parseCommentTags()`. Stores `{ comments, activeId }`. The `setActiveComment` effect controls which comment is highlighted.

### Layer 2: Decorations

- **Replace decorations** (`Decoration.replace({})`) hide open/close tag markup and reply elements — everything outside the `contentFrom..contentTo` range. Two separate replace ranges per comment: one for the opening tag, one for the closing tag + replies.
- **Mark decorations** highlight the visible anchor text with `.cm-comment-range` / `.cm-comment-range-active`.

### Layer 3: Atomic ranges (`EditorView.atomicRanges`)

Registers hidden tag ranges as atomic units. CM6's cursor movement (`moveByChar`, arrow keys, shift+arrow) skips over them seamlessly — the cursor jumps from visible text to visible text without stopping inside hidden markup.

### Layer 4: Edit protection (two primitives)

**`EditorState.changeFilter`** — the CM6-recommended primitive for readonly ranges (per Marijn Haverbeke, CM6 author). Returns an array of `[from, to, ...]` pairs where changes should be suppressed. Any edit touching a tag range is silently blocked. Programmatic mutations annotated with `commentMutation` bypass the filter.

**`keymap` handlers** (Backspace / Delete) — without these, backspace at a tag boundary would be blocked by `changeFilter` and do nothing (because `atomicRanges` targets the whole tag as a deletion unit). The handlers detect when the cursor is at a tag boundary and redirect:
- Backspace after closing tag → deletes last char of annotated text
- Backspace at start of annotated text → deletes char before the opening tag
- Delete before opening tag → deletes first char of annotated text
- Delete at end of annotated text → deletes char after the closing tag

### Other extensions

- **Empty-comment cleanup** (`transactionFilter`): after any edit, auto-removes comments whose anchor text has become empty (contentFrom === contentTo).
- **Clipboard handler**: copy/cut strips comment tags from clipboard content via `stripCommentTags`.
- **Click handler**: clicking inside a comment range activates it and fires `onCommentClick`.
- **Keyboard**: `Mod-Shift-m` creates a comment on the current selection.
- **Scroll plugin**: reports `{ scrollTop, scrollHeight, clientHeight }` to parent for sidebar sync.

### Known limitation

At each tag boundary there are two cursor positions that map to the same visual location (one before the hidden tag, one after it). This causes a single "dead" arrow-key press at each boundary. This is inherent to CM6's flat-string document model — the hidden tag text exists in the document even though it is invisible. ProseMirror's structured document model does not have this limitation, but the trade-off is not worth a framework migration.

## Comment Mutations

All mutations are CM6 transactions dispatched from functions in App.vue and provided to SidebarNotes via `inject('commentMutations')`:

| Mutation | What it does |
|----------|-------------|
| `addReply(commentId, text, author)` | Regex-finds the comment tag, inserts a `<reply>` element before `</comment>` |
| `delete(commentId)` | Dispatches a replace transaction that removes the entire tag, keeping anchor text |
| `updateText(commentId, newText)` | Rewrites the `text="..."` attribute in the open tag |
| `updateReply(commentId, replyId, newText)` | Rewrites the `text="..."` attribute on a `<reply>` tag |
| `deleteReply(commentId, replyId)` | Removes a `<reply ... />` tag from the document |
| `clearAll()` | Strips all comment tags from the document via `stripCommentTags`. Gated by inline confirmation bar ("Remove all? [Remove] [Cancel]"). |

All mutation dispatches include the `commentMutation` annotation, which bypasses both the `changeFilter` (tag protection) and the empty-comment cleanup filter. Undo works naturally.

## Comment Creation Flow

Three affordances: toolbar "Add Comment" button (disabled without selection), context menu "Add Comment" (visible only with selection), keyboard Cmd+Shift+M.

All route to `onComment()` in App.vue:
1. Get selection. No selection → no-op.
2. Dedup: `findActiveByRange(filePath, from, to)` — if active comment exists at exact range, activate it.
3. Check for overlap with existing comment tags.
4. Build open/close tag strings via `escapeAttr`, dispatch a CM6 transaction that wraps the selection.
5. `editorUI.openPanel('notes')` — always opens, never toggles.
6. SidebarNotes watcher detects new comment → sets `autoEditId`.
7. CommentCard's `autoEdit` watch → enters editing mode, focuses textarea.
8. User types, Cmd+Enter saves. Blur on empty draft deletes.

## Positioning

`useCommentPositions.js` implements Active-First Gravity:

1. For each comment, get document-relative Y via `view.lineBlockAt(contentFrom).top`.
2. Sort by Y. If an active comment exists, pin it to its ideal position.
3. Push predecessors upward, successors downward, with 12px gaps.
4. Clamp minimum position to 0.

Cards are absolutely positioned inside a container whose height matches `editorScrollInfo.scrollHeight`. The container is translated by `-scrollTop` to sync with editor scroll. Positions recalculate on: comment changes, active comment changes, card height changes (ResizeObserver), and editor geometry changes. NOT on scroll — `lineBlockAt` values are document-relative and stable.

## AI Tool Integration

`comment_add` and `comment_reply` tools operate on file content directly:

1. Reads document content — from the editor context for `@editor`, from disk via `read_text_file` for file paths.
2. For `add`: parses existing tags to get clean text + offset map, finds anchor in clean text, maps back to raw positions via `cleanToRawPos`, checks for overlap with existing comments, wraps the anchor with a `<comment>` tag built by `buildCommentTag`.
3. For `reply`: parses tags via `parseCommentTags`, finds comment by ID, inserts a `<reply>` element before `</comment>`.
4. Writes modified content back to disk, emits `mim://file-updated` — the Editor's file-update listener reloads the document.

`read("@editor", { show_comments: true })` returns the raw document with inline `<comment>` tags intact. Without `show_comments`, `stripCommentTags` removes them.

## Cross-Window Bridge

```
SidebarNotes → invoke('comments_submit', payload) → Rust → emit to Panel
Panel listener (persistence.js) → target session or findProjectByFilePath() → select/create chat → send
```

Send Review sends the annotated document content (with inline `<comment>` tags) to the Panel chat. The AI receives the document with comments in spatial context.

- Event constant: `COMMENTS_SUBMIT_EVENT` in `src/shared/proposalEvents.js`
- Rust command: `comments_submit` in `src-tauri/src/lib.rs`
- Project detection: `findProjectByFilePath()` in `src/stores/panel/projects.js`

## Export

DOCX export strips comment tags before generating the document: `stripCommentTags()` is called at the start of the markdown-to-DOCX pipeline (`src/services/export/docx.js`).

## First-Comment Gate

When a user adds the first comment to a file that has no existing comments, a confirmation dialog appears explaining that the file will be modified. The `commentGateSkip` setting (`src/stores/settings.js`) suppresses the dialog permanently via a "Don't show again" checkbox. The sidebar also exposes a "Remove all comments" button (eraser icon) that strips all tags from the file.

## Files

| File | Purpose |
|------|---------|
| `src/services/comments/parser.js` | Tag parser, strip, build, offset mapping |
| `src/stores/comments.js` | Pinia store: thin reactive mirror, active comment tracking, no persistence |
| `src/editor/codemirror/comments.js` | CM6 StateField, replace/mark decorations, atomicRanges, changeFilter, keymap handlers, clipboard handler, click handler, scroll plugin |
| `src/editor/composables/useCommentPositions.js` | Active-First Gravity layout, lineBlockAt, ResizeObserver |
| `src/editor/composables/useCommentMutations.js` | CM6 mutation functions: addReply, delete, updateText, updateReply, deleteReply, clearAll |
| `src/editor/components/sidebar/CommentCard.vue` | 3-mode card: collapsed/expanded/editing. Done ✓ hover-reveal, reply editing, auto-focus retry |
| `src/editor/components/sidebar/SidebarNotes.vue` | Scroll-synced column, autoEdit, undo toast, confirm-clear, target picker, Send to Agent |
| `src/services/ai/tools/commentAdd.js` | AI tool: add comment to file |
| `src/services/ai/tools/commentReply.js` | AI tool: reply to existing comment |
| `src/services/export/docx.js` | Strips tags before DOCX generation |
| `src/shared/styles/editor-content.css` | `.cm-comment-range` / `.cm-comment-range-active` decorations |
