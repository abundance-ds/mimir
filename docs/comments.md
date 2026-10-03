# Comments

Comments are review threads stored directly in Markdown as protected pseudo-XML:

```xml
<comment id="a1" author="user" text="Clarify." status="active" created="...">anchor<reply id="b2" author="agent" text="Done." ts="..."/></comment>
```

- Text inside the wrapper is the exact anchor. Status is `active` or `resolved`.
- Anchor insertion skips Markdown block markers so it does not break headings,
  lists, tasks, or quotes. Marker-only selections are invalid.
- Parser, escaping, and raw/clean offset mapping live in
  `src/services/comments/parser.js`.
- CodeMirror hides tags and renders the thread after its anchor. Resolve keeps
  the stored thread; delete unwraps it and preserves anchor text.
- Table preview removes comment and reply tags before rendering cells. Anchor
  text keeps its Markdown formatting and links. The stored source is unchanged.
- Minimized state and resolved-thread visibility are renderer state, not
  Markdown.
- Discussion block widgets must have no vertical margins. CodeMirror measures
  their border boxes; external spacing makes cursor and mouse line positions
  drift with each discussion. Use internal padding for spacing.
- Deliberate changes carry `commentMutation`. Hidden syntax uses replacement
  decorations, atomic ranges, change filters, and boundary key handlers.
- Public comment tools use this same representation; the definitive public
  names and document-target contract are in
  [agent-interface.md](agent-interface.md#document-targets-and-comments).

Renderer ownership: comments service/store, comment composables, and
`src/editor/codemirror/comments.js`. Agent document access: `useDocumentTools.js`.
Text transformations: `services/comments/mutations.js`. FileStore owns open-buffer
edits and coordinates file opens with pending disk tool writes;
`document_files.rs` owns closed-document reads and writes.

A native macOS check of comments in one file while another is selected remains
required; see [Editor verification](editor-system.md#verification).

## Discussions in a review

Unified, Split, Original, and Result show prose without stored comment tags.
A comment button beside a passage opens the discussion in the Comments area
below the diff. Select text and choose **Add comment**, or use Cmd/Ctrl+Shift+M.
Both split panes share one discussion list. **Show resolved** includes resolved
threads. Git and Scratchpad history use read-only discussions.

Proposed discussion additions, removals, moves, and other changes have separate
Accept and Reject buttons. They count as pending changes even when the prose
is identical. Accepting one text change does not decide a comment change.
Accept all and Reject all decide the remaining text and comment changes.

New comments, replies, and resolve actions are kept when review decisions are
undone or redone. Undo inside a reply input edits that input. Drafts, the open
discussion, and decisions survive view and tab changes. Automatic completion
waits for a nonempty draft to be posted or cleared. Later proposals wait behind
an unfinished review of the same file.

If an anchor is removed, rejected, or cannot be mapped with confidence, the
discussion keeps its original quotation and a visible label. It is not attached
to a guessed occurrence. On completion, an unattached thread uses an empty
wrapper with `detached` and `quote` attributes. Its `padding="2"` separator keeps
it outside the last Markdown block; the parser removes only this owned
separator from clean prose. The normal Editor keeps and displays these threads
after save and reopen. Text-only edits retain existing tag spelling.

`reviewSession.js` and `reviewComments.js` hold prose and discussions separately.
`reviewPersistence.js` serializes checked saves to `~/.mimir/document-reviews/`,
with one record per file path or draft. Records include decisions, discussions,
and input drafts. Rename moves the record. Failed saves keep local changes and
show **Retry save**. Conflicting writes stop; a new review cannot replace an
unfinished saved review.

Completion saves the document draft for restart recovery before it closes the
review record. Normal Save, autosave, and Don't Save rules still apply. Posting
discussions and applying prose produce separate document Undo steps. Completed
records do not restore discarded text. Direct native acceptance stops when a
saved review owns the file; finish that review in Editor.

Tests cover the real Editor across workspaces, both diff layouts, comment-only
changes, multiline anchors, replies with links, draft input, Undo, checked
writes, failed saves, and record reload. Native replacement tests cover comment
boundaries and Unicode offsets. Visual macOS and actual restart checks remain
open; no browser or native app surface was available for this implementation.

## Table discussions

In Live Preview, commented cells show a thread-count button. The discussion list
below the table groups threads in document order. A cell can hold multiple
independent threads. Counts refer to active threads, not replies. Source mode
restores inline discussion blocks; preview renders each discussion only once.

Comment actions work without moving the text selection into the table. Column
resizing and comment selection retain a pending reply draft.

`tableComments.js` owns markers, anchor mapping, and the discussion list.
`comments.js` supplies the shared thread renderer. `livePreview.js` owns the
table block and tells the comment renderer which threads it contains. Open lists
and reply drafts are renderer state; they do not change Markdown. Table blocks
use internal spacing, not vertical margins, for correct editor line measurements.

`tableComments.test.js` covers the cases. `harness/table-comments.html` mounts
the real editor for browser checks. Installed macOS verification remains required.
