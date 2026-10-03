# Editor

The Editor stays mounted while Activities change. `src/editor/App.vue` composes
the surface; composables own lifecycle, synchronization, proposals, commands,
and cleanup. `src/stores/files.js` owns open files and save state.

## Files and tabs

[Scratchpad](scratchpad.md) is a global Editor tab with its own saved-text history.

- Tab kinds: `text`, `graph`, `pdf`, `external`. Graph rules are in
  [business-graph.md](business-graph.md#product-surface). Only text enters
  CodeMirror; inspect files before opening.
- A single click opens a clean preview; editing or pinning makes it persistent.
- Text and Graph opens share a navigation generation (`navigationGuard.js`). A
  newer open, tab change, workspace change, or unmount cancels older requests.
- Project tabs are hidden, not closed, when the workspace changes. Dirty state
  and reviews remain attached to their stable file id.
- Files outside retained projects and untitled drafts are global. The
  standalone Editor shows all tabs.
- External changes replace only clean buffers. Missing dirty files recover as
  drafts; missing clean files disappear. Graph drafts retain their source identity.
- `.html`/`.htm` tabs show **Open in browser**; it saves dirty content first.
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
scope; `markdownCodeBlocks.js` adds fenced-code highlighting. The file store is
the durable renderer state; CodeMirror is the active document projection.
Toolbar pointer actions preserve focus and selection.

Live Preview hides block quote `>` markers (and one following space/tab) on
lines without a cursor or selection. Nested quotes use one border per line.

Live Preview renders inline Markdown in table cells. Table links carry their
destination because a block widget cannot map cells through editor coordinates.
Authored HTML stays text. Empty header and body cells keep column positions,
including alignment; the syntax tree omits them, so preview maps nodes through
the complete row.

Column resizing transfers width between adjacent columns. Minimum 64 px where
space permits; pane fit takes priority. Widths live in CodeMirror document state,
not in Markdown or settings; changing column count or replacing a table clears
them. Other embedded Markdown editors keep their own controls.
`tableResize.js` owns pointer and keyboard controls; `livePreview.js` owns
width state and table rendering.

### Spelling and automatic text input

**Settings → Editor → Spell check** controls Mimir-drawn spelling underlines and
its correction menu in the main Editor, Scratchpad, Graph Markdown, Today, and
Scribe Markdown. Right-click a word or press Shift+F10 at the text cursor to
open the menu. Arrow keys select an action; Escape closes it. A chosen correction
is one ordinary undoable edit. Moving the cursor does not request suggestions.

Native WebKit spellchecking is disabled. Its spelling markers can open a native
suggestion panel even when HTML autocorrect is off. Mimir instead asks macOS
`NSSpellChecker` for spelling ranges through `spell_check`; it does not request
correction, replacement, or popup UI. The existing `spell_suggest` command owns
explicit menu suggestions. Native checking uses the user's preferred spelling
languages, returns UTF-16 offsets, and runs asynchronously through AppKit.

`src/editor/codemirror/spelling.js` owns the shared decoration extension. It
checks visible prose in bounded chunks after a typing pause, excludes Markdown
code, URLs, and hidden tags, caches repeated text, and ignores results after
an edit, document switch, settings change, or unmount. Checks wait for input
composition. Source-code documents and read-only views are not checked.

`src/shared/textInputPolicy.js` disables native spellcheck, autocorrect,
autocapitalization, browser autocomplete, and writing suggestions on all text
controls. Workbench and standalone Editor install it before mounting; the
local-app HTML bridge installs the same policy in each app document. It covers
library-created fields and fields added or changed later. Native startup also
disables automatic spelling correction, text replacement, and dash substitution
for Mimir. The explicit Smart quotes choice above remains independent. macOS
settings for other applications are unchanged.

`harness/spelling.html` uses a fixed spelling provider for repeatable visual and
menu checks. It cannot establish native spelling-service or popup behavior.
Renderer tests cover Unicode offsets, exclusions, bounded requests, stale
results, composition, undo, menu corrections, and dynamically created fields.
Before release, check the rebuilt macOS app with Spell check enabled: misspelled
words stay underlined, cursor movement shows no popup, the custom menu corrects
the selected word, Undo restores it, and settings changes update every editor.
Repeat after a tab switch, rapid typing, and with mixed-language prose.

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

Store-to-editor updates have an explicit origin. Reloads add no undo step;
accepted edits add a separate one. Updates project stored text exactly, bypassing
typing filters. CodeMirror uses logical newlines; CRLF is two characters on disk
but one editor position. Selection and change offsets refer to editor text, not
the stored string. Range edits and previews use CodeMirror change operations
before serialization. Emitted edits use the first detected line ending; mixed
endings stay on open and normalize to it on edit. Opening does not rewrite text. Diff views
compare logical lines. Single-file reviews serialize with the review's ending.

`patches/style-mod@4.1.3.patch` (both package exports) makes CodeMirror mounts
reuse unchanged stylesheet text instead of replacing the text node. Remove when the dependency
provides the same behavior.

## Verification

`App.documents.test.js` uses the real editor and file store with mocked disk
I/O. `merge.test.js` and `DiffView.test.js` cover diff content in both layouts.
Run these when document identity, draft updates, history, or save timing changes.
Also run affected store and composable tests, the production build, and
`bun run test:scratchpad`. Do not replace these tests with separate editor and
store mocks; the regression crossed their boundary.

Native verification: use disposable LF and CRLF files in the current macOS
build. Test preview opens, pin-and-edit, tab and project switches, Undo/Redo,
close prompts, autosave after Don't Save, draft recovery across restart.
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
  [Comments](comments.md#discussions-in-a-review) owns clean diff text,
  separate discussion decisions, saved review records, and input drafts.
- Pending-change buttons: 12 px icons, accessible names, keyboard activation.
  Split uses a 30 px center strip. Unified floats a compact pair with local text
  clearance. Green/red stay subtle until hover; keyboard focus stays visible.
- Bulk actions (Accept all / Reject all) affect only remaining changes. Earlier
  decisions stay intact.
- The final decision automatically applies and reports the result. There is
  no extra confirmation step. Cmd/Ctrl+Enter accepts the remaining changes.
  Batch completion requires decisions for all files. Undo/Redo remains available
  while reviewing; applied document text uses the normal document Undo history.
  A result equal to the original is rejected;
  a mixed result applies only the retained edits. Status retries cannot reapply
  text or undo a file already applied or reported.
- Single-file acceptance checks the draft against the review snapshot, then
  commits the result before reporting. Rejection keeps the current draft. Status
  replies never write document text.
  A failed report offers Retry; retry reports only unfinished proposal ids and
  never reapplies text. The result is read-only once decided; document edits
  made during the report remain intact. A completed report
  clears only the proposals it owns.
- Text actions require Source for Graph entries. Source-location requests and
  proposal-open actions save Details first; failures keep the draft. Review
  decisions cannot change an unseen rich draft.
- Pending proposals, decisions, and discussions survive restart. A source
  mismatch keeps the review open
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
