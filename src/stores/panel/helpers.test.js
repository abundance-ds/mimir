import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  relativeTime,
  formatCost,
  proposalFinal,
  proposalRetryable,
  isToolPart,
  emptyUsage,
  defaultProjects,
  cleanMessagesForPersist,
  sanitizeLoadedMessages,
  attentionWeight,
  basename,
  plainJson,
  plainProject,
  isUnread,
  isAppSession,
  sessionStatusKind,
  sessionStatusLabel,
  sessionMeta,
  countToolCalls,
  chatInstances,
  getToolLabel,
  getToolIcon,
  getToolContext,
  getToolFilePath,
  isSkillTool,
} from './helpers.js'

describe('relativeTime', () => {
  it('returns "now" for recent timestamps', () => {
    expect(relativeTime(new Date().toISOString())).toBe('now')
  })

  it('returns "Xm" for minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString()
    expect(relativeTime(fiveMinAgo)).toBe('5m')
  })

  it('returns "Xh" for hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString()
    expect(relativeTime(twoHoursAgo)).toBe('2h')
  })

  it('returns "Xd" for days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()
    expect(relativeTime(threeDaysAgo)).toBe('3d')
  })

  it('returns "now" for invalid values', () => {
    expect(relativeTime('not-a-date')).toBe('now')
    expect(relativeTime(null)).toBe('now')
  })
})

describe('formatCost', () => {
  it('returns "$0.00" for zero', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('returns "<$0.01" for tiny amounts', () => {
    expect(formatCost(0.005)).toBe('<$0.01')
  })

  it('returns "$X.XX" for normal amounts', () => {
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(12.345)).toBe('$12.35')
  })

  it('returns "$0.00" for negative values', () => {
    expect(formatCost(-5)).toBe('$0.00')
  })

  it('returns "$0.00" for non-numeric values', () => {
    expect(formatCost(null)).toBe('$0.00')
    expect(formatCost('abc')).toBe('$0.00')
  })
})

describe('proposalFinal', () => {
  it('returns true for accepted', () => {
    expect(proposalFinal({ status: 'accepted' })).toBe(true)
  })

  it('returns true for rejected', () => {
    expect(proposalFinal({ status: 'rejected' })).toBe(true)
  })

  it('returns false for pending', () => {
    expect(proposalFinal({ status: 'pending' })).toBe(false)
  })

  it('returns true for failed', () => {
    expect(proposalFinal({ status: 'failed' })).toBe(true)
  })

  it('returns true for stale and conflict', () => {
    expect(proposalFinal({ status: 'stale' })).toBe(true)
    expect(proposalFinal({ status: 'conflict' })).toBe(true)
  })
})

describe('proposalRetryable', () => {
  it('returns true for failed', () => {
    expect(proposalRetryable({ status: 'failed' })).toBe(true)
  })

  it('returns true for stale and conflict', () => {
    expect(proposalRetryable({ status: 'stale' })).toBe(true)
    expect(proposalRetryable({ status: 'conflict' })).toBe(true)
  })

  it('returns false for pending', () => {
    expect(proposalRetryable({ status: 'pending' })).toBe(false)
  })

  it('returns false for accepted', () => {
    expect(proposalRetryable({ status: 'accepted' })).toBe(false)
  })
})

describe('isToolPart', () => {
  it('returns true for tool-* types', () => {
    expect(isToolPart({ type: 'tool-invocation' })).toBe(true)
    expect(isToolPart({ type: 'tool-result' })).toBe(true)
  })

  it('returns true for dynamic-tool type', () => {
    expect(isToolPart({ type: 'dynamic-tool' })).toBe(true)
  })

  it('returns false for text type', () => {
    expect(isToolPart({ type: 'text' })).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isToolPart(null)).toBe(false)
    expect(isToolPart(undefined)).toBe(false)
  })
})

describe('emptyUsage', () => {
  it('returns correct shape with all zero values', () => {
    const usage = emptyUsage()
    expect(usage).toEqual({
      inputTokens: 0,
      inputNoCacheTokens: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    })
  })

  it('returns a new object each call', () => {
    const a = emptyUsage()
    const b = emptyUsage()
    expect(a).not.toBe(b)
  })
})

describe('defaultProjects', () => {
  it('returns array with general project', () => {
    const projects = defaultProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('general')
    expect(projects[0].name).toBe('Personal')
    expect(projects[0].system).toBe(true)
  })

  it('returns a new array each call', () => {
    expect(defaultProjects()).not.toBe(defaultProjects())
  })
})

