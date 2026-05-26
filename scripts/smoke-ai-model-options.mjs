#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const ENV = loadEnv(path.join(ROOT, '.env'))
const OUT = path.join(ROOT, 'tmp', 'ai-smoke-results.json')
const PROMPT = 'Reply exactly: OK'
const RUN_NEGATIVE = process.argv.includes('--negative') || process.argv.includes('--all')
const ONLY = argValue('--only')

const keys = {
  anthropic: ENV.ANTHROPIC_API_KEY,
  openai: ENV.OPENAI_API_KEY,
  google: ENV.GOOGLE_API_KEY,
}

const priceSources = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/models',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
}

const models = {
  'claude-opus-4-7': price('anthropic', 5, 0.5, 6.25, 25),
  'claude-sonnet-4-6': price('anthropic', 3, 0.3, 3.75, 15),
  'claude-haiku-4-5-20251001': price('anthropic', 1, 0.1, 1.25, 5),
  'gpt-5.5': price('openai', 5, 0.5, 0, 30),
  'gpt-5.4': price('openai', 2.5, 0.25, 0, 15),
  'gpt-5.4-mini': price('openai', 0.75, 0.075, 0, 4.5),
  'gpt-5.4-nano': price('openai', 0.2, 0.02, 0, 1.25),
  'gemini-3-flash-preview': price('google', 0.5, 0.05, 0, 3),
  'gemini-3.1-pro-preview': price('google', 2, 0.2, 0, 12),
  'gemini-3.1-flash-lite': price('google', 0.25, 0.025, 0, 1.5),
}

