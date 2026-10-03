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

- Unified, Split, Original, and Result show prose without stored comment tags.
  Both split panes share one discussion list. Git and Scratchpad history use
  read-only discussions.
- Proposed discussion additions, removals, moves, and edits have their own
  Accept and Reject. They count as pending changes even when the prose is
  identical. A text decision does not decide a comment change; Accept all and
  Reject all decide both.
- New comments, replies, and resolve actions survive Undo and Redo of review
  decisions. Undo inside a reply input edits that input. Drafts, the open
  discussion, and decisions survive view and tab changes.
- Automatic completion waits until a nonempty draft is posted or cleared. Later
  proposals wait behind an unfinished review of the same file.
- An anchor that is removed, rejected, or not mappable with confidence is never
  attached to a guessed occurrence. The thread keeps its quotation and a
  visible label. On completion it becomes an empty wrapper with `detached` and
  `quote` attributes. Its `padding="2"` separator keeps it outside the last
  Markdown block; the parser removes only this owned separator from clean
  prose. Text-only edits retain existing tag spelling.
- `reviewSession.js` and `reviewComments.js` hold prose and discussions
  separately. `reviewPersistence.js` serializes revision-checked saves
  (`document_review_save`) to `~/.mimir/document-reviews/`: one record per file
  path or draft, with decisions, discussions, and input drafts. A rename moves
  the record and leaves a completed tombstone at the old key. A failed save
  keeps local changes and offers **Retry save**. A conflicting write stops; a
  new review cannot replace an unfinished saved review.
- Completion saves the document draft for restart recovery before it closes
  the review record. Normal Save, autosave, and Don't Save rules apply. Posting
  discussions and applying prose are separate document Undo steps. Completed
  records do not restore discarded text.
- Direct native acceptance stops when a saved review owns the file
  (`has_pending_review`); finish that review in the Editor.

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
