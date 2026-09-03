# AI system

Rust owns model metadata, credentials, provider validation, requests, and usage
normalization. The renderer owns feature prompts, selection UI, inline tools,
and stream consumption.

## Models and credentials

- Product defaults start in `src-tauri/resources/ai-models.json`.
- `~/.mimir/models.json` is migrated state: embedded changes update known
  models while unknown custom models survive.
- Feature defaults are ordered model lists. Stored `auto` remains a policy and
  resolves the current feature default for each request.
- Credentials resolve from Keychain, process environment, then debug-only
  fallback files. Status never returns the secret; release writes require
  Keychain.

## Transport

- Ghost generation uses the native non-streaming provider path.
- Inline AI uses the renderer SDK through `bridgeFetch`, while Rust validates
  model/provider/host, adds authentication, and streams correlated events.
- Register all stream listeners before starting the native request. Abort and
  completion remove both Rust session state and renderer listeners.
- Release accepts only approved provider hosts. Localhost is debug-only.
- Provider-specific request and response formats stay in `ai_providers.rs`.
  Usage normalizes input, cache read/write, output, reasoning, total, and cost.

Native ownership is `ai_models.rs`, `ai_keys.rs`, `ai.rs`, `ai_proxy.rs`,
`ai_providers.rs`, `ai_transport.rs`, and `ai_usage.rs`. Renderer ownership is
`src/services/ai/`, Inline AI, and the CodeMirror ghost extension. Interaction
rules are in [inline-ai.md](inline-ai.md).
