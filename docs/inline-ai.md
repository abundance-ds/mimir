# Inline AI

Mimir has two Editor interactions: Cmd/Ctrl+K rewrite and `++` ghost completion.

## Inline rewrite

Cmd/Ctrl+K sends escaped context around the current selection or cursor through
the Rust-authenticated provider bridge. The agent can answer, inspect approved
context, or call `suggest_edit`. An edit always opens the normal full-document
diff for explicit accept or reject. Reject returns to refinement; Escape
cancels or closes; Cmd/Ctrl+Enter accepts a pending edit.

Primary ownership is `InlineAI.vue`, `inlineTransport.js`, the Editor diff
store, and the native AI bridge.

## Ghost completion

Typing `++` inside the configured interval requests a small suggestion set.
Tab, Enter, or Right Arrow accepts; Alt+Right accepts one word; Up/Down changes
alternative; Escape, another edit, or pointer movement cancels. Non-auth
failures can use local suggestions; authentication errors remain visible.

Primary ownership is the CodeMirror ghost extension, `services/ai/ghost.js`,
and native generation. Models, credentials, and transport are in
[ai-system.md](ai-system.md).
