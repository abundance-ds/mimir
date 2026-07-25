# AI SDK + Vue Integration

How the Panel chat system works at the Vue/reactivity level. Read this before modifying the panel store modules (`src/stores/panel/`), any chat component, or the transport layer.

For the Rust/JS architecture split (keys, transport, proxy), see [ai-infra.md](ai-infra.md). For tool/chat details, see [ai-chat.md](ai-chat.md).

## Packages

```
@ai-sdk/vue       Chat class (Vue-reactive wrapper around AbstractChat)
ai                 ToolLoopAgent, DirectChatTransport, streamText, tool()
@ai-sdk/anthropic  Anthropic provider adapter
@ai-sdk/openai     OpenAI provider adapter
@ai-sdk/google     Google provider adapter
```

## The Chat Class

`Chat` from `@ai-sdk/vue` is the core object. One instance per session.

Internally it wraps `AbstractChat` with a `VueChatState` that holds three Vue `ref()` values:

```
chat.state.messagesRef   →  ref<UIMessage[]>
chat.state.statusRef     →  ref<'ready' | 'submitted' | 'streaming' | 'error'>
chat.state.errorRef      →  ref<Error | undefined>
```

The `Chat` class also exposes getters (`chat.messages`, `chat.status`, `chat.error`) that proxy to `this.state.messagesRef.value`, etc. **Do not use these getters in Vue computeds** — go through the refs directly.

## Chat Instance Storage (Critical)

Chat instances **must live in a plain `Map` outside Vue's reactive system.** Never store them on reactive objects (session arrays, refs, etc.).

```js
// Module scope — NOT inside the store function
const chatInstances = new Map()   // sessionId → Chat
```

Why: Vue's reactive Proxy wraps objects it manages. When a Chat instance is stored on a proxied object, the Proxy intercepts property access and breaks the `this` context inside the Chat's getters. The result: `messagesRef.value` becomes inaccessible, and computeds never re-evaluate when messages change.

This bug is silent — no error, no warning. The Chat works internally, but Vue never renders the updates.

### The Reactive Bridge

```js
const _chatVersion = ref(0)

function getChatInstance(sessionId) {
  void _chatVersion.value          // reads the ref → creates reactive dependency
  return chatInstances.get(sessionId) || null
}

function getOrCreateChat(session) {
  if (chatInstances.has(session.id)) return chatInstances.get(session.id)
  const chat = new Chat({ ... })
  chatInstances.set(session.id, chat)
  _chatVersion.value++             // triggers re-evaluation of any computed using getChatInstance
  return chat
}
```

Components and computeds call `getChatInstance()`. The `void _chatVersion.value` read tells Vue "this computed depends on _chatVersion." When a Chat is created or destroyed, `_chatVersion++` invalidates those computeds.

### Accessing Chat State in Computeds

```js
// Correct — reads the ref directly
const activeMessages = computed(() => {
  const chat = activeChat.value
  return chat ? chat.state.messagesRef.value : []
})

// Correct — same for status
const activeStatus = computed(() => {
  const chat = activeChat.value
  return chat ? chat.state.statusRef.value : 'ready'
})
```

When the AI SDK pushes a message (`messagesRef.value = [...msgs, newMsg]`), Vue's ref triggers, the computed re-evaluates, and the template re-renders.

### Lifecycle via watch

```js
watch(
  () => chat.state.statusRef.value,
  (newStatus, oldStatus) => {
    if (newStatus === 'ready' && (oldStatus === 'streaming' || oldStatus === 'submitted')) {
      session.updatedAt = new Date().toISOString()
      schedulePersist()   // save to disk
    }
  },
)
```

This replaces `onFinish` for persistence — `onFinish` fires at the Chat level but doesn't integrate with Vue's effect system.

## Sending Messages

```js
async function sendMessage(text) {
  const chat = getOrCreateChat(session)
  chat.sendMessage({ text: text.trim() })   // NOT awaited
}
```

**Never await `chat.sendMessage()`.** It resolves only after the entire stream completes. If you await it, the view won't update until the full response arrives (could be 30+ seconds). Fire-and-forget — messages appear reactively via `messagesRef`.

### Timing of User Message Push

`chat.sendMessage({ text })` is async. Internally:

1. `await convertFileListToFileUIParts(undefined)` — resolves immediately but IS an await (one microtask)
2. `this.state.pushMessage(userMessage)` — pushes user message (replaces `messagesRef.value` array)
3. `await this.makeRequest(...)` — starts streaming

The user message appears after one microtask. Vue's next re-render will pick it up via the `messagesRef` dependency.

## Transport Architecture

Each `chat.sendMessage()` call goes through the transport:

