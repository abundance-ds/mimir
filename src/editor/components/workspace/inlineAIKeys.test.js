import { describe, expect, it } from 'vitest'
import { inlineAIKeyAction } from './inlineAIKeys.js'

describe('inline AI keyboard grammar', () => {
  it('accepts a pending edit with Command/Ctrl+Enter before ordinary submit handling', () => {
    expect(inlineAIKeyAction({ key: 'Enter', metaKey: true }, { hasPendingEdit: true })).toBe('accept')
    expect(inlineAIKeyAction({ key: 'Enter', ctrlKey: true }, { hasPendingEdit: true })).toBe('accept')
  })

  it('submits Enter and preserves Shift+Enter for a newline', () => {
    expect(inlineAIKeyAction({ key: 'Enter' })).toBe('submit')
    expect(inlineAIKeyAction({ key: 'Enter', shiftKey: true })).toBeNull()
  })

  it('submits Command/Ctrl+Enter when there is no edit to accept', () => {
    expect(inlineAIKeyAction({ key: 'Enter', metaKey: true })).toBe('submit')
  })
})