describe('cleanMessagesForPersist', () => {
  it('returns empty array for non-array input', () => {
    expect(cleanMessagesForPersist(null)).toEqual([])
    expect(cleanMessagesForPersist(undefined)).toEqual([])
    expect(cleanMessagesForPersist('string')).toEqual([])
  })

  it('passes through user messages unchanged', () => {
    const msgs = [{ role: 'user', content: 'hello' }]
    expect(cleanMessagesForPersist(msgs)).toEqual(msgs)
  })

  it('drops non-terminal tool parts (input-available, input-streaming)', () => {
    const msgs = [{
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hello' },
        { state: 'input-available', type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', input: { msg: 'hi' } },
        { state: 'input-streaming', type: 'tool-echo', toolCallId: 'c2', toolName: 'echo', input: { msg: 'hi' } },
      ],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts).toHaveLength(1)
    expect(result[0].parts[0].type).toBe('text')
  })

  it('drops tool parts with bogus state', () => {
    const msgs = [{
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hello' },
        { state: 'pending', type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', input: { msg: 'hi' } },
      ],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts).toHaveLength(1)
  })

  it('drops tool parts with missing toolCallId', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ state: 'output-available', type: 'tool-echo', toolName: 'echo', input: { msg: 'hi' }, output: {} }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts).toHaveLength(0)
  })

  it('drops tool parts with non-object input', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ state: 'output-available', type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', input: 'string', output: {} }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts).toHaveLength(0)
  })

  it('truncates large tool outputs', () => {
    const largeOutput = 'x'.repeat(3000)
    const msgs = [{
      role: 'assistant',
      parts: [{ type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', output: largeOutput, state: 'output-available', input: { msg: 'hi' } }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts[0].output._truncated).toBe(true)
    expect(result[0].parts[0].output.preview.length).toBeLessThanOrEqual(200)
  })

  it('keeps small tool outputs intact', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', output: 'small', state: 'output-available', input: { msg: 'hi' } }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts[0].output).toBe('small')
  })

  it('keeps output-error with object input, strips rawInput', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ state: 'output-error', type: 'tool-echo', toolCallId: 'c1', toolName: 'echo', input: { msg: 'hi' }, rawInput: 'raw', errorText: 'denied' }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts[0].state).toBe('output-error')
    expect(result[0].parts[0].input).toEqual({ msg: 'hi' })
    expect(result[0].parts[0].rawInput).toBeUndefined()
  })

  it('keeps output-available with empty input {}', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ state: 'output-available', type: 'tool-ping', toolCallId: 'c1', toolName: 'ping', input: {}, output: { pong: true } }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts[0].state).toBe('output-available')
    expect(result[0].parts[0].input).toEqual({})
  })

  it('passes through text parts unchanged', () => {
    const msgs = [{
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'thinking' }],
    }]
    const result = cleanMessagesForPersist(msgs)
    expect(result[0].parts).toHaveLength(2)
  })
})

