# Comments

Comments are review discussions embedded directly in Markdown. The storage
model is canonical and intentionally unchanged; the CodeMirror presentation is
inline.

## Canonical format

```xml
<comment id="a1b" author="user" text="Clarify the comparison." status="active" created="2026-07-25T10:00:00.000Z">the anchored text<reply id="c2d" author="agent" text="Revised in the next paragraph." ts="2026-07-25T10:04:00.000Z"/></comment>
```

The text between the opening tag and the first reply is the exact anchor.
`status` is `active` or `resolved`. Replies are self-closing `<reply>` elements
inside the comment.

`src/services/comments/parser.js` parses attributes, replies, raw ranges,
clean text, and clean-to-raw offset mappings. Attribute values are escaped and
unescaped centrally.

## Inline UI

`src/editor/codemirror/comments.js` hides the pseudo-XML tags and renders a
block discussion beneath its highlighted anchor. A thread supports:

- minimize and expand without changing storage
- write the initial text and add replies
- copy an agent-ready prompt
- paste the prompt into the active terminal Activity
- resolve and reopen
- delete the thread
- remove every thread from the current document

Resolved threads remain stored but leave the document flow. Their anchor has no
comment highlight. The status bar shows one quiet Resolved count when the document
has resolved threads. The user can use it to reveal the complete threads inline
at normal comment contrast and reopen one. Hiding or showing resolved threads and
minimizing/expanding active threads are UI state only.

The Editor toolbar shows previous and next comment controls with the visible
comment count. Navigation wraps in document order. It includes resolved threads
only while resolved history is visible. A revealed thread marks its Resolved
status with the accent color so active and resolved discussions remain scannable.

`src/stores/comments.js` owns transient document-level presentation: the active
thread, resolved-history visibility, counts, and the ordered visible set.
`useCommentPresentation.js` is the single bridge from that state to CodeMirror
and owns previous/next navigation. CodeMirror remains the owner of parsed tag
ranges, protected syntax, widget drafts, and rendering.

Delete replaces the entire tag with its anchor text. Remove all strips every
comment/reply wrapper while preserving every anchor. Resolve and reopen update
the comment's stored `status` attribute.

## CodeMirror protection

The comment extension uses four cooperating layers:

1. replacement decorations hide opening/closing tags;
2. atomic ranges keep normal cursor movement out of hidden syntax;
3. a change filter protects tag ranges from ordinary edits;
4. key handlers redirect deletion at tag boundaries.

Every deliberate mutation dispatches the `commentMutation` annotation so it
can pass the protection layer and remain undoable.

## Agent access

The MCP registry exposes add, reply, resolve, reopen, and delete operations.
`editor.comments` returns structured threads plus a focused agent prompt.
`mimir comments` and `mimir comments-prompt` use that same editor tool.

`src/services/comments/prompt.js` includes path, line, anchor, thread content,
and reply history without changing the document representation.

## Relevant code

- `src/services/comments/parser.js`
- `src/services/comments/prompt.js`
- `src/editor/codemirror/comments.js`
- `src/editor/composables/useCommentMutations.js`
- `src/stores/comments.js`
- `src/services/ai/tools/commentAdd.js`
- `src/services/ai/tools/commentReply.js`
