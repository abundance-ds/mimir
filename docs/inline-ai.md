# Inline AI

Mimir has two native model interactions inside the Editor: the Cmd/Ctrl+K inline
agent and `++` ghost completion. CLI agents remain the primary general-purpose
intelligence.

## Cmd/Ctrl+K inline agent

Cmd/Ctrl+K works with selected text or an empty selection at the cursor. The
toolbar slot becomes a compact instruction surface with model selection,
streaming status, response text, retry/cancel, and follow-up.

The prompt contains escaped context before and after the selection. The agent
can read the attached document, search the workspace, answer directly, or call
`suggest_edit`.

An edit follows this path:

```text
instruction
  -> AI SDK ToolLoopAgent through the Rust provider bridge
  -> suggest_edit replacement
  -> full-document Editor diff
  -> explicit Accept or Reject
```

Accept applies the selected-range replacement and closes the inline surface.
Reject closes the diff but keeps the surface open for refinement. Escape
cancels a live request or closes the interaction. Cmd/Ctrl+Enter accepts a
pending edit.

Primary files:

- `src/editor/components/workspace/InlineAI.vue`
- `src/services/ai/inlineTransport.js`
- `src/editor/components/workspace/inlineAIKeys.js`
- `src/editor/App.vue`
- `src/stores/diff.js`

## Ghost completion

Typing `++` within the configured interval removes the trigger and requests
contextual completions. While active:

- Tab, Enter, or Right Arrow accepts the current completion
- Alt+Right accepts the next word
- Up/Down cycles alternatives
- Escape cancels
- another edit or pointer action dismisses the completion

The service asks for a small JSON suggestion list and falls back to local
suggestions for non-auth failures. Authentication errors render inline.

Primary files:

- `src/editor/codemirror/ghost.js`
- `src/services/ai/ghost.js`
- `src/services/ai/client.js`
- `src-tauri/src/ai.rs`

## Models and keys

Settings > Models stores keys for Anthropic, OpenAI, and Google through the OS
keychain and selects the ghost model. The inline surface owns its model picker;
both choices persist in the settings store. Provider SDKs prepare model
requests; Rust owns credential resolution, upstream transport, host validation,
cancellation, and response handling.

Debug-only fallback sources are process environment variables, repository
`.env`, and `~/.mimir/keys.env`.

See [ai-system.md](ai-system.md) for registry migration, model resolution,
credential precedence, provider normalization, and the two transport paths.