describe('sanitizeLoadedMessages', () => {
  function tp(overrides = {}) {
    return {
      type: 'tool-echo', toolCallId: 'tc1', toolName: 'echo',
      state: 'output-available', input: { msg: 'hi' }, output: { echo: 'hi' },
      ...overrides,
    }
  }

  // ── Keeps safe parts ──

  it('keeps output-available with object input', () => {
    const msgs = [{ role: 'assistant', parts: [tp()] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('tool-echo')
  })

  it('keeps output-error with object input', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: 'output-error', input: { msg: 'hi' }, errorText: 'x' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('tool-echo')
  })

  it('keeps output-available with empty input {} (no-param tool)', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ input: {}, output: { pong: true } })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('tool-echo')
  })

  it('keeps dynamic-tool type', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ type: 'dynamic-tool' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('dynamic-tool')
  })

  it('leaves text parts alone', () => {
    const msgs = [{ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('skips user messages', () => {
    const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  // ── Converts non-terminal states ──

  it('converts input-available to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: 'input-available' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
    expect(msgs[0].parts[0].text).toContain('echo')
  })

  it('converts input-streaming to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: 'input-streaming' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts bogus state "pending" to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: 'pending' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts undefined state to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: undefined })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  // ── Converts bad input ──

  it('converts undefined input to text', () => {
    const p = tp(); delete p.input
    const msgs = [{ role: 'assistant', parts: [p] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts null input to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ input: null })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts string input to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ input: 'raw' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts array input to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ input: [1, 2] })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  // ── Converts missing toolCallId ──

  it('converts missing toolCallId to text', () => {
    const p = tp(); delete p.toolCallId
    const msgs = [{ role: 'assistant', parts: [p] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  it('converts null toolCallId to text', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ toolCallId: null })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
  })

  // ── Mixed messages ──

  it('fixes only broken parts, keeps good ones', () => {
    const msgs = [{ role: 'assistant', parts: [
      { type: 'text', text: 'hi' },
      tp({ toolCallId: 'ok1' }),
      tp({ toolCallId: 'bad1', state: 'input-available' }),
    ]}]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].type).toBe('text')
    expect(msgs[0].parts[1].type).toBe('tool-echo')
    expect(msgs[0].parts[2].type).toBe('text')
  })

  it('preserves errorText in text summary', () => {
    const msgs = [{ role: 'assistant', parts: [tp({ state: 'output-error', input: null, errorText: 'Rate limited' })] }]
    sanitizeLoadedMessages(msgs)
    expect(msgs[0].parts[0].text).toContain('Rate limited')
  })
})

describe('attentionWeight', () => {
  it('error has highest weight', () => {
    expect(attentionWeight('error')).toBe(100)
  })

  it('awaiting-review > working', () => {
    expect(attentionWeight('awaiting-review')).toBeGreaterThan(attentionWeight('working'))
  })

  it('unread does not promote (no list jumping)', () => {
    expect(attentionWeight('unread')).toBe(0)
  })

  it('unknown kinds return 0', () => {
    expect(attentionWeight('ready')).toBe(0)
    expect(attentionWeight('done')).toBe(0)
  })
})

describe('basename', () => {
  it('extracts last segment from path', () => {
    expect(basename('/Users/me/project')).toBe('project')
  })

  it('handles trailing slashes', () => {
    expect(basename('/Users/me/project/')).toBe('project')
  })

  it('returns empty string for empty input', () => {
    expect(basename('')).toBe('')
    expect(basename(null)).toBe('')
  })
})

describe('plainJson', () => {
  it('deep-clones a value', () => {
    const original = [{ a: 1 }]
    const result = plainJson(original)
    expect(result).toEqual(original)
    expect(result).not.toBe(original)
  })

  it('returns empty array for null/undefined', () => {
    expect(plainJson(null)).toEqual([])
    expect(plainJson(undefined)).toEqual([])
  })
})

describe('plainProject', () => {
  it('returns null for null input', () => {
    expect(plainProject(null)).toBe(null)
  })

  it('extracts plain project shape', () => {
    const project = {
      id: 'p1', name: 'Test', path: '/test',
      workspacePath: '/ws', system: false, createdAt: '2026-01-01',
      _extraStuff: true,
    }
    const result = plainProject(project)
    expect(result).toEqual({
      id: 'p1', name: 'Test', path: '/test',
      workspacePath: '/ws', description: '', system: false, createdAt: '2026-01-01',
    })
    expect(result._extraStuff).toBeUndefined()
  })
})

describe('sessionStatusKind', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('returns "ready" for empty session without errors', () => {
    const session = { id: 's1', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('ready')
  })

  it('returns "error" when session has lastError', () => {
    const session = { id: 's1', lastError: 'Something broke', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('error')
  })

  it('returns "awaiting-review" when session has pending proposals', () => {
    const session = {
      id: 's1', lastError: '', proposals: [{ status: 'pending' }], _savedMessages: [],
    }
    expect(sessionStatusKind(session)).toBe('awaiting-review')
  })

  it('returns "done" when session has messages and no special status', () => {
    const session = {
      id: 's1', lastError: '', proposals: [{ status: 'accepted' }],
      _savedMessages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
      lastViewedAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    }
    expect(sessionStatusKind(session)).toBe('done')
  })
})

describe('sessionStatusLabel', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('returns "Ready" for empty session', () => {
    const session = { id: 's1', proposals: [], _savedMessages: [] }
    expect(sessionStatusLabel(session)).toBe('Ready')
  })

  it('returns "Error" for errored session', () => {
    const session = { id: 's1', lastError: 'fail', proposals: [], _savedMessages: [] }
    expect(sessionStatusLabel(session)).toBe('Error')
  })
})

describe('countToolCalls', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('counts tool parts across messages', () => {
    const session = {
      id: 's1',
      _savedMessages: [
        { role: 'assistant', parts: [{ type: 'tool-invocation' }, { type: 'text' }] },
        { role: 'assistant', parts: [{ type: 'tool-result' }, { type: 'dynamic-tool' }] },
      ],
    }
    expect(countToolCalls(session)).toBe(3)
  })

  it('returns 0 for no messages', () => {
    const session = { id: 's1', _savedMessages: [] }
    expect(countToolCalls(session)).toBe(0)
  })
})

describe('tool display metadata', () => {
  it('getToolLabel returns human label for known tools', () => {
    expect(getToolLabel('read')).toBe('Read')
    expect(getToolLabel('shell')).toBe('Shell')
  })

  it('getToolLabel returns raw name for unknown tools', () => {
    expect(getToolLabel('unknown_tool')).toBe('unknown_tool')
  })

  it('getToolIcon returns correct categories', () => {
    expect(getToolIcon('read')).toBe('eye')
    expect(getToolIcon('shell')).toBe('terminal')
    expect(getToolIcon('search')).toBe('search')
    expect(getToolIcon('show')).toBe('layout')
    expect(getToolIcon('unknown')).toBe('file')
  })

  it('getToolContext extracts file basename', () => {
    expect(getToolContext('read', { target: 'src/foo/bar.js' })).toBe('bar.js')
  })

  it('getToolContext truncates long commands', () => {
    const cmd = 'a'.repeat(70)
    expect(getToolContext('shell', { command: cmd })).toBe('a'.repeat(60))
  })

  it('getToolContext returns empty for unknown tools', () => {
    expect(getToolContext('unknown', {})).toBe('')
  })

  it('getToolContext handles null input', () => {
    expect(getToolContext('read', null)).toBe('')
  })

  it('getToolFilePath returns path for file tools', () => {
    expect(getToolFilePath('read', { target: 'foo.js' })).toBe('foo.js')
    expect(getToolFilePath('create', { target: 'bar.js' })).toBe('bar.js')
  })

  it('getToolFilePath returns null for non-file tools', () => {
    expect(getToolFilePath('shell', { command: 'ls' })).toBeNull()
    expect(getToolFilePath('search_web', { query: 'ai' })).toBeNull()
  })

  it('isSkillTool returns false for all tools', () => {
    expect(isSkillTool('read')).toBe(false)
    expect(isSkillTool('show')).toBe(false)
  })
})

describe('sessionMeta', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('shows message count', () => {
    const session = {
      id: 's1',
      _savedMessages: [{ role: 'user' }],
    }
    expect(sessionMeta(session)).toBe('1 Msg')
  })

  it('shows tool calls when present', () => {
    const session = {
      id: 's1',
      _savedMessages: [
        { role: 'assistant', parts: [{ type: 'tool-invocation' }] },
      ],
    }
    expect(sessionMeta(session)).toBe('1 Msg  1 tool calls')
  })
})

describe('isAppSession', () => {
  it('returns true for app type', () => {
    expect(isAppSession({ type: 'app' })).toBe(true)
  })

  it('returns false for chat type', () => {
    expect(isAppSession({ type: 'chat' })).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isAppSession(null)).toBe(false)
    expect(isAppSession(undefined)).toBe(false)
  })
})