```
chat.sendMessage({ text })
  → createMimChatTransport (chatTransport.js)
    → ToolLoopAgent + DirectChatTransport
      → createSdkModel (sdkAdapter.js)
        → @ai-sdk/anthropic (or openai/google) with bridgeFetch
          → invoke('ai_proxy_stream') (Rust)
            → Rust resolves real API key
            → Rust streams HTTP to provider
            → Tauri events back to bridgeFetch
          → ReadableStream back to AI SDK
        → AI SDK parses SSE, handles tool calls
      → ToolLoopAgent executes tools (JS-side, up to 8 steps)
    → DirectChatTransport returns UIMessageStream
  → Chat updates messagesRef reactively
```

The transport is created with a **config-getter closure**: `() => buildChatConfig(session)`. This is called fresh per request, ensuring up-to-date API keys, model selection, and control settings.

### Key Boundaries

- **AI SDK** owns provider wire format, SSE parsing, tool-call protocol, and streaming.
- **Rust** owns API keys (keychain/env/.env), HTTP transport, host allowlist, and cancellation.
- **bridgeFetch.js** bridges the two — makes `invoke('ai_proxy_stream')` look like a `fetch()` to AI SDK.
- Provider API keys **never enter JavaScript**. `sdkAdapter.js` passes a dummy key; Rust overwrites auth headers.

## Message Format (UIMessage)

```js
{
  id: string,                    // nanoid from SDK
  role: 'user' | 'assistant',
  parts: Part[],                 // ordered content parts
  createdAt: string,             // ISO timestamp
}
```

### Part Types

| Type | Fields | When |
|---|---|---|
| `text` | `text`, `state?` | User text, assistant prose |
| `reasoning` | `text`, `state?` | Model thinking (Claude, o3) |
| `tool-{name}` | `toolCallId`, `toolName`, `state`, `input`, `output?`, `errorText?` | Typed tool call |
| `dynamic-tool` | same as above | Dynamic/unknown tool |
| `file` | `mediaType`, `filename`, `url` | Attached file (data URL) |

Tool part states: `input-streaming` → `input-available` → `output-available` or `output-error`.

### Parts Array Gotcha

The AI SDK shallow-clones message objects (`{ ...message }`) when updating but may **reuse the same `parts` array reference** with mutated contents. Vue's computed caching checks reference equality on dependencies — if you go through intermediate computeds, they may not update because the parts array reference didn't change.

**Fix:** Read `props.message.parts` directly in templates and watchers, not through intermediate computeds.

## Tool Definitions

12 tools, each in its own file under `src/services/ai/tools/`: `read`, `list`, `search`, `edit`, `create`, `comment_add`, `comment_reply`, `comment_resolve`, `search_web`, `annotate_docx`, `show`, `shell`.

`index.js` assembles all tools via `createMimTools(context)`. `helpers.js` provides shared utilities (`limitText`, `readDocument`, `readReferences`, etc.).

Use `tool()` from `ai` with `inputSchema` (not `parameters`):

```js
import { tool } from 'ai'
import { z } from 'zod'

const myTool = tool({
  description: '...',
  inputSchema: z.object({
    query: z.string().min(1).max(200),
  }),
  execute: async ({ query }) => { ... },
})
```

Rules:
- **Use `inputSchema`, not `parameters`** — both are accepted by `tool()` but `parameters` may serialize differently.
- **Never use `z.object({})`** for empty schemas — Anthropic requires `type: "object"` in the JSON Schema, and empty Zod objects omit it. Add at least one optional parameter, or don't define the tool if it takes no input.
- Tools execute in the Panel JS process, not in Rust.
- Tools that modify content create proposals (`edit`, `create` on project paths), never mutate directly. `shell` and `annotate_docx` require explicit user approval. `@issues/`, `@knowledge/`, `@apps/`, `@skills/` paths bypass proposals (direct write).
- Tool output is displayed in `ToolCallBlock.vue` with collapsible detail. Pending approvals render as an expanded approval card with Accept/Decline/Always Allow buttons.
- Every tool is wrapped by `withGate()` from `gate.js` for validation, approval, output capping (48K), and audit logging.

## Persistence

Sessions are snapshots of Chat state + metadata:

```js
function snapshotSession(session) {
  const chat = chatInstances.get(session.id)
  const messages = chat
    ? chat.state.messagesRef.value.map(m => ({
        ...m,
        parts: (m.parts || []).map(p => ({ ...p })),
      }))
    : session._savedMessages || []
  return { id, projectId, label, modelId, ..., messages }
}
```

Messages are shallow-cloned (including each part) to avoid storing reactive proxies or shared references.

On restore, saved messages are passed via `_savedMessages` on the session object, then fed to `new Chat({ messages: session._savedMessages })` when the Chat is created.

Storage: `~/.mim/projects/{projectId}/sessions/{sessionId}.json` (Tauri) or `localStorage` (browser fallback).

### Persistence Hardening

`cleanMessagesForPersist(messages)` runs before every disk write:
- Strips stuck parts (`input-available`, `input-streaming`) that would cause 400 on next send.
- Compacts oversized tool output parts (>2KB) with a `_truncatedAt` marker.

