# AI Chat & Tools

Panel chat, tool modules, transport, system prompt, resilience. All JS, uses AI SDK.

## Files

| File | Role |
|------|------|
| `src/services/ai/chatTransport.js` | Creates ToolLoopAgent + DirectChatTransport per send |
| `src/services/ai/sdkAdapter.js` | Model factory, provider options, usage normalization |
| `src/services/ai/bridgeFetch.js` | Fetch-compatible bridge to Rust streaming proxy |
| `src/services/ai/tools/index.js` | Tool assembler — merges all modules, filters disabled tools |
| `src/services/ai/tools/pathHandlers.js` | `@` path handler: routes `@issues/`, `@knowledge/`, `@apps/`, `@skills/` to internal storage |
| `src/services/ai/tools/gate.js` | Execution gate: approval, audit, output cap |
| `src/services/ai/tools/pathPermission.js` | Path access classification and enforcement |
| `src/services/ai/tools/helpers.js` | Shared helpers: `readDocument()`, `limitText()`, `MAX_TOOL_OUTPUT_CHARS` |
| `src/services/ai/tools/textMatch.js` | Fuzzy text matching for proposals |
| `src/services/ai/recovery.js` | Poisoned message recovery |
| `src/services/ai/errors.js` | Error mapping: `mapAiError()`, `mapStatusToError()` |
| `src/services/ai/modelControls.js` | Model menu, auto resolution, ghost model priority |
| `src/services/ai/systemPrompt.js` | Core system prompt and instruction assembly |
| `src/services/ai/workspaceMeta.js` | `<workspace-meta>` XML for system prompt |
| `src/services/ai/context.js` | Editor context helpers, ghost prefix/suffix |
| `src/services/ai/ghost.js` | Ghost suggestion feature (uses Rust `ai_generate`) |
| `src/services/ai/rewrite.js` | Selection rewrite feature (uses Rust `ai_generate`) |
| `src/services/ai/inlineTransport.js` | Inline AI transport (Cmd+K), separate from chat |

## Transport (`chatTransport.js`)

Creates `ToolLoopAgent` + `DirectChatTransport` from `ai` package.

| Setting | Value | Note |
|---------|-------|------|
| maxSteps | 1–15 (default 8) | Hard-capped at 15. Skill metadata can override. |
| maxOutputTokens | 1800 | Skill metadata can override. |
| temperature | 0.4 | |
| sendReasoning | true | |

Export: `createShouldersChatTransport(getConfig)`.

## Hidden-From-User Tags (`<hfu>`)

User messages may contain context wrapped in `<hfu content-hidden-from-user>...</hfu>` tags (e.g. text attachments, comment review documents). The AI receives the full text; the UI strips `<hfu>` blocks before display. Data is never mutated — stripping happens in the render layer only (`ChatMessage.vue`). Session labels and clipboard copy also strip via `stripHfu()` from `src/shared/hfu.js`. The tag attribute is self-describing — no system prompt instruction needed.

Injection points: `sendMessage()` in `chat.js` (text attachments), `formatCommentsMessage()` in `persistence.js` (comment review submissions).

## System Prompt Assembly

Built by `buildInstructions()` in `systemPrompt.js`:

1. **Core** — `coreSystemPrompt()`: role, product context, default workflow, today's date. Minimal and hardcoded.
2. **Project instructions** — Two sources, merged into one `<project-instructions>` block:
   - `AGENTS.md` (workspace root) — shared with the team, committed to the repo.
   - `instructions.md` (`~/.shoulders-v3/projects/{id}/`) — personal, never leaves the machine. For private preferences, style notes, or context you wouldn't put in a shared repo.
3. **Workspace meta** — `<workspace-meta>` XML (file tree, refs, git status, 3K cap)
4. **Skills catalog** — `<available-skills>` XML block (name + description per skill)
5. **Skill prompt** — Full skill body if user pre-selected a skill
6. **Board context** — Active issues, overdue items, knowledge entries

Ghost: includes citation trigger phrases (26 phrases, checks last 120 chars of prefix). See `src/services/ai/ghost.js`.

## Model Factory (`sdkAdapter.js`)

`createSdkModel({modelId, feature, correlationPrefix, registry})` → `{ model, modelConfig, providerConfig }`.

