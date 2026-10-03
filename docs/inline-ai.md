# Inline AI

Mimir has two Editor interactions: Cmd/Ctrl+K rewrite and `++` ghost completion.

## Inline rewrite

Cmd/Ctrl+K sends escaped context around the selection or cursor through the
Rust-authenticated provider bridge. The agent can answer, inspect approved
context, or call `suggest_edit`. An edit opens the normal full-document diff
(see [Editor](editor-system.md#proposal-and-git-review)). **Refine** returns to
the instruction input; Escape cancels or closes. Cmd/Ctrl+Enter accepts
remaining changes. The last decision automatically applies the reviewed result,
including partial rejections and manual edits.

Primary ownership is `InlineAI.vue`, `inlineTransport.js`, the Editor diff
store, and the native AI bridge.

## Ghost completion

Typing `++` within 320ms triggers a suggestion request. Tab or Right Arrow
accepts; Alt+Right accepts one word; Up/Down cycles alternatives; Enter
dismisses and passes through; Escape, another edit, or a pointer press cancels.
Non-auth failures fall back to local suggestions; authentication errors remain
visible.

Primary ownership is the CodeMirror ghost extension, `services/ai/ghost.js`,
and native generation. Models, credentials, and transport are in
[ai-system.md](ai-system.md).
