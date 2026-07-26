# AI system

This document maps the split renderer/Rust model path. It covers infrastructure
shared by inline rewrite and ghost completion; interaction behavior remains in
[inline-ai.md](inline-ai.md).

## Ownership map

| Concern | Owner |
|---|---|
| Product model/provider metadata and migration | `src-tauri/resources/ai-models.json`, `src-tauri/src/ai_models.rs` |
| Credential lookup/write | `src-tauri/src/ai_keys.rs` |
| Non-streaming generation | `src-tauri/src/ai.rs`, `ai_providers.rs`, `ai_transport.rs` |
| Streaming authenticated proxy | `src-tauri/src/ai_proxy.rs` |
| Usage normalization/cost | `src-tauri/src/ai_usage.rs`, provider parsers |
| Renderer registry/key API | `src/services/ai/client.js` |
| Model availability/default resolution | `src/services/ai/modelControls.js` |
| AI SDK fetch bridge | `src/services/ai/bridgeFetch.js`, `sdkAdapter.js` |
| Inline tool loop and prompt | `InlineAI.vue`, `inlineTransport.js`, `context.js` |
| Ghost request and CodeMirror lifecycle | `services/ai/ghost.js`, `editor/codemirror/ghost.js` |

## Registry semantics

`~/.mim/models.json` is a migrated registry, not a fully user-authoritative
copy. On load:

- missing/corrupt state is replaced from the embedded registry;
- an older version replaces known default models with embedded definitions;
- unknown custom models survive migration;
- provider URLs, feature default order, and legacy-id mapping are always
  synchronized from embedded defaults;
- known built-in provider models receive prompt-cache/pricing migration.

Changing product defaults therefore starts in
`src-tauri/resources/ai-models.json`; editing only a user's generated file or a
renderer menu is not durable product configuration.

Feature defaults are ordered lists (`chat`, `agent`, `rewrite`, `ghost`,
`extract`). Rust `resolve_model` chooses the first configured registry entry,
falling back to the first model. Renderer model controls additionally filter by
key availability before presenting/choosing a usable model.

`auto` is persisted as policy. Inline resolves `defaults.rewrite` for each
request; ghost resolves `defaults.ghost`. Do not replace stored `auto` with the
current first model or send the literal id upstream.

## Credential path

Provider configuration names an environment-variable key. `ai_keys.rs`
resolves keychain, environment, and debug-only fallback sources in that order.
Status reports the source but never returns the secret. Release builds refuse
plaintext persistence if keychain storage fails.

The renderer never adds the stored secret. Rust strips caller-supplied auth
headers and injects the resolved key in `ai_proxy.rs`, preventing a renderer
request from selecting an arbitrary credential.

## Two transport paths

Non-streaming ghost generation calls `ai_generate`:

```text
renderer request
  -> resolve registry model + provider
  -> resolve key
  -> provider-specific JSON builder
  -> host-validated reqwest POST
  -> provider response parser
  -> normalized usage/cost
```

Inline AI uses the AI SDK in the renderer but replaces its network fetch with
`bridgeFetch`:

```text
AI SDK request
  -> bridgeFetch correlation id + three listeners
  -> ai_proxy_stream
  -> Rust model/provider/key/host validation
  -> authenticated byte stream
  -> correlation-scoped chunk/done/error events
  -> Response stream consumed by AI SDK
```

`bridgeFetch` must register listeners before invoking the proxy. Abort signals
call `ai_abort`; final cleanup removes Rust session state and event listeners.
Rust preserves split UTF-8 sequences between upstream chunks and emits one
lossy final fragment only if the stream ends mid-character.

The proxy verifies requested provider matches the resolved model and only
connects to an allowlisted provider host. Debug builds additionally accept
`localhost`/`127.0.0.1`; release builds reject the same URL. Caller-provided
provider model is a legacy lookup fallback; stable model id is preferred.

## Provider normalization

`ai_providers.rs` is the only place non-streaming request/response formats
should diverge:

- Anthropic uses Messages, optional adaptive/budget thinking, and omits
  temperature when thinking is active.
- OpenAI uses Responses input, `store: false`, optional reasoning effort, and
  response text extraction across output items.
- Google builds `generateContent`, system instruction, thinking level, and
  optional JSON MIME response.

Provider usage is normalized into uncached input, cache read/write, output,
reasoning, total, and estimated cost. `cachedInputTokens` is a compatibility
alias synchronized to cache-read input. Pricing is registry metadata; fallback
cache multipliers exist for migrated entries.

## Inline tool loop

`InlineAI.vue` creates a new `Chat` transport when model/context changes. Its
system prompt contains escaped selection context and exposes a small renderer
tool set. `suggest_edit` produces a pending replacement; the Editor opens a
full-document diff and keeps the inline surface alive across rejection/follow-
up.

Inline selection is snapshotted at interaction start. Accept applies against
that range through the Editor; any change to proposal/diff ownership must be
reviewed with `useDiffReview.js` and the native proposal lifecycle.

## Ghost lifecycle

The CodeMirror extension, not the service, owns request validity. A suggestion
is bound to document position and request serial. Any unrelated edit or pointer
movement cancels/dismisses it. Authentication failures stay visible; other
provider failures may fall back to local suggestions.

Trigger parsing protects identifier-adjacent increment/C++ syntax. Key priority
matters: Alt+Right partial acceptance is evaluated before whole-suggestion
Right Arrow, and Enter dismissal must leave the normal editor command
available.

## Change map

| Change | Read together | Tests |
|---|---|---|
| Model/provider metadata | embedded registry, `ai_models.rs`, `modelControls.js` | Rust registry and JS model-control tests; smoke model options |
| Credential behavior | `ai_keys.rs`, Settings AI section | Rust key tests where available, client/settings tests |
| Provider payload/parsing | `ai_providers.rs`, `ai_usage.rs`, transport | Rust provider/usage tests |
| Streaming proxy | `ai_proxy.rs`, `bridgeFetch.js`, `sdkAdapter.js` | bridge/sdk adapter tests plus desktop abort smoke |
| Inline tools/prompt | `InlineAI.vue`, `inlineTransport.js`, `context.js` | InlineAI/context/transport tests |
| Ghost behavior | ghost service and CodeMirror extension | both ghost test suites |

See [security.md](security.md), [inline-ai.md](inline-ai.md), and
[persistence.md](persistence.md).