const positiveTests = [
  ...anthropicEffortTests('claude-opus-4-7', ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
  ...anthropicEffortTests('claude-sonnet-4-6', ['none', 'low', 'medium', 'high', 'max']),
  ...anthropicHaikuTests('claude-haiku-4-5-20251001'),
  ...openAiTests('gpt-5.5'),
  ...openAiTests('gpt-5.4'),
  ...openAiTests('gpt-5.4-mini'),
  ...openAiTests('gpt-5.4-nano'),
  ...googleTests('gemini-3-flash-preview', ['minimal', 'low', 'medium', 'high']),
  ...googleTests('gemini-3.1-pro-preview', ['low', 'medium', 'high']),
  ...googleTests('gemini-3.1-flash-lite', ['minimal', 'low', 'medium', 'high']),
]

const negativeTests = [
  anthropicInvalid('claude-sonnet-4-6', 'xhigh', 'Sonnet rejects xhigh'),
  anthropicManualInvalid('claude-opus-4-7', 1024, 'Opus 4.7 rejects manual budget'),
  anthropicAdaptiveInvalid('claude-haiku-4-5-20251001', 'Haiku rejects adaptive'),
  openAiInvalidMaxOutput('gpt-5.4', 'OpenAI rejects max_output_tokens=1'),
  anthropicHaikuInvalidMaxOutput('claude-haiku-4-5-20251001', 'Haiku manual thinking needs max_tokens > budget_tokens'),
]

let tests = RUN_NEGATIVE ? [...positiveTests, ...negativeTests] : positiveTests
if (ONLY) tests = tests.filter((test) => test.provider === ONLY || test.model === ONLY)

console.log(`keys anthropic=${Boolean(keys.anthropic)} openai=${Boolean(keys.openai)} google=${Boolean(keys.google)}`)
console.log(`running ${tests.length} tests${RUN_NEGATIVE ? ' including expected failures' : ''}`)

const results = []
for (const test of tests) {
  if (!keys[test.provider]) {
    results.push({ ...baseResult(test), ok: false, skipped: true, error: `missing ${test.provider} key` })
    printResult(results.at(-1))
    continue
  }

  const started = Date.now()
  let outcome
  try {
    outcome = await test.run()
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) }
  }
  const usage = normalizeUsage(test.provider, outcome.json)
  const cost = estimateCost(models[test.model], usage)
  const result = {
    ...baseResult(test),
    ok: Boolean(outcome.ok),
    expectedFailurePassed: Boolean(test.expectFailure && !outcome.ok),
    unexpectedPass: Boolean(test.expectFailure && outcome.ok),
    unexpectedFailure: Boolean(!test.expectFailure && !outcome.ok),
    status: outcome.status,
    ms: Date.now() - started,
    error: outcome.ok ? null : redact(outcome.error || ''),
    usage,
    estimatedCostUsd: cost,
    usagePresent: hasUsage(usage),
    priceSource: priceSources[test.provider],
    requestShape: test.shape,
  }
  results.push(result)
  printResult(result)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2)}\n`)

const summary = summarize(results)
console.log('\nsummary')
console.log(JSON.stringify(summary, null, 2))
console.log(`wrote ${OUT}`)
process.exit(summary.unexpectedFailure || summary.unexpectedPass || summary.skipped ? 1 : 0)

function anthropicEffortTests(model, levels) {
  return levels.map((level) => ({
    provider: 'anthropic',
    model,
    option: title(level),
    kind: 'positive',
    shape: level === 'none'
      ? { max_tokens: 1, thinking: { type: 'disabled' } }
      : { max_tokens: 1, thinking: { type: 'adaptive' }, output_config: { effort: level } },
    run: () => callAnthropic(model, anthropicBody(model, level)),
  }))
}

function anthropicHaikuTests(model) {
  const levels = [
    ['none', null],
    ['low', 1024],
    ['medium', 4096],
    ['high', 8192],
  ]
  return levels.map(([level, budget]) => ({
    provider: 'anthropic',
    model,
    option: title(level),
    kind: 'positive',
    shape: budget == null
      ? { max_tokens: 1, thinking: { type: 'disabled' } }
      : { max_tokens: budget + 1, thinking: { type: 'enabled', budget_tokens: budget } },
    run: () => callAnthropic(model, budget == null ? anthropicBody(model, 'none') : anthropicManualBody(model, budget, budget + 1)),
  }))
}

function openAiTests(model) {
  return ['none', 'low', 'medium', 'high', 'xhigh'].map((effort) => ({
    provider: 'openai',
    model,
    option: title(effort),
    kind: 'positive',
    shape: { max_output_tokens: 32, reasoning: { effort } },
    run: () => callOpenAI(model, effort, 32),
  }))
}

function googleTests(model, levels) {
  return levels.map((level) => ({
    provider: 'google',
    model,
    option: title(level),
    kind: 'positive',
    shape: { generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingLevel: level } } },
    run: () => callGoogle(model, level, 1),
  }))
}

function anthropicInvalid(model, effort, reason) {
  return {
    provider: 'anthropic',
    model,
    option: `invalid ${effort}`,
    kind: 'negative',
    expectFailure: true,
    reason,
    shape: { max_tokens: 1, thinking: { type: 'adaptive' }, output_config: { effort } },
    run: () => callAnthropic(model, anthropicBody(model, effort)),
  }
}

function anthropicManualInvalid(model, budget, reason) {
  return {
    provider: 'anthropic',
    model,
    option: `invalid manual ${budget}`,
    kind: 'negative',
    expectFailure: true,
    reason,
    shape: { max_tokens: budget + 1, thinking: { type: 'enabled', budget_tokens: budget } },
    run: () => callAnthropic(model, anthropicManualBody(model, budget, budget + 1)),
  }
}

function anthropicAdaptiveInvalid(model, reason) {
  return {
    provider: 'anthropic',
    model,
    option: 'invalid adaptive',
    kind: 'negative',
    expectFailure: true,
    reason,
    shape: { max_tokens: 1, thinking: { type: 'adaptive' } },
    run: () => callAnthropic(model, { model, max_tokens: 1, thinking: { type: 'adaptive' }, messages: userMessages() }),
  }
}

function openAiInvalidMaxOutput(model, reason) {
  return {
    provider: 'openai',
    model,
    option: 'invalid max_output_tokens 1',
    kind: 'negative',
    expectFailure: true,
    reason,
    shape: { max_output_tokens: 1, reasoning: { effort: 'medium' } },
    run: () => callOpenAI(model, 'medium', 1),
  }
}

function anthropicHaikuInvalidMaxOutput(model, reason) {
  return {
    provider: 'anthropic',
    model,
    option: 'invalid manual max_tokens 1',
    kind: 'negative',
    expectFailure: true,
    reason,
    shape: { max_tokens: 1, thinking: { type: 'enabled', budget_tokens: 1024 } },
    run: () => callAnthropic(model, anthropicManualBody(model, 1024, 1)),
  }
}

function anthropicBody(model, level) {
  const body = { model, max_tokens: 1, messages: userMessages() }
  if (level === 'none') {
    body.thinking = { type: 'disabled' }
  } else {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort: level }
  }
  return body
}

function anthropicManualBody(model, budget, maxTokens) {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'enabled', budget_tokens: budget },
    messages: userMessages(),
  }
}

async function callAnthropic(model, body) {
  return postJson('https://api.anthropic.com/v1/messages', {
    'content-type': 'application/json',
    'x-api-key': keys.anthropic,
    'anthropic-version': '2023-06-01',
  }, body)
}

async function callOpenAI(model, effort, maxOutputTokens) {
  return postJson('https://api.openai.com/v1/responses', {
    'content-type': 'application/json',
    authorization: `Bearer ${keys.openai}`,
  }, {
    model,
    input: PROMPT,
    max_output_tokens: maxOutputTokens,
    store: false,
    reasoning: { effort },
  })
}

async function callGoogle(model, thinkingLevel, maxOutputTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(keys.google)}`
  return postJson(url, { 'content-type': 'application/json' }, {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      maxOutputTokens: maxOutputTokens,
      thinkingConfig: { thinkingLevel },
    },
  })
}