A concurrent persist guard serializes async writes to prevent interleaved disk writes from parallel session saves.

### Session Export/Import

Sessions can be exported as `mim-session-v1` JSON files and re-imported:
- Export: `exportData = { _format: 'mim-session-v1', exportedAt, session }` written via Tauri save dialog.
- Import: reads JSON file via Tauri open dialog, validates `_format` field, creates a new session from the snapshot.

## Streaming Cancel/Abort

```js
function stopActiveSession() {
  const chat = activeChat.value
  if (chat) chat.stop()
}
```

`chat.stop()` calls `activeResponse.abortController.abort()`, which:
1. Cancels the fetch (bridgeFetch → Rust `ai_abort`)
2. Sets status to `'ready'`
3. Preserves partial messages already received

## v0.2.x Patterns — Porting Status

These existed in `~/Desktop/hugin-munin/src/stores/chat.js` and components:

- ~~**Tool call error recovery:**~~ **Ported** to `src/services/ai/recovery.js`. Called from `onError` in `getOrCreateChat`.
- ~~**Auto-title generation:**~~ **Ported** to `src/stores/panel/chat.js` `autoGenerateTitle`. Uses cheapest model after first exchange.
- ~~**Budget gating:**~~ **Ported** to `src/stores/panel/chat.js` `checkBudget`. Queries `usage_query_month` before sends.
- ~~**Streaming text reveal (rubber-band animation):**~~ **Ported** to `src/panel/composables/useStreamReveal.js`. `requestAnimationFrame`-based progressive character reveal with acceleration proportional to buffer size.
- **Rich HTML for user messages:** Not yet ported. Store formatted HTML separately from SDK messages.

## Files

| File | Role |
|---|---|
| `src/stores/panel/chat.js` | Chat store: Chat Map bridge, send/stop/regenerate, budget gating, auto-title, usage recording |
| `src/stores/panel/sessions.js` | Session store: session CRUD, model/control selection, import/export |
| `src/stores/panel/helpers.js` | Module-level chatInstances Map, readHistories Map, pure helpers |
| `src/stores/panel/persistence.js` | Persistence: cleanMessagesForPersist, save/restore orchestration, initializePanelStores() |
| `src/panel/composables/useStreamReveal.js` | Rubber-band streaming text reveal animation |
| `src/services/ai/chatTransport.js` | Transport factory: ToolLoopAgent + DirectChatTransport per request |
| `src/services/ai/systemPrompt.js` | Core system prompt and instruction assembly |
| `src/services/ai/sdkAdapter.js` | Model factory: createSdkModel(), lazy-loaded provider adapters, usage normalization |
| `src/services/ai/bridgeFetch.js` | Fetch bridge: makes Tauri invoke look like fetch() for AI SDK, uses HTTP status from Rust errors |
| `src/services/ai/tools/index.js` | Tool assembler: `createMimTools()`, 12 tools from individual files |
| `src/services/ai/tools/read.js` | `read` — @editor, @library.json, .docx, project files |
| `src/services/ai/tools/edit.js` | `edit` — search-and-replace with proposal flow |
| `src/services/ai/tools/create.js` | `create` — new file with proposal flow |
| `src/services/ai/tools/search.js` | `search` — project grep, reference search, citation check |
| `src/services/ai/tools/helpers.js` | Shared tool helpers: limitText, readDocument, readReferences, referenceHaystack, etc. |
| `src/services/ai/tools/gate.js` | Execution gate: validation, approval, whitelist, output enforcement (48K), audit logging |
| `src/services/ai/tools/textMatch.js` | Fuzzy text matching, path traversal prevention, cross-window proposal matching |
| `src/services/ai/workspaceMeta.js` | Builds `<workspace-meta>` XML block for system prompt (file tree, refs, git) |
| `src/services/ai/errors.js` | Actionable error mapping: mapAiError, mapStatusToError |
| `src/services/ai/recovery.js` | Poisoned tool-call recovery (all messages). Called from Chat onError. |
| `src/services/ai/modelControls.js` | Model menu builder, Auto resolution, legacy ID normalization, effort/thinking control helpers |
| `src/services/ai/client.js` | Thin Tauri invoke wrappers for AI config/registry/keys |
| `src/shared/proposalEvents.js` | Cross-window proposal event constants |
| `src/editor/composables/useProposalBridge.js` | Editor-side proposal listener and applier |
| `src/panel/components/ChatView.vue` | Chat layout: message list, proposals, composer |
| `src/panel/components/ChatMessage.vue` | Single message: user bubble or assistant with parts |
| `src/panel/components/Composer.vue` | Input, model picker, send/stop, cost display |
| `src/panel/components/ToolCallBlock.vue` | Tool call display with collapsible detail + inline approval card for pending tools |
| `src/panel/components/FileChangeCard.vue` | Proposal card: accept/reject/review |
