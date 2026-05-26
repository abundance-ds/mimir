# AI Model Selection Decision

Status: implemented. Model menu, controls, and auto-resolution all live.

## Product Rule

Use two controls only:

```txt
Model
Effort / Thinking
```

- `Auto` is a model choice, not a thinking choice.
- If a model supports effort, the second control is `Effort`.
- If a model does not support effort, the second control is `Thinking`.
- Always pick a sensible default.
- Do not expose provider internals in normal labels.

## Model Menu

Models are rendered from [`ai-models.json`](../src-tauri/resources/ai-models.json), grouped by provider (Anthropic → Google → OpenAI), ordered large→small within each group. `Auto` appears first and resolves to the first model in `autoOrder.chat` with a configured API key.

## Second Control

Each model declares a `control` object in the JSON with `kind`, `default`, and `options`. The UI renders this as the second control (after model selection):

- **`kind: "effort"`** (Anthropic, OpenAI) — maps to provider-specific effort/reasoning params
- **`kind: "thinking"`** (Google, Haiku) — maps to thinking level or manual budget

See `sdkAdapter.js:buildProviderOptions()` for the exact provider mapping.

## API Constraints To Preserve

- Claude `Auto` thinking does not exist.
- Claude Opus/Sonnet effort is not a standalone thinking mode; it is output effort. In this product, any non-None effort enables adaptive thinking.
- Claude Opus 4.7 rejects manual `thinking: { type: "enabled" }`.
- Claude Sonnet 4.6 rejects `xhigh`.
- Claude Haiku 4.5 does not support adaptive thinking or effort.
- Manual Claude thinking needs `budget_tokens >= 1024` and `budget_tokens < max_tokens`.
- OpenAI Responses API rejects `max_output_tokens: 1`; minimum observed/required is `16`.
- Gemini accepts `maxOutputTokens: 1` for the proposed thinking levels.

## Test Plan Before Implementation

### 1. Direct Provider Schema Smoke

Use `scripts/smoke-ai-model-options.mjs`. It reads `.env`, sends direct provider requests, redacts keys/errors, and records:

- provider
- model
- option label
- exact request shape
- pass/fail
- response status
- raw usage fields
- estimated cost from registry pricing

Run all positive combinations:

- Claude Opus 4.7: None, Low, Medium, High, XHigh, Max.
- Claude Sonnet 4.6: None, Low, Medium, High, Max.
- Claude Haiku 4.5: None, Low, Medium, High.
- GPT-5.5: None, Low, Medium, High, XHigh.
- GPT-5.4: None, Low, Medium, High, XHigh.
- GPT-5.4 mini: None, Low, Medium, High, XHigh.
- GPT-5.4 nano: None, Low, Medium, High, XHigh.
- Gemini 3.5 Flash: Minimal, Low, Medium, High.
- Gemini 3.1 Pro: Low, Medium, High.
- Gemini 3.1 Flash-Lite: Minimal, Low, Medium, High.

Use `max_tokens` / `maxOutputTokens` / `max_output_tokens = 1` where valid.

Required exceptions:

- OpenAI positive tests use `max_output_tokens = 32`; `16` is the API minimum, but higher reasoning can fail provider-side when capped too tightly. Also run one expected-failure test with `1`.
- Haiku Low/Medium/High positive tests use `max_tokens = budget_tokens + 1`; also run one expected-failure test with `max_tokens = 1`.

### 2. Negative Provider Schema Smoke

- Claude Sonnet 4.6 + XHigh should fail or be hidden before request.
- Claude Opus 4.7 + manual budget should fail or be hidden before request.
- Claude Haiku 4.5 + adaptive should fail or be hidden before request.
- OpenAI + `max_output_tokens = 1` should fail.

### 3. App Infrastructure Smoke After Implementation

Use the Panel:

- `Auto` picks the first configured default in order.
- Missing-key providers are disabled or hidden consistently.
- Selecting a model changes the second control label/options/default.
- AI SDK provider options match direct-provider request shapes.
- Streaming still works.
- Tool loop still works.
- Stop/cancel still works.
- Usage normalization records input, cached input, cache writes, output, reasoning, total, and estimated cost.

### 4. Cost/Usage Verification

For each provider family:

- Check raw provider usage is present.
- Normalize into Shoulders usage shape.
- Estimate cost from registry pricing.
- Confirm no zero-cost output when output tokens are reported.
- Confirm cached-token fields do not break when absent.

## Source Docs

- Claude effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Claude extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Claude adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Claude messages: https://platform.claude.com/docs/en/build-with-claude/working-with-messages
- OpenAI models/pricing: https://developers.openai.com/api/docs/models
- Gemini models/pricing/thinking: https://ai.google.dev/gemini-api/docs/models, https://ai.google.dev/gemini-api/docs/pricing, https://ai.google.dev/gemini-api/docs/thinking