async function postJson(url, headers, body) {
  let last = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch {}
      if (response.ok) return { ok: true, status: response.status, json, attempts: attempt + 1 }
      last = {
        ok: false,
        status: response.status,
        json,
        attempts: attempt + 1,
        error: json?.error?.message || json?.error?.status || json?.message || text,
      }
      if (response.status < 500 || attempt === 2) return last
    } catch (error) {
      last = { ok: false, attempts: attempt + 1, error: error?.message || String(error) }
      if (attempt === 2) return last
    }
    await sleep(500 * (attempt + 1))
  }
  return last
}

function normalizeUsage(provider, json) {
  if (provider === 'anthropic') {
    const usage = json?.usage || {}
    const input = num(usage.input_tokens)
    const cacheRead = num(usage.cache_read_input_tokens)
    const cacheWrite = num(usage.cache_creation_input_tokens)
    const output = num(usage.output_tokens)
    return {
      inputTokens: input + cacheRead + cacheWrite,
      inputNoCacheTokens: input,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: 0,
      totalTokens: input + cacheRead + cacheWrite + output,
      raw: usage,
    }
  }
  if (provider === 'openai') {
    const usage = json?.usage || {}
    const input = num(usage.input_tokens)
    const cached = num(usage.input_tokens_details?.cached_tokens)
    const output = num(usage.output_tokens)
    const reasoning = num(usage.output_tokens_details?.reasoning_tokens)
    return {
      inputTokens: input,
      inputNoCacheTokens: Math.max(0, input - cached),
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: num(usage.total_tokens) || input + output,
      raw: usage,
    }
  }
  if (provider === 'google') {
    const usage = json?.usageMetadata || {}
    const input = num(usage.promptTokenCount)
    const cached = num(usage.cachedContentTokenCount)
    const candidates = num(usage.candidatesTokenCount)
    const thoughts = num(usage.thoughtsTokenCount)
    const output = candidates + thoughts
    return {
      inputTokens: input,
      inputNoCacheTokens: Math.max(0, input - cached),
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningTokens: thoughts,
      totalTokens: num(usage.totalTokenCount) || input + output,
      raw: usage,
    }
  }
  return emptyUsage()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function estimateCost(modelPrice, usage) {
  if (!modelPrice) return 0
  return roundMoney(
    usage.inputNoCacheTokens / 1_000_000 * modelPrice.input +
    usage.cacheReadInputTokens / 1_000_000 * modelPrice.cacheRead +
    usage.cacheWriteInputTokens / 1_000_000 * modelPrice.cacheWrite +
    usage.outputTokens / 1_000_000 * modelPrice.output
  )
}

function price(provider, input, cacheRead, cacheWrite, output) {
  return { provider, input, cacheRead, cacheWrite, output }
}

function loadEnv(envPath) {
  const env = { ...process.env }
  if (!fs.existsSync(envPath)) return env
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!env[key]) env[key] = value
  }
  return env
}

function userMessages() {
  return [{ role: 'user', content: PROMPT }]
}

function baseResult(test) {
  return {
    provider: test.provider,
    model: test.model,
    option: test.option,
    kind: test.kind,
    expectFailure: Boolean(test.expectFailure),
    reason: test.reason || null,
  }
}

function printResult(result) {
  const status = result.skipped ? 'SKIP' : result.expectedFailurePassed ? 'EXPECTED_FAIL' : result.ok ? 'PASS' : 'FAIL'
  const usage = result.usagePresent ? `in=${result.usage.inputTokens} out=${result.usage.outputTokens} total=${result.usage.totalTokens}` : 'usage=none'
  const cost = Number.isFinite(result.estimatedCostUsd) ? `cost=$${result.estimatedCostUsd.toFixed(8)}` : 'cost=n/a'
  const error = result.error ? ` error=${result.error}` : ''
  console.log(`${status}\t${result.provider}\t${result.model}\t${result.option}\t${result.ms ?? 0}ms\t${usage}\t${cost}${error}`)
}

function summarize(results) {
  return {
    total: results.length,
    pass: results.filter((result) => result.ok && !result.expectFailure).length,
    expectedFailure: results.filter((result) => result.expectedFailurePassed).length,
    unexpectedFailure: results.filter((result) => result.unexpectedFailure).length,
    unexpectedPass: results.filter((result) => result.unexpectedPass).length,
    skipped: results.filter((result) => result.skipped).length,
    usageMissing: results.filter((result) => !result.expectFailure && result.ok && !result.usagePresent).length,
    resultPath: OUT,
  }
}

function hasUsage(usage) {
  return Boolean(usage && (usage.inputTokens || usage.outputTokens || usage.totalTokens))
}

function emptyUsage() {
  return {
    inputTokens: 0,
    inputNoCacheTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    raw: {},
  }
}

function redact(value) {
  return String(value || '').replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 260)
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 1_000_000_000_000) / 1_000_000_000_000
}

function title(value) {
  if (value === 'xhigh') return 'XHigh'
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function argValue(name) {
  const exact = process.argv.indexOf(name)
  if (exact >= 0) return process.argv[exact + 1]
  const prefix = `${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : ''
}
