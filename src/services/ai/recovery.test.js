import { describe, it, expect, vi } from 'vitest'
import { recoverPoisonedMessages } from './recovery'

function makeMockChat(messages) {
  return { state: { messagesRef: { value: messages } } }
}

function toolPart(overrides = {}) {
  return {
    type: 'tool-echo',
    toolCallId: 'tc_1',
    toolName: 'echo',
    state: 'output-available',
    input: { msg: 'hi' },
    output: { echo: 'hi' },
    ...overrides,
  }
}

function assistantWith(...parts) {
  return { role: 'assistant', parts }
}

describe('recoverPoisonedMessages', () => {
  // ── Parts that should be LEFT ALONE ──

  describe('keeps safe parts', () => {
    it('output-available with object input', () => {
      const msgs = [assistantWith(toolPart())]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
      expect(msgs[0].parts[0].type).toBe('tool-echo')
    })

    it('output-error with object input', () => {
      const msgs = [assistantWith(toolPart({ state: 'output-error', input: { msg: 'hi' }, errorText: 'denied' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
      expect(msgs[0].parts[0].type).toBe('tool-echo')
    })

    it('output-available with empty input {}', () => {
      const msgs = [assistantWith(toolPart({ input: {} }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })

    it('output-error with empty input {}', () => {
      const msgs = [assistantWith(toolPart({ state: 'output-error', input: {}, errorText: 'x' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })

    it('skips text parts', () => {
      const msgs = [assistantWith({ type: 'text', text: 'hello' })]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })

    it('skips user messages', () => {
      const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })

    it('dynamic-tool type with valid fields', () => {
      const msgs = [assistantWith(toolPart({ type: 'dynamic-tool' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })
  })

  // ── Non-terminal states → text ──

  describe('converts non-terminal states to text', () => {
    it('input-available', () => {
      const msgs = [assistantWith(toolPart({ state: 'input-available' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
      expect(msgs[0].parts[0].text).toContain('echo')
    })

    it('input-streaming', () => {
      const msgs = [assistantWith(toolPart({ state: 'input-streaming' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('bogus state "pending"', () => {
      const msgs = [assistantWith(toolPart({ state: 'pending' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('bogus state "cancelled"', () => {
      const msgs = [assistantWith(toolPart({ state: 'cancelled' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('state undefined', () => {
      const msgs = [assistantWith(toolPart({ state: undefined }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('state missing entirely', () => {
      const p = toolPart()
      delete p.state
      const msgs = [assistantWith(p)]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })
  })

  // ── Bad input shapes → text ──

  describe('converts bad input to text', () => {
    it('input undefined', () => {
      const p = toolPart({ state: 'output-error', errorText: 'x' })
      delete p.input
      const msgs = [assistantWith(p)]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('input null', () => {
      const msgs = [assistantWith(toolPart({ input: null }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('input string', () => {
      const msgs = [assistantWith(toolPart({ input: 'raw string' }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('input number', () => {
      const msgs = [assistantWith(toolPart({ input: 42 }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('input array', () => {
      const msgs = [assistantWith(toolPart({ input: ['a', 'b'] }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('input boolean', () => {
      const msgs = [assistantWith(toolPart({ input: true }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })
  })

  // ── Missing toolCallId → text ──

  describe('converts missing toolCallId to text', () => {
    it('toolCallId undefined', () => {
      const msgs = [assistantWith(toolPart({ toolCallId: undefined }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('toolCallId null', () => {
      const msgs = [assistantWith(toolPart({ toolCallId: null }))]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })

    it('toolCallId missing', () => {
      const p = toolPart()
      delete p.toolCallId
      const msgs = [assistantWith(p)]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('text')
    })
  })

  // ── Multi-message / mixed ──

  describe('handles multiple messages', () => {
    it('fixes bad parts across multiple messages', () => {
      const msgs = [
        assistantWith(toolPart({ toolCallId: 'ok1', input: { msg: 'a' } })),
        { role: 'user', parts: [{ type: 'text', text: 'x' }] },
        assistantWith(toolPart({ state: 'pending', toolCallId: 'bad1' })),
        { role: 'user', parts: [{ type: 'text', text: 'y' }] },
        assistantWith(toolPart({ toolCallId: 'ok2', input: { msg: 'b' } })),
      ]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('tool-echo')
      expect(msgs[2].parts[0].type).toBe('text')
      expect(msgs[4].parts[0].type).toBe('tool-echo')
    })

    it('one ok + one broken in same message', () => {
      const msgs = [assistantWith(
        toolPart({ toolCallId: 'ok' }),
        toolPart({ toolCallId: 'bad', state: 'input-available' }),
      )]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(true)
      expect(msgs[0].parts[0].type).toBe('tool-echo')
      expect(msgs[0].parts[1].type).toBe('text')
    })
  })

  // ── Error text preserved ──

  describe('preserves context in text', () => {
    it('includes toolName', () => {
      const msgs = [assistantWith(toolPart({ state: 'input-available', toolName: 'run_command' }))]
      recoverPoisonedMessages(makeMockChat(msgs))
      expect(msgs[0].parts[0].text).toContain('run_command')
    })

    it('includes errorText when present', () => {
      const msgs = [assistantWith(toolPart({ state: 'output-error', input: null, errorText: 'Permission denied' }))]
      recoverPoisonedMessages(makeMockChat(msgs))
      expect(msgs[0].parts[0].text).toContain('Permission denied')
    })

    it('falls back to error arg when no errorText', () => {
      const msgs = [assistantWith(toolPart({ state: 'input-available' }))]
      recoverPoisonedMessages(makeMockChat(msgs), new Error('Parse failed'))
      expect(msgs[0].parts[0].text).toContain('Parse failed')
    })
  })

  // ── Edge cases ──

  describe('edge cases', () => {
    it('returns false for empty messages', () => {
      expect(recoverPoisonedMessages(makeMockChat([]))).toBe(false)
    })

    it('handles missing parts gracefully', () => {
      const msgs = [{ role: 'assistant' }]
      expect(recoverPoisonedMessages(makeMockChat(msgs))).toBe(false)
    })

    it('returns false and warns on thrown error', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const chat = { state: { messagesRef: { get value() { throw new Error('boom') } } } }
      expect(recoverPoisonedMessages(chat)).toBe(false)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })
})
