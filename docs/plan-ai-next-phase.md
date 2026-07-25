# AI Work-In-Progress Plan

Status: active WIP plan. Foundation implemented; next phase is hardening, persistence, and Editor integration.

## Implemented Foundation

Use AI SDK for orchestration and provider protocol. Use Rust for secrets and transport control.

```txt
AI SDK / JS
  UI messages
  provider adapters
  streaming/tool-call protocol
  ToolLoopAgent multi-step loops
  zod tool schemas
  Panel chat session orchestration

Rust AI kernel
  API keys/keychain
  debug .env / keys.env fallback
  provider HTTP execution
  host allowlist
  stream cancellation
  future audit/policy insertion point
  model registry/config
```

Do not rebuild tool loops or provider streaming formats from scratch. Do not move real provider secrets into JS.

## Implemented Architecture

The earlier idea was a custom AI SDK model adapter backed directly by `ai_generate` / `ai_stream` and Rust provider adapters.

Actual implementation uses AI SDK provider adapters plus a Rust fetch bridge:

```txt
AI SDK provider adapter
  -> bridgeFetch.js
    -> ai_proxy_stream
      -> Rust key injection + allowlist + reqwest stream
        -> provider
```

Reason: a true custom adapter would require reimplementing Anthropic/OpenAI/Google tool-call and stream parsing. That is high-risk duplicate work. AI SDK already solves it.

## Current Files

Rust:

- `src-tauri/src/ai_proxy.rs` - streaming bridge, cancellation, key injection.
- `src-tauri/src/ai.rs` - non-streaming `ai_generate` for ghost/rewrite.
- `src-tauri/src/ai_models.rs` - registry/default models.
- `src-tauri/src/ai_keys.rs` - keychain/env/debug fallback.
- `src-tauri/src/ai_transport.rs` - HTTP helpers/allowlist/redaction.

JS:

- `src/services/ai/bridgeFetch.js` - fetch-compatible Tauri stream bridge.
- `src/services/ai/sdkAdapter.js` - AI SDK provider model factory + usage conversion.
- `src/services/ai/modelControls.js` - model menu, Auto resolution, effort/thinking control helpers.
- `src/services/ai/chatTransport.js` - ToolLoopAgent + DirectChatTransport.
- `src/services/ai/tools/index.js` - initial safe tools.
- `src/panel/App.vue`, `src/panel/components/`, `src/panel/composables/usePanelStore.js` - multi-session streaming chat UI and prototype Panel state.

## Current Capabilities

- Multiple independent Panel chat sessions.
- Per-session model selection from registry.
- Streaming responses from Anthropic/OpenAI/Google, subject to configured keys.
- Tool loops through AI SDK `ToolLoopAgent`.
- Safe initial tools:
  - `read`
  - `search`
  - `edit`
- Rust cancellation per provider request via `correlationId`.
- Debug `.env` support for local API keys.
- Anthropic automatic prompt caching is enabled for chat streams and Rust-native `ai_generate`.
- Usage normalization now separates fresh input, cache reads, cache writes, output, reasoning, and total tokens.
- Prototype Panel session state exists in local browser storage; not final persistence.

## Immediate Next Steps

1. ~~**Live native smoke test**~~ — **Done 2026-05-11.** 46/46 provider tests pass (Anthropic 15, Google 11, OpenAI 20). All model/effort/thinking combinations verified.

2. **Fix live-stream/tool-call issues found by smoke test** — **Partially done (2026-05-11).**
   - Fixed: stream session leak (auto-cleanup on all exit paths in `ai_proxy.rs`).
   - Fixed: UTF-8 multi-byte chunk corruption (byte buffer in `ai_proxy.rs`).
   - Fixed: double `load_registry()` per stream request (pass registry as parameter).
   - Fixed: unknown provider auth now logs warning instead of silently skipping.
   - Fixed: `chatTransport.js` error boundary wraps model/agent creation, maps errors via `mapAiError`.
   - Fixed: `reconnectToStream` now throws instead of returning null.
   - Fixed: Google thinking `'none'` no longer sends invalid `thinkingConfig`.
   - Remaining: listener-before-invoke ordering is already correct in `bridgeFetch.js`.

