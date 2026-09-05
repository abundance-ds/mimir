import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import ChatActivity from './ChatActivity.vue'
import { useChatStore } from '../../stores/chat.js'

function connectedChat() {
  const chat = useChatStore()
  chat.initialized = true
  chat.status = {
    state: 'connected',
    endpoint: 'wss://chat.abundanceds.com/webirc',
    account: 'waqr',
    relayReady: true,
    diagnostic: null,
  }
  chat.activeTarget = '#general'
  chat.targets = [{
    id: '#general',
    kind: 'channel',
    title: 'general',
    topic: 'Company chat',
    memberCount: 2,
    unreadCount: 0,
    firstUnreadId: null,
    muted: false,
  }]
  chat.messagesByTarget = {
    '#general': [{
      id: 'm1',
      target: '#general',
      serverTime: '2026-07-28T12:00:00.000Z',
      senderNick: 'anna',
      senderAccount: 'anna',
      body: 'Can you check the launch notes?',
      replyTo: null,
      own: false,
      agentLabel: null,
      activityId: null,
    }],
  }
  return chat
}

describe('ChatActivity', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(invoke).mockClear()
    vi.mocked(openFileDialog).mockReset()
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'chat_targets') return [{
        id: '#general',
        kind: 'channel',
        title: 'general',
        topic: 'Company chat',
        memberCount: 2,
        unreadCount: 0,
        firstUnreadId: null,
        muted: false,
      }]
      return undefined
    })
  })

  it('keeps replies inline and sends with the reply message id', async () => {
    const chat = connectedChat()
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
      attachTo: document.body,
    })
    await nextTick()

    await wrapper.get('.chat-reply-action').trigger('click')
    expect(wrapper.text()).toContain('Replying to')
    await wrapper.get('[data-chat-composer-input]').setValue('I checked it.')
    await wrapper.get('[data-chat-composer-input]').trigger('keydown', {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
    })
    await flushPromises()

    expect(invoke).toHaveBeenCalledWith('chat_send', {
      target: '#general',
      text: 'I checked it.',
      replyTo: 'm1',
    })
    expect(chat.drafts['#general']).toBe('')
    wrapper.unmount()
  })

  it('preserves a draft and explains why sending is unavailable offline', async () => {
    const chat = connectedChat()
    chat.status = { ...chat.status, state: 'reconnecting' }
    chat.drafts['#general'] = 'unsent detail'
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    expect(wrapper.get('[data-chat-composer-input]').element.value).toBe('unsent detail')
    expect(wrapper.get('[data-chat-composer-input]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Your draft is safe')
  })

  it('prevents an accidental duplicate while a message is sending', async () => {
    const chat = connectedChat()
    let finishSend
    const pending = new Promise(resolve => {
      finishSend = resolve
    })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'chat_send') return pending
      if (command === 'chat_targets') return chat.targets
      return undefined
    })
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    const input = wrapper.get('[data-chat-composer-input]')
    await input.setValue('One deliberate message')
    await input.trigger('keydown', { key: 'Enter', isComposing: false })
    await input.trigger('keydown', { key: 'Enter', isComposing: false })

    expect(invoke.mock.calls.filter(([command]) => command === 'chat_send')).toHaveLength(1)
    expect(input.attributes('disabled')).toBeDefined()
    finishSend()
    await flushPromises()
  })

  it('shares ephemeral typing state and renders teammate typing without transcript noise', async () => {
    const chat = connectedChat()
    chat.members = [{ nick: 'anna', account: 'anna', displayName: 'Anna' }]
    chat.typingByTarget = { '#general': ['anna'] }
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    expect(wrapper.text()).toContain('Anna is typing…')
    await wrapper.get('[data-chat-composer-input]').setValue('Working on it')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_typing', {
      target: '#general',
      state: 'active',
    })

    wrapper.unmount()
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_typing', {
      target: '#general',
      state: 'done',
    })
  })

  it('makes reactions one-click and toggles an existing own reaction', async () => {
    const chat = connectedChat()
    chat.messagesByTarget['#general'][0].reactions = [{
      value: '👍',
      count: 2,
      own: true,
      reactors: ['waqr', 'anna'],
    }]
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    await wrapper.get('[data-chat-reactions] button').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_react', {
      target: '#general',
      messageId: 'm1',
      reaction: '👍',
      add: false,
    })
  })

  it('keeps own-message edit and deliberate delete in the message action menu', async () => {
    const chat = connectedChat()
    chat.messagesByTarget['#general'][0].own = true
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    await wrapper.get('button[aria-label="More message actions"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text().includes('Edit message')).trigger('click')
    const edit = wrapper.get('[data-chat-edit-input]')
    await edit.trigger('keydown', { key: 'r' })
    expect(wrapper.text()).not.toContain('Replying to')
    await edit.setValue('Edited launch note')
    await edit.trigger('keydown', { key: 'Enter', metaKey: true })
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_edit', {
      target: '#general',
      messageId: 'm1',
      text: 'Edited launch note',
    })

    await wrapper.get('button[aria-label="More message actions"]').trigger('click')
    await wrapper.findAll('button').find(button => button.text().includes('Delete message')).trigger('click')
    await wrapper.findAll('button').find(button => button.text() === 'Delete').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_delete', {
      target: '#general',
      messageId: 'm1',
    })
  })

  it('uses roving message focus without exposing every hidden action to Tab', async () => {
    const chat = connectedChat()
    chat.messagesByTarget['#general'].push({
      ...chat.messagesByTarget['#general'][0],
      id: 'm2',
      body: 'The notes are ready.',
    })
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
      attachTo: document.body,
    })
    await nextTick()

    const rows = wrapper.findAll('[data-chat-message]')
    expect(rows.map(row => row.attributes('tabindex'))).toEqual(['-1', '0'])
    expect(rows[0].findAll('[data-chat-actions] > button')
      .map(button => button.attributes('tabindex'))).toEqual(['-1', '-1', '-1'])

    rows[1].element.focus()
    await rows[1].trigger('keydown', { key: 'ArrowUp' })
    await nextTick()

    expect(document.activeElement).toBe(rows[0].element)
    expect(rows.map(row => row.attributes('tabindex'))).toEqual(['0', '-1'])
    expect(rows[0].findAll('[data-chat-actions] > button')
      .map(button => button.attributes('tabindex'))).toEqual(['0', '0', '0'])
    wrapper.unmount()
  })

  it('shares selected files into the target that started the upload', async () => {
    connectedChat()
    vi.mocked(openFileDialog).mockResolvedValue(['/tmp/launch.pdf'])
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await nextTick()

    await wrapper.get('button[aria-label="Attach files"]').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_upload_path', {
      target: '#general',
      path: '/tmp/launch.pdf',
    })
    expect(wrapper.text()).toContain('launch.pdf')
  })

  it('previews a cached image and opens its verified local copy', async () => {
    const chat = connectedChat()
    chat.messagesByTarget['#general'][0].attachments = [{
      id: 'file-one',
      name: 'launch.png',
      mime: 'image/png',
      size: 2048,
      sha256: 'a'.repeat(64),
      url: 'https://chat.abundanceds.com/files/file-one',
      localPath: '/tmp/launch.png',
    }]
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'chat_attachment_preview') return 'data:image/png;base64,cG5n'
      if (command === 'chat_targets') return chat.targets
      return undefined
    })
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-chat-attachments] img').attributes('src'))
      .toBe('data:image/png;base64,cG5n')
    await wrapper.get('[data-chat-attachments] button').trigger('click')
    await flushPromises()
    expect(invoke).toHaveBeenCalledWith('chat_open_attachment', { fileId: 'file-one' })
  })

  it('returns focus to the first choice when backing out of a new-chat flow', async () => {
    const chat = connectedChat()
    const wrapper = mount(ChatActivity, {
      props: {
        activity: { id: 'chats', kind: 'chat', title: 'Chats' },
        active: true,
      },
      attachTo: document.body,
    })
    chat.requestNewChat('menu')
    await flushPromises()

    const choices = wrapper.findAll('.new-chat-choice')
    await choices[0].trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('input[placeholder="product"]').element)

    await wrapper.get('button[aria-label="Back"]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.findAll('.new-chat-choice')[0].element)
    wrapper.unmount()
  })
})
