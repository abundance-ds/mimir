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
- Minimized state and resolved-thread visibility are renderer state, not
  Markdown.
- Hidden syntax needs replacement decorations, atomic ranges, change filters,
  and boundary key handlers. Deliberate changes carry `commentMutation`.
- Public comment tools use this same representation; the definitive public
  names are in [agent-interface.md](agent-interface.md).

Renderer ownership is the comments service/store, comment composables, and
`src/editor/codemirror/comments.js`.
