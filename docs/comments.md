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
- Hidden syntax needs replacement decorations, atomic ranges, change filters,
  and boundary key handlers. Deliberate changes carry `commentMutation`.
- Public comment tools use this same representation; the definitive public
  names are in [agent-interface.md](agent-interface.md).

Renderer ownership is the comments service/store, comment composables, and
`src/editor/codemirror/comments.js`.

## Table discussions

In Live Preview, each commented cell has a visible button with its thread count.
The **Comments (N)** control below the table expands or collapses the discussion
list. Counts refer to active threads, not replies. **Show resolved** includes
resolved threads and their cell markers; the Editor's resolved visibility
control also applies.

Discussions appear in document order, with the column heading, row number, and
an excerpt of the rendered anchor. Header comments use the label **header**.
A cell can contain multiple independent discussions. Its button opens the list
at the first visible discussion in that cell. Selecting a discussion highlights
its exact anchor, including formatted text and links. Other tables retain their
own open state.

Reading, replying, resolving, reopening, and deleting use the existing comment
controls without moving the text selection into the table. Column resizing and
comment selection retain a pending reply draft and its focus. Clicking ordinary
cell text still opens Markdown source. Source mode restores the ordinary inline
discussion blocks; preview renders each discussion only once below its table.

`tableComments.js` owns markers, anchor mapping, and the discussion list.
`comments.js` supplies the shared thread renderer and actions. `livePreview.js`
owns the table block and tells the comment renderer which threads it contains.
Open lists and reply drafts are renderer state; they do not change Markdown.
Table blocks use internal spacing, not vertical margins, for correct editor
line measurements.

Verification: `tableComments.test.js` covers multiple threads per cell, separate
tables, exact anchors, pending drafts, failures, mutations, resolved visibility,
source transitions, links, and resizing. `harness/table-comments.html` mounts
the real editor and local comment mutations for browser checks. Chrome mouse
and keyboard checks passed for opening/collapsing lists, anchor selection,
reply, resolve/reopen, resizing, and line hit testing below a table. Wide and
narrow layouts were inspected. Installed macOS verification remains required.
