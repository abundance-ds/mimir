# AI System Overview

Two request paths. Both resolve keys and enforce host allowlist in Rust. Never bypass Rust for provider HTTP.

## Architecture

```
Inline features (ghost, rewrite)
  Vue feature code → client.js → Tauri ai_generate → Rust provider adapter → HTTP → normalized response
```

```
Panel chat / tools / streaming / inline AI
  Vue stores → @ai-sdk/vue Chat → ToolLoopAgent + DirectChatTransport
  → bridgeFetch.js → Tauri ai_proxy_stream → Rust key resolve + host check + reqwest stream
  → raw provider bytes back to AI SDK
```

AI SDK owns: provider wire formats, tool-call protocol, streaming parsing, ToolLoopAgent steps, UI message parts.
Rust owns: API key resolution, auth header replacement, host allowlist, stream cancellation, audit logging.

JS uses dummy auth (`shoulders-local-key`). Rust overwrites `authorization`, `x-api-key`, `x-goog-api-key` before upstream.

## Docs Map

| Doc | Scope |
|-----|-------|
| [ai-infra.md](ai-infra.md) | Rust backend: keys, transport, proxy, models, providers, usage ledger |
| [ai-chat.md](ai-chat.md) | Panel chat + tools: SDK integration, tool modules, gate, prompts, resilience |
| [inline-ai.md](inline-ai.md) | Cmd+K inline assistant: transport, tools, diff integration |
| [skills-system.md](skills-system.md) | File-based skill packages, progressive disclosure, SKILL.md format |
| [apps-system.md](apps-system.md) | App platform: standard-UI (run + timeline) and custom-UI (iframe + SDK) |
| [ai-sdk-vue-integration.md](ai-sdk-vue-integration.md) | Chat class reactivity, Chat Map pattern, persistence |
| [permissions.md](permissions.md) | Path access tiers, approval modes, tool gating policy |
| [proposal-bridge.md](proposal-bridge.md) | Cross-window proposal relay, text matching |
| [ai-model-selection.md](ai-model-selection.md) | Model/control decision record, API constraints, test plan |
| [plan-ai-caching.md](plan-ai-caching.md) | Prompt caching decision and status |
| [gotchas.md](gotchas.md) | Non-obvious constraints (check before any AI change) |

## Security Rules

- Never pass real API keys to AI SDK provider constructors.
- Never call provider APIs with browser `fetch` directly.
- Host validation lives in Rust — do not duplicate in JS.
- `.env` and `keys.env` are debug-build fallbacks only.
- Tool execution is gated by `withGate()` — audit, approval, output cap.

## Extension Checklists

**Add a model:** Edit `src-tauri/resources/ai-models.json` only — bump `version`, update model entry, update `autoOrder`/`legacyIds` as needed → rebuild.

**Add a provider:** Add to `ai-models.json` → JS provider construction in `sdkAdapter.js` → Rust auth/header in `ai_proxy.rs` → Rust direct adapter in `ai_providers.rs` (only if ghost/rewrite need it) → extend host allowlist.

**Add a tool:** Add `tool()` + `registerTool()` in the appropriate module under `src/services/ai/tools/` → the module's factory is already imported by `index.js` → set `requiresApproval: true` for destructive tools → update ai-chat.md.

## Verification

```bash
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --release
bun run test
```

## Current Limits

- No enterprise policy engine (per-project tool whitelist exists, not centralized).
- No hosted Shoulders proxy route.
- Rust-native `ai_generate` does not stream.
