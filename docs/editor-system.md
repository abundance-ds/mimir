# Editor

The Editor stays mounted while Activities change. `src/editor/App.vue` composes
the surface; composables own lifecycle, synchronization, proposals, commands,
and cleanup. `src/stores/files.js` owns open files and save state.

## Files and tabs

[Scratchpad](scratchpad.md) is a global Editor tab with its own saved-text history.

- Tabs are `text`, `graph`, `pdf`, or `external`. Graph entries use Details and
  Source in one tab; [business-graph.md](business-graph.md#product-surface) owns
  their draft, source, and link rules. Inspect files before opening; only text
  enters CodeMirror.
- A single click opens a clean preview; editing or pinning makes it persistent.
- Project tabs are hidden, not closed, when the workspace changes. Dirty state
  and reviews remain attached to their stable file id.
- Files outside retained projects and untitled drafts are global. The
  standalone Editor shows all tabs.
- External changes replace only clean buffers. Missing dirty files recover as
  drafts; missing clean files disappear. Graph drafts retain their source identity.
- Named `.html` and `.htm` tabs show an **Open in browser** action in the Editor
  header. The action saves dirty content before it opens the file with the
  operating system's default browser.
- Session hydration completes before fallback draft creation, persistence,
  native listeners, file-open draining, and Quit guards.
- Save, rename, move, and Trash must settle pending Editor writes before paths
  or ownership change.
- Source-location requests place the cursor at the target and scroll it into view.
  Ordinary scroll requests retain the selection.
- SVG previews use the current buffer; source-location requests select Source.
- External SVG opening saves pending edits first.
- Preview refresh follows workspace changes and window focus; dirty SVG buffers win.
- Image view state is tab-local; binary tabs do not persist across restarts.
- Image reads stop at 64 MiB; the 100-million-pixel check runs after decoding.

## CodeMirror surface

`src/editor/codemirror/` owns formatting, live Markdown preview, comments, and
ghost completion. `editorHighlightStyle` in `core.js` covers every Markdown
scope: markers take the quiet marker ink, heading marks take the theme heading
colour, fenced code takes the nested language for its info string and a
full-width wash from `markdownCodeBlocks.js`. The file store is the durable renderer state; CodeMirror is
the active document projection. Toolbar pointer actions preserve focus and
selection.

### Document model

A tab displays one open document. A document owns its id, current text, saved
text, and save queue. CodeMirror retains its undo history, selection, and scroll
position under that id. A rename or tab switch keeps the document. Replacing
a preview reuses only its tab position and creates a new document and id.

Each editor transaction sends the loaded document's id and text to FileStore
before the transaction returns. The store is the authority for reads, saves,
proposals, and session snapshots. Selection does not determine an edit's target.
An event from a closed document is ignored. No save or tab switch needs to copy
pending text from the active view.

`useContentSync` only reads stored text and publishes it through the document
bridge. Publication, statistics, session writes, and autosave can be delayed;
draft updates cannot. Autosave has one timer per document and pauses during
close confirmation.

For text documents, `savedContent` records the last successful save or disk
load. Undo back to that text clears the changed flag. Pending writes keep the
document changed until their result is known. A restored draft with no readable
saved version keeps an unknown baseline and remains changed.

Store-to-editor updates have an explicit origin. A reload does not add an undo
step. An accepted edit adds a separate undo step. These updates project the
stored text exactly and do not pass through typing filters. CodeMirror uses
logical newlines internally; emitted edits use the document's line ending.
Opening or reading a document does not rewrite its text.

`App.documents.test.js` checks these rules with the real editor and file store,
including preview replacement, typing during a pending file read, separate
autosaves, Undo/Redo, reloads, saved text, close decisions, and session snapshots.

Bun applies `patches/style-mod@4.1.3.patch` to both package exports. CodeMirror
mounts reuse unchanged stylesheet text instead of replacing its text node and
invalidating styles across the document. New rules and changed rule order still
update normally. The editor style tests cover both exports and repeated Graph
mounts. Remove the patch when the dependency provides the same behavior.

## Proposal and Git review

- Rust owns proposal lifecycle; the renderer owns presentation and dirty
  buffers. Accept or reject is complete only after `proposal_respond` succeeds.
- Text actions require Source for Graph entries. Source-location requests and
  proposal-open actions save Details before changing views; failures keep the
  draft. Review decisions cannot change an unseen rich draft.
- Pending proposals survive restart. A source mismatch keeps the review open
  for recheck or explicit discard.
- Single-file review is bound to a stable file id, not a visible tab index.
- Git review uses a separate store and read-only virtual tab. It never accepts,
  rejects, or clears a proposal.
- Stage and unstage verify the loaded native snapshot. Stage is unavailable
  while the matching Editor buffer has unsaved text.
- Restoring file History writes a new working change; it does not rewrite Git
  history.

## Agent, AI, and comments

The Editor command bridge can inspect tabs, content, selection, and comments;
open or reveal a location; replace content; save; and present a proposal. The
public projection is defined in [agent-interface.md](agent-interface.md).

Cmd/Ctrl+K and ghost completion are described in [inline-ai.md](inline-ai.md).
Comments are pseudo-XML stored in Markdown and rendered as protected block
widgets; see [comments.md](comments.md). File classification and managed
Project Git are in [files.md](files.md).
