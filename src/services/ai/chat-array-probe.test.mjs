#!/usr/bin/env node
/**
 * chat-array-probe.test.mjs — exhaustive AI SDK v6 message format probe
 *
 * Tests every edge case of UIMessage → convertToModelMessages → generateText.
 * Run: node src/services/ai/chat-array-probe.test.mjs
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
const envPath = resolve(process.cwd(), '.env')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/)
    if (m) process.env[m[1]] = m[2].trim()
  }
} catch {}

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText, tool, convertToModelMessages } from 'ai'
import { z } from 'zod'

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })
const models = {
  claude: anthropic('claude-haiku-4-5-20251001'),
  gpt: openai('gpt-5.4-nano'),
  gemini: google('gemini-3.1-flash-lite'),
}

const echoTool = tool({
  description: 'echo', inputSchema: z.object({ msg: z.string() }),
  execute: async ({ msg }) => ({ echo: msg }),
})

const ALL = ['claude', 'gpt', 'gemini']
const results = []
function uid() { return 'm' + Math.random().toString(36).slice(2, 8) }

// ---- UIMessage builders ----
function u(text) { return { id: uid(), role: 'user', parts: [{ type: 'text', text }] } }
function a(text) { return { id: uid(), role: 'assistant', parts: [{ type: 'text', text }] } }
function aTool(opts) {
  const p = { type: opts.type || `tool-${opts.name || 'echo'}`, toolCallId: opts.id || uid(), toolName: opts.name || 'echo', state: opts.state || 'output-available' }
  if ('input' in opts) p.input = opts.input
  if ('output' in opts) p.output = opts.output
  if ('errorText' in opts) p.errorText = opts.errorText
  return { id: uid(), role: 'assistant', parts: [...(opts.prefixParts || []), p, ...(opts.suffixParts || [])] }
}

// ---- Test runner ----
// Runs UIMessages through convert → API for all 3 providers
async function probe(label, uiMessages, opts = {}) {
  // Step 1: convert
  let core
  try {
    core = await convertToModelMessages(uiMessages, opts.convertOpts || {})
    const summary = core.map(m => `${m.role}(${Array.isArray(m.content) ? m.content.map(p => p.type || 'str').join('+') : 'str'})`).join('→')
    results.push({ id: `[convert] ${label}`, status: 'OK', detail: summary })
  } catch (e) {
    results.push({ id: `[convert] ${label}`, status: 'FAIL', detail: e.message })
    return
  }

  // Step 2: send to APIs (in parallel)
  if (opts.skipApi) return
  await Promise.all(ALL.map(async (name) => {
    try {
      await generateText({ model: models[name], maxTokens: 1, tools: { echo: echoTool }, messages: core })
      results.push({ id: `[${name}] ${label}`, status: 'OK' })
    } catch (e) {
      const msg = e?.message || String(e)
      const isApi = msg.includes('400') || msg.includes('invalid_request') || msg.includes('INVALID_ARGUMENT') || msg.includes('content blocks')
      results.push({ id: `[${name}] ${label}`, status: 'FAIL', detail: `${isApi ? 'API' : 'SDK'}: ${msg.slice(0, 200)}` })
    }
  }))
}

async function main() {
  console.log('Chat Array Probe — exhaustive edge cases\n')

  // ═══════════════════════════════════════════════════════════
  // 1. ROLE ORDERING
  // ═══════════════════════════════════════════════════════════
  await probe('role: normal user→assistant→user', [u('a'), a('b'), u('c')])
  await probe('role: two users in a row', [u('a'), u('b')])
  await probe('role: two assistants in a row', [u('a'), a('x'), a('y'), u('b')])
  await probe('role: assistant first', [a('hi'), u('hello')])
  await probe('role: ends with assistant', [u('a'), a('b')])
  await probe('role: 5 users in a row', [u('1'), u('2'), u('3'), u('4'), u('5')])
  await probe('role: user→assistant→assistant→assistant→user', [u('a'), a('x'), a('y'), a('z'), u('b')])
  await probe('role: only assistant', [a('alone')])
  await probe('role: only user', [u('alone')])

  // ═══════════════════════════════════════════════════════════
  // 2. EMPTY / NULL / MISSING CONTENT
  // ═══════════════════════════════════════════════════════════
  await probe('empty: user text ""', [u('')])
  await probe('empty: assistant text ""', [u('a'), a(''), u('b')])
  await probe('empty: whitespace-only user "   "', [u('   ')])
  await probe('empty: whitespace-only assistant', [u('a'), a('   '), u('b')])
  await probe('empty: user parts []', [{ id: uid(), role: 'user', parts: [] }])
  await probe('empty: assistant parts []', [u('a'), { id: uid(), role: 'assistant', parts: [] }, u('b')])
  await probe('empty: messages array []', [])
  await probe('null: parts null', [u('a'), { id: uid(), role: 'assistant', parts: null }, u('b')])
  await probe('null: parts undefined (missing)', [u('a'), { id: uid(), role: 'assistant' }, u('b')])
  await probe('null: text part text is null', [u('a'), { id: uid(), role: 'assistant', parts: [{ type: 'text', text: null }] }, u('b')])
  await probe('null: text part text is undefined', [u('a'), { id: uid(), role: 'assistant', parts: [{ type: 'text', text: undefined }] }, u('b')])
  await probe('null: text part text is number', [u('a'), { id: uid(), role: 'assistant', parts: [{ type: 'text', text: 123 }] }, u('b')])
  await probe('null: message id is null', [{ id: null, role: 'user', parts: [{ type: 'text', text: 'hi' }] }])
  await probe('null: message id is undefined', [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }])
  await probe('null: null in messages array', [u('a'), null, u('b')])
  await probe('null: undefined in messages array', [u('a'), undefined, u('b')])
  await probe('null: null in parts array', [u('a'), { id: uid(), role: 'assistant', parts: [null, { type: 'text', text: 'x' }] }, u('b')])

  // ═══════════════════════════════════════════════════════════
  // 3. TOOL CALL LIFECYCLE STATES
  // ═══════════════════════════════════════════════════════════
  await probe('tool: output-available, valid', [u('x'), aTool({ id: 'tc1', input: { msg: 'hi' }, output: { echo: 'hi' } }), u('ok')])
  await probe('tool: output-error, valid input', [u('x'), aTool({ id: 'tc2', input: { msg: 'hi' }, state: 'output-error', errorText: 'denied' }), u('ok')])
  await probe('tool: output-error, empty input {}', [u('x'), aTool({ id: 'tc3', input: {}, state: 'output-error', errorText: 'failed' }), u('ok')])
  await probe('tool: output-error, undefined input', [u('x'), aTool({ id: 'tc4', state: 'output-error', errorText: 'failed' }), u('ok')])
  await probe('tool: output-error, null input', [u('x'), aTool({ id: 'tc5', input: null, state: 'output-error', errorText: 'failed' }), u('ok')])
  await probe('tool: input-available (stuck)', [u('x'), aTool({ id: 'tc6', input: { msg: 'hi' }, state: 'input-available' }), u('ok')])
  await probe('tool: input-streaming (stuck)', [u('x'), aTool({ id: 'tc7', input: { msg: 'pa' }, state: 'input-streaming' }), u('ok')])
  await probe('tool: input-available + ignoreIncomplete', [u('x'), aTool({ id: 'tc8', input: { msg: 'hi' }, state: 'input-available' }), u('ok')], { convertOpts: { ignoreIncompleteToolCalls: true } })
  await probe('tool: output-denied state', [u('x'), aTool({ id: 'tc9', input: { msg: 'hi' }, state: 'output-denied', errorText: 'user rejected' }), u('ok')])
  await probe('tool: bogus state "pending"', [u('x'), aTool({ id: 'tc10', input: { msg: 'hi' }, state: 'pending' }), u('ok')])
  await probe('tool: bogus state "cancelled"', [u('x'), aTool({ id: 'tc11', input: { msg: 'hi' }, state: 'cancelled' }), u('ok')])
  await probe('tool: state undefined', [u('x'), aTool({ id: 'tc12', input: { msg: 'hi' }, state: undefined }), u('ok')])

  // ═══════════════════════════════════════════════════════════
  // 4. TOOL INPUT SHAPES
  // ═══════════════════════════════════════════════════════════
  await probe('tool-input: string', [u('x'), aTool({ id: 'ti1', input: 'raw string', output: {} }), u('ok')])
  await probe('tool-input: number', [u('x'), aTool({ id: 'ti2', input: 42, output: {} }), u('ok')])
  await probe('tool-input: array', [u('x'), aTool({ id: 'ti3', input: ['a', 'b'], output: {} }), u('ok')])
  await probe('tool-input: boolean', [u('x'), aTool({ id: 'ti4', input: true, output: {} }), u('ok')])
  await probe('tool-input: deeply nested (10 levels)', [u('x'), aTool({ id: 'ti5', input: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'deep' } } } } } } } } } }, output: {} }), u('ok')])
  await probe('tool-input: extra fields beyond schema', [u('x'), aTool({ id: 'ti6', input: { msg: 'hi', extra: true, nested: { x: 1 } }, output: {} }), u('ok')])

  // ═══════════════════════════════════════════════════════════
  // 5. TOOL OUTPUT SHAPES
  // ═══════════════════════════════════════════════════════════
  await probe('tool-output: string', [u('x'), aTool({ id: 'to1', input: { msg: 'hi' }, output: 'just text' }), u('ok')])
  await probe('tool-output: null', [u('x'), aTool({ id: 'to2', input: { msg: 'hi' }, output: null }), u('ok')])
  await probe('tool-output: undefined (missing)', [u('x'), aTool({ id: 'to3', input: { msg: 'hi' } }), u('ok')])
  await probe('tool-output: empty {}', [u('x'), aTool({ id: 'to4', input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-output: number', [u('x'), aTool({ id: 'to5', input: { msg: 'hi' }, output: 42 }), u('ok')])
  await probe('tool-output: array', [u('x'), aTool({ id: 'to6', input: { msg: 'hi' }, output: [1, 2, 3] }), u('ok')])
  await probe('tool-output: huge (50KB)', [u('x'), aTool({ id: 'to7', input: { msg: 'hi' }, output: { data: 'x'.repeat(50000) } }), u('ok')])
  await probe('tool-output: both output AND errorText set', [u('x'), aTool({ id: 'to8', input: { msg: 'hi' }, output: { echo: 'hi' }, errorText: 'but also error' }), u('ok')])

  // ═══════════════════════════════════════════════════════════
  // 6. TOOL ID / NAME EDGE CASES
  // ═══════════════════════════════════════════════════════════
  await probe('tool-id: empty string ""', [u('x'), aTool({ id: '', input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-id: null', [u('x'), aTool({ id: null, input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-id: undefined', [u('x'), aTool({ id: undefined, input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-name: empty string', [u('x'), aTool({ name: '', id: 'tn1', input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-name: doesnt exist in tools', [u('x'), aTool({ name: 'nonexistent', id: 'tn2', input: { foo: 1 }, output: { x: 1 } }), u('ok')])
  await probe('tool-type: dynamic-tool instead of tool-name', [u('x'), aTool({ type: 'dynamic-tool', name: 'echo', id: 'tn3', input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-type: mismatched type vs name', [u('x'), aTool({ type: 'tool-search', name: 'echo', id: 'tn4', input: { msg: 'hi' }, output: {} }), u('ok')])
  await probe('tool-id: duplicate IDs across messages', [
    u('x'),
    aTool({ id: 'DUPE', input: { msg: 'a' }, output: { echo: 'a' } }),
    u('y'),
    aTool({ id: 'DUPE', input: { msg: 'b' }, output: { echo: 'b' } }),
    u('z'),
  ])
  await probe('tool-id: duplicate IDs same message', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'SAME', toolName: 'echo', state: 'output-available', input: { msg: 'a' }, output: { echo: 'a' } },
      { type: 'tool-echo', toolCallId: 'SAME', toolName: 'echo', state: 'output-available', input: { msg: 'b' }, output: { echo: 'b' } },
    ]},
    u('ok'),
  ])

  // ═══════════════════════════════════════════════════════════
  // 7. TOOL CALL/RESULT PAIRING
  // ═══════════════════════════════════════════════════════════
  await probe('pair: call with no result, conversation continues', [
    u('x'),
    aTool({ id: 'pr1', input: { msg: 'hi' }, state: 'input-available' }),
    u('skip it'),
    a('ok'),
    u('ok'),
  ])
  await probe('pair: result for call from 3 turns ago', [
    u('x'),
    aTool({ id: 'pr2', input: { msg: 'old' }, output: { echo: 'old' } }),
    u('y'),
    a('text'),
    u('z'),
    // This tool references an old call ID but is a new call — different scenario
    aTool({ id: 'pr3', input: { msg: 'new' }, output: { echo: 'new' } }),
    u('ok'),
  ])
  await probe('pair: two calls in one msg, both have results', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'mc1', toolName: 'echo', state: 'output-available', input: { msg: 'a' }, output: { echo: 'a' } },
      { type: 'tool-echo', toolCallId: 'mc2', toolName: 'echo', state: 'output-available', input: { msg: 'b' }, output: { echo: 'b' } },
    ]},
    u('ok'),
  ])
  await probe('pair: two calls, first ok second error', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'mc3', toolName: 'echo', state: 'output-available', input: { msg: 'a' }, output: { echo: 'a' } },
      { type: 'tool-echo', toolCallId: 'mc4', toolName: 'echo', state: 'output-error', input: { msg: 'b' }, errorText: 'boom' },
    ]},
    u('ok'),
  ])
  await probe('pair: two calls, first ok second stuck', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'mc5', toolName: 'echo', state: 'output-available', input: { msg: 'a' }, output: { echo: 'a' } },
      { type: 'tool-echo', toolCallId: 'mc6', toolName: 'echo', state: 'input-available', input: { msg: 'b' } },
    ]},
    u('ok'),
  ])
  await probe('pair: conversation ends mid-tool-call (no result, no followup)', [
    u('x'),
    aTool({ id: 'pr_end', input: { msg: 'hi' }, state: 'input-available' }),
  ])

  // ═══════════════════════════════════════════════════════════
  // 8. MIXED / MULTI-PART MESSAGES
  // ═══════════════════════════════════════════════════════════
  await probe('mixed: text + tool in same msg', [
    u('x'),
    aTool({ id: 'mx1', input: { msg: 'hi' }, output: { echo: 'hi' }, prefixParts: [{ type: 'text', text: 'calling...' }] }),
    u('ok'),
  ])
  await probe('mixed: step-start + text', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'hello' }] },
    u('ok'),
  ])
  await probe('mixed: step-start only (no text)', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'step-start' }] },
    u('ok'),
  ])
  await probe('mixed: reasoning only (no text)', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'reasoning', text: 'thinking hard' }] },
    u('ok'),
  ])
  await probe('mixed: reasoning + tool + text', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'reasoning', text: 'I should call echo' },
      { type: 'tool-echo', toolCallId: 'mx_rt', toolName: 'echo', state: 'output-available', input: { msg: 'hi' }, output: { echo: 'hi' } },
      { type: 'text', text: 'Done.' },
    ]},
    u('ok'),
  ])
  await probe('mixed: reasoning with empty text ""', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'x' }] },
    u('ok'),
  ])
  await probe('mixed: multiple step-starts', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'step 1' }, { type: 'step-start' }, { type: 'text', text: 'step 2' }] },
    u('ok'),
  ])
  await probe('mixed: unknown part type', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'audio', data: 'base64...' }, { type: 'text', text: 'hi' }] },
    u('ok'),
  ])

  // ═══════════════════════════════════════════════════════════
  // 9. SANITIZER OUTPUT SHAPES (what our code produces)
  // ═══════════════════════════════════════════════════════════
  await probe('sanitizer: text replacing broken tool', [u('hi'), a('[Tool call: run_command — failed]'), u('ok')])
  await probe('sanitizer: text + later valid tool call', [
    u('hi'),
    a('[Tool call: run_command — failed]'),
    u('try echo'),
    aTool({ id: 'san1', input: { msg: 'test' }, output: { echo: 'test' } }),
    u('ok'),
  ])
  await probe('sanitizer: multiple sanitized texts in history', [
    u('first'),
    a('[Tool call: run_command — failed]'),
    u('second'),
    a('[Tool call: run_command — timeout]'),
    u('third'),
    a('[Tool call: search — error]'),
    u('fourth'),
  ])
  await probe('sanitizer: sanitized + error tool + valid tool', [
    u('a'),
    a('[Tool call: old_tool — removed]'),
    u('b'),
    aTool({ id: 'san2', input: { msg: 'x' }, state: 'output-error', errorText: 'rate limited' }),
    u('c'),
    aTool({ id: 'san3', input: { msg: 'y' }, output: { echo: 'y' } }),
    u('d'),
  ])

  // ═══════════════════════════════════════════════════════════
  // 10. PERSISTENCE CORRUPTION SCENARIOS
  // ═══════════════════════════════════════════════════════════
  await probe('corrupt: tool part missing toolCallId', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolName: 'echo', state: 'output-available', input: { msg: 'hi' }, output: { echo: 'hi' } },
    ]},
    u('ok'),
  ])
  await probe('corrupt: tool part missing toolName', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'cp2', state: 'output-available', input: { msg: 'hi' }, output: { echo: 'hi' } },
    ]},
    u('ok'),
  ])
  await probe('corrupt: tool part missing state', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'cp3', toolName: 'echo', input: { msg: 'hi' }, output: { echo: 'hi' } },
    ]},
    u('ok'),
  ])
  await probe('corrupt: tool part missing type', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { toolCallId: 'cp4', toolName: 'echo', state: 'output-available', input: { msg: 'hi' }, output: { echo: 'hi' } },
    ]},
    u('ok'),
  ])
  await probe('corrupt: tool with providerMetadata (from Claude)', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [
      { type: 'tool-echo', toolCallId: 'cp5', toolName: 'echo', state: 'output-available',
        input: { msg: 'hi' }, output: { echo: 'hi' },
        providerMetadata: { anthropic: { signature: 'abc123' } } },
    ]},
    u('ok'),
  ])
  await probe('corrupt: saved mid-stream (text part with state:streaming)', [
    u('x'),
    { id: uid(), role: 'assistant', parts: [{ type: 'text', text: 'partial respon', state: 'streaming' }] },
    u('ok'),
  ])

  // ═══════════════════════════════════════════════════════════
  // 11. LONG / STRESS
  // ═══════════════════════════════════════════════════════════
  await probe('long: 30-turn alternating', [
    ...Array.from({ length: 30 }, (_, i) => i % 2 === 0 ? u(`turn ${i}`) : a(`reply ${i}`)),
    u('done'),
  ])
  await probe('long: 10 tool calls across conversation', [
    ...Array.from({ length: 10 }, (_, i) => [
      u(`call ${i}`),
      aTool({ id: `lt${i}`, input: { msg: `${i}` }, output: { echo: `${i}` } }),
    ]).flat(),
    u('done'),
  ])

  // ═══════════════════════════════════════════════════════════
  // Print
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(120))

  let lastGroup = ''
  for (const r of results) {
    const m = r.id.match(/\[.+?\] (.+?)(?:$|:)/)
    const group = m ? m[1].split(':')[0] : ''
    if (group !== lastGroup) { console.log(`\n  ── ${group} ──`); lastGroup = group }
    const icon = r.status === 'OK' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    const detail = r.detail ? `  \x1b[90m${r.detail.slice(0, 120)}\x1b[0m` : ''
    console.log(`  ${icon} ${r.id}${r.status === 'FAIL' ? '\n   ' : ''}${detail}`)
  }

  const ok = results.filter(r => r.status === 'OK').length
  const fail = results.filter(r => r.status === 'FAIL').length
  console.log(`\n\n  Total: ${results.length} probes — \x1b[32m${ok} OK\x1b[0m, \x1b[31m${fail} FAIL\x1b[0m\n`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