- Resolves model from registry (by ID or feature default).
- Creates provider via `createAnthropic`/`createOpenAI`/`createGoogleGenerativeAI` with `createAiBridgeFetch`.
- Strips endpoint suffixes to get base URL (`/v1/messages` → base).
- Applies control options via `buildProviderOptions()` (see [ai-infra.md](ai-infra.md#control-mapping)).
- Anthropic: always sets `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`.

Usage normalization (`normalizeSdkUsage`): handles both AI SDK v5 flat and v6 nested formats. Output: `{ inputTokens, inputNoCacheTokens, cachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens, outputTokens, reasoningTokens, totalTokens, estimatedCost }`.

## Bridge Fetch (`bridgeFetch.js`)

`createAiBridgeFetch({feature, provider, modelId, providerModel, correlationPrefix})` → fetch-compatible function.

Pattern:
1. Set up Tauri event listeners **before** invoking (avoids race).
2. Call `ai_proxy_stream` with request.
3. Return `Response` with `ReadableStream` body.
4. Error events include HTTP `status` → sets `Response.status`.
5. Dummy auth: `'shoulders-local-key'` in all JS-side headers.

## Tools

The current 12 tools, each in its own file under `src/services/ai/tools/`:

| Tool | File | Mutating | Approval | Description |
|------|------|----------|----------|-------------|
| `read` | read.js | no | no | Read content: `@editor` (document), `@library.json` (references), `.docx` (Word text or metadata), project files |
| `list` | list.js | no | no | List directory contents: `@issues/`, `@knowledge/`, `@apps/`, `@skills/`, project paths. Glob filter support |
| `search` | search.js | no | no | 3 scopes: `project` (grep), `references` (library search), `citations` (coverage check) |
| `edit` | edit.js | yes | no (proposal) | Search-and-replace on `@editor`, `@issues/`, `@knowledge/`, `@skills/`, `@apps/`, project files. Proposals in normal mode, direct write in bypass |
| `create` | create.js | yes | no (proposal) | Create new file. `@issues/`/`@knowledge/`/`@apps/`/`@skills/` → direct write. Project paths → diff review |
| `comment_add` | commentAdd.js | yes | no | Add review comment anchored to text passage |
| `comment_reply` | commentReply.js | yes | no | Reply to existing comment thread |
| `comment_resolve` | commentResolve.js | yes | no | Mark comment as resolved |
| `search_web` | searchWeb.js | no | no | Academic search: OpenAlex (papers), CrossRef (DOI lookup), arXiv (metadata) |
| `annotate_docx` | annotateDocx.js | yes | yes | Add review annotations to Word manuscripts (comments, tracked changes). Creates revision copy |
| `show` | show.js | no | no | Render board entry (`@issues/` or `@knowledge/`) as interactive card in chat |
| `shell` | shell.js | yes | yes | Execute shell command in project directory. Timeout, output truncation |

Context-dependent availability:
- `shell`, `show`, `annotate_docx` require `workspacePath`/`projectId`
- `show` requires `projectId`
- All others always available

Assembler: `createShouldersTools(context)` in `tools/index.js`. Disabled tools (from `context.disabledTools[]`) are deleted.

Path routing: `@editor`, `@library.json`, `@issues/`, `@knowledge/`, `@apps/`, `@skills/` paths are resolved by `pathHandlers.js`. `@issues/` and `@knowledge/` validate YAML frontmatter, bypass proposals, and reload the board store after writes.

`edit` and `create` on project paths return `{ status: 'pending_review' }` and emit a proposal via `context.onProposal()`. Proposals appear as `FileChangeCard`s in Panel chat. In bypass approval mode, both write immediately.

Skills are read via `read("@skills/{id}/SKILL.md")`. Progressive disclosure: AI sees skill catalog in system prompt, reads full instructions on demand.

## Tool Execution Gate (`gate.js`)

Every tool's `execute` is wrapped by `withGate(name, executeFn, context)`.

Gate flow:
1. Validate args are an object (rejects null, arrays).
2. Check `context.policy.disabledTools` — skip if tool is disabled.
3. Check `context.policy.toolWhitelist` — if set, tool must be in it.
4. **Approval**: depends on `context.approvalMode`:
   - `bypass`: auto-approve everything.
   - `normal`: auto-approve non-`requiresApproval` tools, prompt for others.
   - `strict`: prompt for ALL tools.
5. Session allow list: "Always Allow" choices remembered per session.
6. Output cap: 48K chars (`MAX_OUTPUT_CHARS`). Truncated with `[Truncated]`.
7. Audit: logs to SQLite via `tool_execution_record`.

Approval queue: concurrent tool calls within a session are queued via private `approvalQueues` Map. Only the front of the queue is promoted to `pendingApprovalMap` (visible to the UI). Resolving one approval promotes the next. `resolveApproval(sessionId, result, true)` drains the entire queue (used by `destroyChat`/stop). `withGate` threads `sdkOptions.toolCallId` into approval meta so `ToolCallBlock` can match the approval to the correct tool call.

Exports: `registerTool(name, meta)`, `withGate()`, `getToolMeta()`, `getToolCategories()`, `clearSessionAllowList()`, `grantSessionAllow()`, `revokeSessionToolAllow()`, `getSessionToolAllows()`.

## Tool Server (MCP)

Exposes allowlisted tools to external agents (e.g. Claude Code) via MCP Streamable HTTP.

| Component | Path |
|-----------|------|
| Axum HTTP server | `src-tauri/src/tool_server.rs` |
| JS event bridge | `src/services/toolServer.js` |
| Lifecycle | `src/panel/App.vue` → `startToolServer()` |

**Endpoint**: `POST http://localhost:17532/mcp` — JSON-RPC 2.0, no auth (localhost only).

**Protocol**: `initialize` → capabilities, `tools/list` → schemas from `generateToolSchema()`, `tools/call` → dispatches via same event bridge + `createShouldersTools()` as built-in chat. Tool context uses `approvalMode: 'bypass'`.

**Allowlist**: `TOOL_SERVER_ALLOWLIST` in `toolServer.js`. Only domain-specific tools — file/shell/project tools excluded (agents have native equivalents).

**Agent setup**: `claude mcp add shoulders --transport http http://localhost:17532/mcp`

## Path Permission Gate (`pathPermission.js`)

`classifyPath(absolutePath, projectPath, sessionId)` → `{ action: 'allow'|'ask'|'reject', reason }`.

- **allow**: path inside workspace.
- **ask**: path outside workspace, not sensitive.
- **reject**: sensitive blocklist match.

Sensitive: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `/etc`, `credentials`, `.env` segments.

Session-scoped: approved folders remembered for the session. See [permissions.md](permissions.md).

## Error Handling (`errors.js`)

`mapAiError(error)` → `{ message, kind }`. All messages include recovery instructions.

Kinds: `auth`, `network`, `provider`, `limit`, `timeout`, `unknown`.

`mapStatusToError(status, body)` for HTTP status codes from Rust proxy.

`chatTransport.js` wraps all errors via `mapAiError`. Preserves original as `.cause`, attaches `.kind`.

## Chat Resilience (`recovery.js`)

`recoverPoisonedMessages(chat, error)` — mutates in-place, scans ALL messages.

Two failure modes:
1. **Stuck parts**: tool part at `input-available`/`input-streaming` → replaced with text fallback `[Tool call: {name} — {error}]`.
2. **Poisoned input**: `output-error` part with raw string input → part replaced with text fallback.

## Persistence Hardening

`cleanMessagesForPersist()` in `src/stores/panel/helpers.js`: strips stuck parts, compacts oversized tool output (>2KB) with `_truncatedAt` marker. Concurrent persist guard serializes async writes.

Session export/import: `shoulders-session-v1` JSON format.

## Budget Gating

Before each send: `checkBudget()` queries `usage_query_month` + `usage_get_setting('budget_limit')`. Blocks at 100%, warns at 80%. `budget_fail_mode`: `open` (default, fails open) or `closed` (blocks on IPC errors).

## Context Window Enforcement

`isContextBlocked` in `src/stores/panel/chat.js`: disables send when `lastInputTokens >= contextWindow`. Composer shows blocked banner.

## Auto-Title

After first exchange: cheapest model (feature `extract`) generates 3–8 word title + search keywords. Fire-and-forget.

## Model Controls (`modelControls.js`)

- `resolveAutoModel(registry, keyStatuses)`: picks first available from `registry.autoOrder.chat`.
- `ghostModels(registry)`: returns models listed in `registry.autoOrder.ghost`, in order.
- `resolveGhostDefault()`: first ghost model with configured key.
- `chatModels(registry)`: filters by `streaming && tools` capabilities.
- `controlForModel(model, controlId)`: extracts control info for UI.

All model IDs, ordering, and legacy mappings live in [`ai-models.json`](../src-tauri/resources/ai-models.json).

## Workspace Meta (`workspaceMeta.js`)

`buildWorkspaceMeta(context)` → `<workspace-meta>` XML, 3K cap.

Includes: open tabs, active file, file tree (2 levels, 40 entries), reference library (15 most recent), git branch, git status (filters `.shoulders/`, max 20).

## Tool Input Schema Rule

ALWAYS use `inputSchema` with zod — NEVER `parameters`. Using `parameters` silently breaks Anthropic (400: `input_schema.type: Field required`). See [gotchas.md](gotchas.md).
