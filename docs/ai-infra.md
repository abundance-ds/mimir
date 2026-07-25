# AI Infrastructure (Rust Backend)

Keys, transport, streaming proxy, model registry, usage tracking. All in `src-tauri/src/`.

## Files

| File | Role |
|------|------|
| `ai.rs` | Non-streaming command surface (`ai_generate`, `ai_config_dir`, `ai_model_registry`, `ai_key_status`, `ai_set_api_key`) |
| `ai_proxy.rs` | Streaming bridge (`ai_proxy_stream`, `ai_abort`, `ai_cleanup`) |
| `ai_keys.rs` | Key resolution: keychain → env → .env → keys.env |
| `ai_models.rs` | Versioned model registry, migration, feature default resolution |
| `ai_providers.rs` | Rust-native request/response adapters (Anthropic, OpenAI, Google) for `ai_generate` only |
| `ai_transport.rs` | Shared HTTP: `post_json`, `build_headers`, `validate_url_host`, `redact_error` |
| `ai_usage.rs` | Normalized usage shape, cost estimation |
| `usage.rs` | SQLite usage ledger (`usage_record`, `usage_query_month`, `tool_execution_record`, etc.) |

## Key Resolution (`ai_keys.rs`)

Order: OS keychain → process env → repo `.env` (debug) → `~/.mim/keys.env` (debug).

Keychain service: `com.mim.terminal`. Account format: `{provider}_api_key`.

Provider env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`.

Production refuses plaintext storage if keychain write fails.

## Model Registry (`ai_models.rs`)

Embedded default catalog: [`src-tauri/resources/ai-models.json`](../src-tauri/resources/ai-models.json) — single source of truth for models, providers, auto-resolution order, legacy ID mappings, and pricing.

User file: `~/.mim/models.json`. Created from defaults if missing. Migrated on version mismatch (re-syncs all defaults, preserves user-added custom models).

### Updating Models

Edit `ai-models.json` only — no JS, Rust, or doc changes needed.

1. Bump `version` (triggers migration on next launch)
2. Add or replace the model entry (id, provider, model, pricing, capabilities, control)
3. Update `autoOrder.chat` / `autoOrder.ghost` if the model participates in auto-resolution
4. Add old model ID to `legacyIds` if replacing a model (so saved sessions resolve correctly)
5. Rebuild the app — migration re-syncs `~/.mim/models.json` from embedded defaults
6. Verify: model appears in picker, auto-resolution works, pricing displays correctly

Where to find new model info: provider pricing page, model card (context window, capabilities), API docs (control options / thinking levels).

> **Note (2026-05-24):** The generic migration system was refactored in this version (v6). The first real model update using it should be verified carefully — confirm that `~/.mim/models.json` re-syncs correctly and that legacy IDs from `legacyIds` are properly cleaned up.

### Registry Structure

- `version` — integer, bumped on every model change to trigger migration
- `providers` — endpoint URLs and API key env vars per provider
- `autoOrder.chat` — priority list for `auto` model resolution (first with configured key wins)
- `autoOrder.ghost` — priority list for ghost/background model resolution
- `legacyIds` — maps retired model IDs to current ones (used by migration and `normalizeModelId`)
- `models[]` — full model configs: id, provider, pricing, capabilities, control options

### Control Mapping (sdkAdapter.js)

- **Anthropic effort** → adaptive thinking + `output_config.effort`
- **Anthropic thinking** (Haiku) → manual `budgetTokens`
- **OpenAI effort** → `reasoningEffort`
- **Google thinking** → `thinkingConfig.thinkingLevel`

### Provider Endpoints

- anthropic: `https://api.anthropic.com/v1/messages`
- openai: `https://api.openai.com/v1/responses`
- google: `https://generativelanguage.googleapis.com/v1beta/models`

## Streaming Proxy (`ai_proxy.rs`)

`ai_proxy_stream` receives: `correlationId`, `feature`, `provider`, `modelId`, `providerModel`, `url`, `headers`, `body`.

Resolves real API key, overwrites auth headers, validates URL host, starts reqwest stream.

Events emitted (Tauri):
- `ai-stream-chunk-{correlationId}` — raw provider bytes
- `ai-stream-done-{correlationId}` — stream complete
- `ai-stream-error-{correlationId}` — error (includes HTTP `status`)

Cancellation: `ai_abort(correlationId)` via tokio watch channel. Cleanup: `ai_cleanup(correlationId)`.

Always create Tauri event listeners before calling `ai_proxy_stream` (race condition otherwise).

## Non-Streaming Generation (`ai.rs`)

`ai_generate` for ghost/rewrite. Rejects `stream: true`.

Request: `{ correlationId, feature, modelId, system, messages, responseFormat, maxOutputTokens, temperature }`.

Response: `{ correlationId, feature, modelId, provider, providerModel, route, text, json, usage }`.

Route format: `direct:{keySource}` (e.g., `direct:keychain`).

## Rust-Native Providers (`ai_providers.rs`)

Only for `ai_generate`. Do not extend for chat/tool loops.

- Anthropic: adds `cache_control: { type: "ephemeral" }`. Supports thinking/effort control.
- OpenAI: maps to `input`/`instructions` format.
- Google: maps to `contents`/`systemInstruction`.

## Host Allowlist (`ai_transport.rs`)

Default: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`.

Plus any hosts from provider `endpointUrl` in the registry. Debug: localhost allowed.

90s timeout for `post_json`. `redact_error` strips key patterns (`sk-`, `sk-ant-`, `AIza`).

## Usage Ledger (`usage.rs`)

SQLite at `~/.mim/usage.db`. WAL mode.

Commands: `usage_record`, `usage_query_month`, `usage_query_daily`, `usage_query_month_csv`, `usage_get_setting`, `usage_set_setting`, `tool_execution_record`, `tool_execution_query`.

Budget gating: `usage_get_setting('budget_limit')` + `budget_fail_mode` (open/closed).

## Normalized Usage Shape

```js
{
  inputTokens, inputNoCacheTokens,
  cachedInputTokens,          // compat alias for cacheReadInputTokens
  cacheReadInputTokens, cacheWriteInputTokens,
  outputTokens, reasoningTokens, totalTokens,
  estimatedCost
}
```

Cost uses per-million pricing: `inputPerMillion`, `cacheReadInputPerMillion`, `cacheWriteInputPerMillion`, `outputPerMillion`. Unknown models fall back to normal input price for cached reads.

## Prompt Caching

- Anthropic: automatic via `cache_control: { type: 'ephemeral' }` in both paths (sdkAdapter.js + ai_providers.rs).
- OpenAI: automatic on recent models, no explicit enablement needed.
- Google: implicit automatic caching, no explicit cache resources.
- Detail: [plan-ai-caching.md](plan-ai-caching.md).

## Audit Events

`ai_proxy.rs` logs via `audit_log_internal()`: `ai.request`, `ai.complete`, `ai.abort`, `ai.error`.

## Data Root

```
~/.mim/
  models.json       # user model registry (created from defaults if missing)
  keys.env          # debug-build plaintext fallback only
  usage.db          # SQLite usage ledger
  audit.db          # SQLite audit log (see audit-system.md)
```

Debug builds also read repo `.env` (walks up 2 dirs) and process env vars.