3. **Promote Panel persistence from prototype to project-scoped storage** — **Done.**
   - `usePanelStore.js` dual-path persistence: Tauri disk via `dataDir.js`, localStorage fallback.
   - Storage: `~/.mim/projects/{projectId}/sessions/{sessionId}.json`.
   - Integration test still needed.

4. **Connect proposals to Editor review/apply flow** — Still pending.
   - Owned by Editor agent. Needs cross-window event bridge (Rust commands + Tauri events).

5. ~~**Replace prototype tool data sources**~~ — **Done (2026-05-11).**
   - `read` now reads file path from `localStorage` (`mim:doc:path`).
   - `search` uses Tauri `ref_list` when available, localStorage fallback.
   - Removed `sampleDocument` dependency — tools return empty state when no data.
   - Consolidated into: `search_web` (OpenAlex, CrossRef, arXiv), `search` (scope: references).

6. ~~**Persist usage ledger**~~ — **Done (2026-05-11).**
   - `src-tauri/src/usage.rs`: SQLite at `~/.mim/usage.db`.
   - Commands: `usage_record`, `usage_query_month`, `usage_get_setting`, `usage_set_setting`.
   - JS wiring: `usePanelStore.js` `recordUsage` calls `usage_record` on each AI step finish.

7. **Smoke-test Claude prompt caching** — Pending.

## Hardening TODOs

- ~~Add clearer Panel error states for provider auth, provider 4xx/5xx, network, abort, and tool errors.~~ **Done**: `errors.js` rewritten with structured `mapAiError` returning `{ message, kind }`. Kinds: auth, network, provider, limit, unknown.
- ~~Prompt injection in ghost/rewrite prompts.~~ **Done**: `escapePromptXml` in `context.js`, applied in `ghost.js` and `rewrite.js`.
- ~~Search relevance in tools.~~ **Done**: `search` (scope: references) now does multi-term scoring.
- ~~Consistent ID generation.~~ **Done**: proposal IDs use `crypto.getRandomValues`.
- ~~Poisoned tool-call recovery.~~ **Done**: `recovery.js` fixes stuck and corrupt tool parts.
- ~~Auto-title generation.~~ **Done**: uses cheapest model after first exchange.
- ~~File read dedup.~~ **Done**: `_readHistory` tracks reads, adds stale note on re-reads.
- ~~Budget gating.~~ **Done**: checks `usage.db` before sends, blocks at limit, warns at 80%.
- ~~Tool fetch timeouts.~~ **Done**: 15s `AbortSignal.timeout` on all external API calls.
- Add approval gates for mutating and external tools.
- Add output-size enforcement tests for every tool.
- Add malformed tool-call recovery based on v0.2.x lessons.
- Prevent poisoned persisted messages once durable chat persistence lands.
- Add policy/audit hooks:
  - Rust: before upstream provider request.
  - JS: before tool execution.
- Add Anthropic prompt-cache fixtures; short prompts silently not caching is expected.
- Add bundle splitting so main editor does not eagerly load all AI SDK/provider packages.
- Split tools into modules once the registry grows beyond the initial three tools.

## Tests To Add

- `providerBaseUrl()` conversions in `src/services/ai/sdkAdapter.js`.
- `normalizeSdkUsage()` and `addUsage()`.
- Tool output truncation and proposal-only write behavior.
- Rust auth-header overwrite in `ai_proxy.rs`.
- Rust host allowlist rejection.
- Stream abort/cleanup behavior.
- Native smoke script if/when the project adopts a test runner.

## Non-Negotiable Conventions

- JS provider constructors use dummy keys only.
- Rust overwrites provider auth headers before upstream requests.
- Tool writes are proposals by default.
- `maxSteps` must stay hard-capped.
- Tauri stream listeners must be registered before invoking Rust.
- Do not call provider APIs directly from browser/renderer fetch.
- Do not reintroduce provider secrets into renderer state.