describe('sessionStatusKind for app sessions', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('returns "working" when appStatus is running', () => {
    const session = { id: 's1', type: 'app', appStatus: 'running', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('working')
  })

  it('returns "error" when appStatus is failed', () => {
    const session = { id: 's1', type: 'app', appStatus: 'failed', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('error')
  })

  it('returns "done" when appStatus is completed', () => {
    const session = { id: 's1', type: 'app', appStatus: 'completed', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('done')
  })

  it('returns "ready" when appStatus is setup', () => {
    const session = { id: 's1', type: 'app', appStatus: 'setup', proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('ready')
  })

  it('returns "ready" for null appStatus', () => {
    const session = { id: 's1', type: 'app', appStatus: null, proposals: [], _savedMessages: [] }
    expect(sessionStatusKind(session)).toBe('ready')
  })
})

describe('sessionMeta for app sessions', () => {
  beforeEach(() => {
    chatInstances.clear()
  })

  it('shows step count and app name', () => {
    const session = {
      id: 's1',
      type: 'app',
      appName: 'My App',
      appEvents: [{ type: 'step' }, { type: 'log' }, { type: 'step' }],
      _savedMessages: [],
    }
    expect(sessionMeta(session)).toBe('2 steps · My App')
  })

  it('shows singular step', () => {
    const session = {
      id: 's1',
      type: 'app',
      appName: null,
      appEvents: [{ type: 'step' }],
      _savedMessages: [],
    }
    expect(sessionMeta(session)).toBe('1 step')
  })

  it('shows 0 steps when no events', () => {
    const session = {
      id: 's1',
      type: 'app',
      appName: 'Test',
      appEvents: [],
      _savedMessages: [],
    }
    expect(sessionMeta(session)).toBe('0 steps · Test')
  })

  it('handles null appEvents', () => {
    const session = {
      id: 's1',
      type: 'app',
      appName: null,
      appEvents: null,
      _savedMessages: [],
    }
    expect(sessionMeta(session)).toBe('0 steps')
  })
})
