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
- Text and Graph open commands share a navigation generation. A newer open, tab change,
  workspace change, or unmount cancels older requests before they can select a
  file, replace a preview, move the cursor, or restore focus.
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

Smart quotes default off.

`src/editor/codemirror/` owns formatting, live Markdown preview, comments, and
ghost completion. `editorHighlightStyle` in `core.js` covers every Markdown
scope: markers take the quiet marker ink, heading marks take the theme heading
colour, fenced code takes the nested language for its info string and a
full-width wash from `markdownCodeBlocks.js`. The file store is the durable renderer state; CodeMirror is
the active document projection. Toolbar pointer actions preserve focus and
selection.

Live Preview shows block quote markers on each line that contains a cursor or
selection. Other quote lines keep their preview border. Nested quotes use one
border per line. Hidden markers include only `>` and an optional following
space or tab; text and line breaks stay visible.

Live Preview renders inline Markdown in table headers and cells. File and web
links use the Editor's open actions and retain the cursor position. Table links
carry their destination because a block widget cannot map each cell through
editor coordinates. Authored HTML stays text. Moving the cursor into a table
shows its Markdown source. Empty header and body cells keep their column
positions, including alignment; the Markdown syntax tree omits these cells,
so preview maps its nodes through the complete row before rendering.

Markdown file previews in the Editor support column resizing. Drag a header's
internal divider, or focus its handle and use Left/Right (8 px; Shift: 32 px).
The divider transfers width between adjacent columns. The table fills the pane;
column proportions follow pane width and cell text wraps. Resizing keeps a
64 px minimum where space permits; fitting the pane takes priority.
**Reset column widths** restores automatic layout. Escape cancels a drag.

Widths live in CodeMirror document state, not in the Markdown or saved settings.
They survive tab switches, Live Preview toggles, and cell text edits. Changing
column count or replacing a table clears its widths. Closing the document or
restarting discards them. Other embedded Markdown editors keep their existing
controls. `tableResize.js` owns pointer and keyboard controls; `livePreview.js`
owns width state and table rendering.

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
logical newlines internally. Selection and change offsets refer to that text,
not to the stored string: CRLF takes two characters on disk but one editor
position. Range edits and previews use CodeMirror's change operations before
serialization. Emitted edits use the first detected line ending; mixed endings
are retained on open and normalized to that ending on edit. Opening or reading
a document does not rewrite its text. Diff views compare logical lines.
Single-file reviews serialize resolved text with the review's line ending.

Bun applies `patches/style-mod@4.1.3.patch` to both package exports. CodeMirror
mounts reuse unchanged stylesheet text instead of replacing its text node and
invalidating styles across the document. New rules and changed rule order still
update normally. The editor style tests cover both exports and repeated Graph
mounts. Remove the patch when the dependency provides the same behavior.

## Verification

`App.documents.test.js` uses the real editor and file store with mocked disk
I/O. It covers preview replacement, per-document Undo/Redo, typing during a
pending file read, separate autosaves, saved text, session snapshots, and
reloads. Close tests cover Cancel, discard, failed save, and retry. Line-ending
tests cover opening, editing, Undo, saving, command replacement, and inline AI
selection and preview. `merge.test.js` and `DiffView.test.js` cover diff content,
line endings, and completion in unified and split views.
File-open tests complete reads in reverse order and cancel pending work during
navigation. Real review views test mixed decisions across layouts and previews,
tab changes, remaining-change actions, Undo/Redo, and explicit completion.
Proposal tests delay and
fail status replies, edit during the wait, retry after tab changes, and retain
newer reviews.

Run these tests when document identity, draft updates, history, or save timing
changes. Also run the affected store and composable tests, the production build,
and `bun run test:scratchpad`. Do not replace these tests with separate editor
and store mocks; the regression crossed their boundary.

Before closing native verification, use disposable LF and CRLF files in the
current macOS build. Open previews from the Files sidebar, pin and edit two
files, switch tabs and projects, and use Cmd+Z and Shift+Cmd+Z in each file.
Check that an untouched file closes without a prompt, Cancel retains edits,
and Don't Save causes no later autosave. Save and reopen the files, then restart
with one unsaved draft and check its recovery. Record the build and results.
Renderer tests do not prove macOS key routing, native dialogs, or restart.
This native check remains open in [issues.md](issues.md).

## Proposal and Git review

- Rust owns proposal lifecycle; the renderer owns presentation and dirty
  buffers. Accept or reject is complete only after `proposal_respond` succeeds.
- `reviewSession.js` owns each review's immutable original and proposal, working
  comparison baseline, result, and decision history. Accept advances the working
  baseline; reject changes the result. Both are retained outside CodeMirror.
  `reviewView.js` projects this state and retains reading position when a view
  is replaced. Unified, Split, Original, Result, and file-tab changes preserve
  decisions and Undo/Redo during the session. Original always shows the initial
  snapshot; Result shows the current review result.
- Each pending change has visible check and cross buttons with 28 px targets,
  accessible names, and keyboard activation. Unified reserves a right margin;
  Split uses the center column. The View selector combines the four views.
  The header names remaining work and wraps when the pane is narrow.
- File actions and All files menus accept or reject only remaining changes.
  Earlier decisions stay intact. Bulk decisions are one Undo step. The last
  decision leaves the review open. **Finish review** (Cmd/Ctrl+Enter) applies
  and reports the result only after every change is decided. Batch completion
  requires decisions for all files. A result equal to the original is rejected;
  a mixed result applies only the retained edits. Status retries cannot reapply
  text or undo a file already applied or reported.
- Single-file acceptance checks the current draft against the review snapshot,
  then commits the result before reporting it. Rejection keeps the current
  draft. Status replies never write document text. A failed report retains the
  decision on its document and offers Retry status, including after a tab switch.
  Retry reports only unfinished proposal ids and never reapplies the text.
  The review result is read-only once decided; document edits made during the
  report remain intact. A completed report clears only the proposals it owns.
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
