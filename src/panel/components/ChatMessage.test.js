import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'

vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createShouldersChatTransport: vi.fn() }))
vi.mock('../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))

import ChatMessage from './ChatMessage.vue'

function factory(message) {
  return shallowMount(ChatMessage, { props: { message } })
}

describe('ChatMessage', () => {
  it('renders user text', () => {
    const wrapper = factory({ role: 'user', content: 'Hello' })
    expect(wrapper.text()).toContain('Hello')
  })

  it('renders inline image for image file parts', () => {
    const wrapper = factory({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', filename: 'photo.png', url: 'data:image/png;base64,abc' },
        { type: 'text', text: 'check this' },
      ],
    })
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('data:image/png;base64,abc')
  })

  it('image thumbnail has max-width constraint', () => {
    const wrapper = factory({
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/jpeg', filename: 'pic.jpg', url: 'data:image/jpeg;base64,x' }],
    })
    expect(wrapper.find('img').exists()).toBe(true)
  })

  it('renders PDF file chip', () => {
    const wrapper = factory({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'application/pdf', filename: 'report.pdf', url: 'data:application/pdf;base64,JVBER' },
        { type: 'text', text: 'review this' },
      ],
    })
    expect(wrapper.text()).toContain('report.pdf')
  })

  it('renders placeholder text for persisted attachments', () => {
    const wrapper = factory({
      role: 'user',
      parts: [
        { type: 'file', _attachmentPlaceholder: true, filename: 'old-image.png', mediaType: 'image/png' },
        { type: 'text', text: 'from history' },
      ],
    })
    expect(wrapper.text()).toContain('old-image.png')
  })

  it('renders text alongside attachments', () => {
    const wrapper = factory({
      role: 'user',
      parts: [
        { type: 'file', mediaType: 'image/png', filename: 'img.png', url: 'data:image/png;base64,x' },
        { type: 'text', text: 'describe this' },
      ],
    })
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.text()).toContain('describe this')
  })

  it('assistant messages not affected', () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg1',
      parts: [{ type: 'text', text: 'I can see the image' }],
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.asst-text').exists()).toBe(true)
  })

  it('renders reasoning block with toggle', () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg2',
      parts: [{ type: 'reasoning', text: 'Let me think about this...' }],
    })
    const toggle = wrapper.find('.reasoning-toggle')
    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toContain('Thought process')
  })

  it('reasoning content hidden by default, shown on toggle', async () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg3',
      parts: [{ type: 'reasoning', text: 'deep thought' }],
    })
    expect(wrapper.find('.reasoning-content').exists()).toBe(false)
    await wrapper.find('.reasoning-toggle').trigger('click')
    expect(wrapper.find('.reasoning-content').exists()).toBe(true)
  })

  it('copy button appears on assistant messages with text', () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg4',
      parts: [{ type: 'text', text: 'Here is my answer' }],
    })
    expect(wrapper.find('button[title="Copy"]').exists()).toBe(true)
  })

  it('copy button shown on user messages with text', () => {
    const wrapper = factory({ role: 'user', content: 'Hello' })
    expect(wrapper.find('button[title="Copy"]').exists()).toBe(true)
  })

  it('copy button hidden on empty assistant messages', () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg5',
      parts: [],
    })
    expect(wrapper.find('button[title="Copy"]').exists()).toBe(false)
  })

  // ---- Fork button ----

  it('fork button appears on user messages', () => {
    const wrapper = factory({ role: 'user', content: 'Hello' })
    expect(wrapper.find('button[title="New chat from here"]').exists()).toBe(true)
  })

  it('fork button appears on settled assistant messages', () => {
    const wrapper = factory({
      role: 'assistant',
      id: 'msg6',
      parts: [{ type: 'text', text: 'Response' }],
    })
    expect(wrapper.find('button[title="New chat from here"]').exists()).toBe(true)
  })

  it('fork button emits fork event on click', async () => {
    const wrapper = factory({ role: 'user', content: 'Hello' })
    await wrapper.find('button[title="New chat from here"]').trigger('click')
    expect(wrapper.emitted('fork')).toHaveLength(1)
  })

  // ---- hfu stripping ----

  it('strips hfu tags from user message display', () => {
    const wrapper = factory({
      role: 'user',
      parts: [{ type: 'text', text: '<hfu><attached-file name="doc.md">\ncontent\n</attached-file></hfu>\n\nWhat do you think?' }],
    })
    expect(wrapper.text()).toContain('What do you think?')
    expect(wrapper.text()).not.toContain('content')
    expect(wrapper.text()).not.toContain('<hfu>')
  })

  it('shows filename chips for hfu-wrapped attached files', () => {
    const wrapper = factory({
      role: 'user',
      parts: [{ type: 'text', text: '<hfu><attached-file name="readme.md">\n# Hello\n</attached-file></hfu>\n\nSummarise this' }],
    })
    expect(wrapper.text()).toContain('readme.md')
    expect(wrapper.text()).toContain('Summarise this')
    expect(wrapper.text()).not.toContain('# Hello')
  })

  it('shows multiple filename chips for multiple attached files', () => {
    const wrapper = factory({
      role: 'user',
      parts: [{ type: 'text', text: '<hfu><attached-file name="a.md">\nfoo\n</attached-file></hfu>\n\n<hfu><attached-file name="b.txt">\nbar\n</attached-file></hfu>\n\nCompare these' }],
    })
    expect(wrapper.text()).toContain('a.md')
    expect(wrapper.text()).toContain('b.txt')
    expect(wrapper.text()).toContain('Compare these')
  })

  it('no filename chips for plain user messages', () => {
    const wrapper = factory({ role: 'user', content: 'Just a question' })
    expect(wrapper.text()).toContain('Just a question')
    expect(wrapper.findAll('[class*="bg-chrome"]').filter(el => el.text().includes('.md'))).toHaveLength(0)
  })
})
