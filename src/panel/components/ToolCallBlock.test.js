import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'

vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createShouldersChatTransport: vi.fn() }))
vi.mock('../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))

import ToolCallBlock from './ToolCallBlock.vue'

function factory(part) {
  return shallowMount(ToolCallBlock, { props: { part } })
}

describe('ToolCallBlock completed state', () => {
  it('renders tool line with human-readable label', () => {
    const wrapper = factory({ type: 'tool-read', toolName: 'read', state: 'output-available', input: { target: '@editor' }, toolCallId: 'tc1' })
    expect(wrapper.find('.tool-line').exists()).toBe(true)
    expect(wrapper.find('.tool-label-text').text()).toBe('Read')
  })

  it('shows checkmark for done status', () => {
    const wrapper = factory({ type: 'tool-search', toolName: 'search', state: 'output-available', input: { scope: 'project', query: 'AI safety' }, toolCallId: 'tc2' })
    expect(wrapper.find('.tool-status-check').exists()).toBe(true)
  })

  it('shows pulsing dots for running status', () => {
    const wrapper = factory({ type: 'tool-shell', toolName: 'shell', state: 'input-available', input: { command: 'ls -la' }, toolCallId: 'tc3' })
    expect(wrapper.find('.tool-pending-dots').exists()).toBe(true)
  })

  it('shows error icon for output-error state', () => {
    const wrapper = factory({ type: 'tool-create', toolName: 'create', state: 'output-error', input: { target: 'test.md', content: 'x' }, toolCallId: 'tc4' })
    expect(wrapper.find('.tool-status-error').exists()).toBe(true)
    expect(wrapper.find('.tool-status-error').text()).toBe('✕')
  })

  it('shows error icon when output contains error field', () => {
    const wrapper = factory({ type: 'tool-read', toolName: 'read', state: 'output-available', input: { target: 'missing.md' }, output: { error: 'Failed to read file: undefined' }, toolCallId: 'tc4b' })
    expect(wrapper.find('.tool-status-error').exists()).toBe(true)
  })

  it('extracts context from tool input', () => {
    const wrapper = factory({ type: 'tool-read', toolName: 'read', state: 'output-available', input: { target: 'src/utils/helpers.js' }, toolCallId: 'tc5' })
    expect(wrapper.find('.tool-context').text()).toBe('helpers.js')
  })

  it('renders show with correct label', () => {
    const wrapper = factory({ type: 'tool-show', toolName: 'show', state: 'output-available', input: { target: '@issues/ISSUE-1' }, toolCallId: 'tc6' })
    expect(wrapper.find('.tool-label-text').text()).toBe('Show')
  })

  it('detail panel hidden by default', () => {
    const wrapper = factory({ type: 'tool-read', toolName: 'read', state: 'output-available', input: { target: '@editor' }, toolCallId: 'tc7' })
    expect(wrapper.find('.tool-detail.is-expanded').exists()).toBe(false)
  })

  it('detail panel expands on click', async () => {
    const wrapper = factory({ type: 'tool-search', toolName: 'search', state: 'output-available', input: { scope: 'references', query: 'HEOR' }, output: '3 results', toolCallId: 'tc8' })
    await wrapper.find('.tool-line').trigger('click')
    expect(wrapper.find('.tool-detail.is-expanded').exists()).toBe(true)
  })

  it('falls back to raw name for unknown tools', () => {
    const wrapper = factory({ type: 'tool-custom_thing', toolName: 'custom_thing', state: 'output-available', input: {}, toolCallId: 'tc9' })
    expect(wrapper.find('.tool-label-text').text()).toBe('custom_thing')
  })
})
