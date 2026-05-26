# Inline AI (Ask AI)

Cmd+K inline assistant for the editor. Select text (or place cursor), type an instruction, review the AI's suggestion in the full diff view.

## User Flow

1. Select text → press **Cmd+K** (or right-click → Ask AI, or InlineToolbar → Ask agent)
2. InlineAI bar appears at the top of the editor workspace (replaces toolbar)
3. Type instruction → **Enter** to send
4. AI processes (streams response, may call tools like `read` or `search`)
5. If the AI suggests an edit → **diff view opens automatically** with collapsed unchanged lines, scrolled to the change
6. Review the diff → **Accept** (applies change) or **Reject** (closes diff, bar stays for follow-up)
7. Type follow-up to refine → AI revises → updated diff
8. **Escape** closes everything. **Cmd+Enter** accepts from the bar.

Works without selection too — place cursor and Cmd+K to insert text at that position.

## Architecture

```
InlineAI.vue (bar component)
  ↓ creates
Chat (@ai-sdk/vue)
  ↓ uses transport
inlineTransport.js → ToolLoopAgent + DirectChatTransport
  ↓ with tools
read + search (from tool factories) + suggest_edit (custom)
  ↓ suggest_edit callback
App.vue activates diffStore → DiffView shows the change
```

### Component: `src/editor/components/workspace/InlineAI.vue`

Toolbar-style bar (not a floating popover). Occupies the same slot as DiffBar/EditorToolbar via `v-if` chain in App.vue. Has priority over DiffBar — when InlineAI triggers a diff, InlineAI's response row shows Accept/Reject instead of DiffBar.

**States:**
- Input (row 1 only): user types instruction
- Loading (row 1 disabled + row 2 status): "Reading document...", "Thinking..."
- Response with edit (row 1 input + row 2 response + diff view below)
- Response without edit (row 1 input + row 2 answer text)
- Error (row 1 input + row 2 error + retry)

**Key bindings:**
- Enter: send instruction
- Shift+Enter: newline in input (textarea, max 3 lines)
- Cmd+Enter: accept latest edit suggestion
- Escape: close (or cancel if loading)

### Transport: `src/services/ai/inlineTransport.js`

Same `ToolLoopAgent` + `DirectChatTransport` pattern as `chatTransport.js` (Panel chat). Lower limits:

| Setting | Inline AI | Panel Chat |
|---------|----------|------------|
| maxSteps | 4 | 8–15 |
| maxOutputTokens | 2000 | 1800 |
| temperature | 0.3 | 0.4 |
| sendReasoning | false | true |

### Tools (3 total)

| Tool | Source | Purpose |
|------|--------|---------|
| `read` | read.js (via `createReadTool`) | Read document, references, project files |
| `search` | search.js (via `createSearchTool`) | Search references, project content, citation coverage |
| `suggest_edit` | inlineTransport.js | Propose replacement text for selection |

All tools use `approvalMode: 'bypass'` (auto-approved — read-only tools plus the controlled `suggest_edit`).

`suggest_edit` is the custom tool. When the AI calls it, the `onEdit` callback fires → InlineAI emits `activate-diff` → App.vue constructs full-document original/modified and activates `diffStore` → DiffView shows with collapsed unchanged lines.

### System Prompt: `buildInlineSystemPrompt()`

Includes `<context-before>`, `<selection>` (or `<cursor-position>` when no selection), `<context-after>`. Instructs the agent to use `suggest_edit` for modifications and to answer questions directly.

### Model Selection

Stored in `settings.aiInlineModel` (default: `'auto'`, auto-resolved to first available model on mount). Compact ModelPicker in the bar header. Persists across sessions.

### Diff Integration

When `suggest_edit` fires:
1. `InlineAI` emits `activate-diff` with `{ from, to, replacement }`
2. `App.vue` constructs `modified = doc[0..from] + replacement + doc[to..]`
3. `diffStore.activate({ original, modified, review: { type: 'inline-ai' } })`
4. DiffView renders with `collapse: true` (unchanged lines hidden) and auto-scrolls to first chunk
5. InlineAI bar stays visible above DiffView with Accept/Reject

Accept: `onInlineAIApply()` → replaces text via `EditorSurface.replaceRange()`, deactivates diff, closes InlineAI.
Reject: deactivates diff, InlineAI stays open for follow-up.
Cmd+K with new selection: deactivates old diff, remounts InlineAI (`:key` increment).

### Files

| File | Role |
|------|------|
| `src/editor/components/workspace/InlineAI.vue` | Bar component (UI) |
| `src/services/ai/inlineTransport.js` | Transport + tools + system prompt |
| `src/editor/App.vue` | Wiring: bar slot, diff activation, Cmd+K handler |
| `src/editor/codemirror/core.js` | Cmd+K keymap (works with or without selection) |
| `src/editor/components/workspace/DiffView.vue` | Collapse + auto-scroll for inline-ai reviews |
| `src/editor/components/workspace/DiffBar.vue` | "AI suggestion" label variant |
| `src/stores/settings.js` | `aiInlineModel` preference |
