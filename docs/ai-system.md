# AI system

Rust owns model metadata, credentials, provider validation, requests, and usage
normalization. Renderer owns feature prompts, selection UI, inline tools, and
stream consumption.

## Models and credentials

- Providers: `anthropic`, `openai`, `google` (`ai_providers.rs`). Unknown
  providers are rejected.
- Product defaults: `src-tauri/resources/ai-models.json` (embedded at build).
  Feature defaults (`chat`, `agent`, `rewrite`, `ghost`, `extract`) are ordered
  model lists.
- `~/.mimir/models.json` is migrated state: embedded changes replace known
  models; unknown custom models survive. Stored `auto` stays a policy; it resolves the
  current feature default per request.
- Credentials: Keychain, then process env, then debug-only `keys.env`/`.env`.
  Status never returns the secret; release writes require Keychain.

## Transport

- Ghost: native non-streaming path (`ai_generate` in `ai.rs`).
- Inline AI: renderer SDK through `bridgeFetch`/`sdkAdapter.js`, while Rust
  (`ai_proxy_stream`) validates model/provider/host, adds authentication, and
  streams correlated events.
- Register all stream listeners before starting the native request. Abort and
  completion remove both Rust session state and renderer listeners.
- `validate_url_host` accepts only approved provider hosts. Localhost is
  debug-only.
- Usage normalizes input, cache read/write, output, reasoning, total, and cost.

Native: `ai*.rs`. Renderer: `src/services/ai/`, Inline AI, CodeMirror ghost
extension. Interaction rules are in [inline-ai.md](inline-ai.md).
