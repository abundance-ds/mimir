import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  chatStatus: vi.fn(),
  chatConfig: vi.fn(),
  listChatTargets: vi.fn(),
  listChatMembers: vi.fn(),
  listChatMessages: vi.fn(),
  chatMessagesAround: vi.fn(),
  listenToChatEvents: vi.fn(),
  setActiveChatTarget: vi.fn(),
  markChatRead: vi.fn(),
  setChatEnabled: vi.fn(),
  searchChat: vi.fn(),
  sendChatMessage: vi.fn(),
}))

vi.mock('../services/chat.js', async importOriginal => ({
  ...(await importOriginal()),
  ...api,
}))

import { useChatStore } from './chat.js'

describe('chat store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.chatStatus.mockResolvedValue({
      state: 'connected',
      endpoint: 'wss://chat.abundanceds.com/webirc',
      account: 'waqr',
      relayReady: true,
      diagnostic: null,
    })
    api.chatConfig.mockResolvedValue({
      endpoint: 'wss://chat.abundanceds.com/webirc',
      account: 'waqr',
      displayName: 'Waqr',
    })
    api.listChatTargets.mockResolvedValue([{
      id: '#general',
      kind: 'channel',
      title: 'general',
      topic: 'Company chat',
      joined: true,
      memberCount: 2,
      unreadCount: 1,
      firstUnreadId: 'm1',
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      muted: false,
    }])
    api.listChatMembers.mockResolvedValue([])
    api.listenToChatEvents.mockResolvedValue(vi.fn())
    api.chatMessagesAround.mockResolvedValue([{
      id: 'm1',
      target: '#general',
      serverTime: '2026-01-01T00:00:00.000Z',
      senderNick: 'anna',
      body: 'hello',
    }])
    api.listChatMessages.mockResolvedValue([])
    api.setActiveChatTarget.mockResolvedValue()
    api.searchChat.mockResolvedValue([])
    api.setChatEnabled.mockResolvedValue({
      state: 'disconnected',
      endpoint: 'wss://chat.abundanceds.com/webirc',
      account: 'waqr',
      relayReady: false,
      diagnostic: null,
    })
  })

  it('opens one target at its first unread message', async () => {
    const chat = useChatStore()
    await chat.initialize()
    const anchor = await chat.selectTarget('#general')

    expect(anchor).toBe('m1')
    expect(chat.activeTarget).toBe('#general')
    expect(chat.activeMessages.map(message => message.id)).toEqual(['m1'])
    expect(chat.focusMessageId).toBe('m1')
  })

  it('keeps every unread room visible in the aggregate indicator', async () => {
    api.listChatTargets.mockResolvedValue([
      { id: '#general', kind: 'channel', unreadCount: 3, muted: false },
      { id: '#noise', kind: 'channel', unreadCount: 8, muted: true },
    ])
    const chat = useChatStore()
    await chat.initialize()
    expect(chat.unreadTotal).toBe(11)
  })

  it('never lets invalid negative unread state create an aggregate notification', async () => {
    api.listChatTargets.mockResolvedValue([
      { id: '#general', kind: 'channel', unreadCount: 0, muted: false },
      { id: '#quiet', kind: 'channel', unreadCount: -4, muted: false },
    ])
    const chat = useChatStore()
    await chat.initialize()
    expect(chat.unreadTotal).toBe(0)
  })

  it('turns chat off locally, disconnects its surface, and keeps cached data intact', async () => {
    const chat = useChatStore()
    await chat.initialize()
    chat.messagesByTarget = { '#general': [{ id: 'm1', target: '#general' }] }

    await chat.setEnabled(false)

    expect(api.setChatEnabled).toHaveBeenCalledWith(false)
    expect(chat.config.enabled).toBe(false)
    expect(chat.activeTarget).toBe('')
    expect(chat.messagesByTarget['#general']).toHaveLength(1)
  })

  it('keeps the global teammate roster when channel details load scoped members', async () => {
    const globalMembers = [
      { nick: 'anna', account: 'anna', displayName: 'Anna' },
      { nick: 'ben', account: 'ben', displayName: 'Ben' },
    ]
    api.listChatMembers.mockImplementation(target => Promise.resolve(
      target ? [globalMembers[0]] : globalMembers,
    ))
    const chat = useChatStore()
    await chat.initialize()

    await chat.refreshMembers('#general')

    expect(chat.members.map(member => member.account)).toEqual(['anna', 'ben'])
    expect(chat.membersByTarget['#general'].map(member => member.account)).toEqual(['anna'])
  })

  it('treats edit and reaction materializations as updates, not live arrivals', async () => {
    api.listChatTargets.mockResolvedValue([{
      id: '#general', kind: 'channel', joined: true, unreadCount: 0, muted: false,
    }])
    api.listChatMessages.mockResolvedValue([{
      id: 'm1', target: '#general', serverTime: '2026-01-01T00:00:00.000Z', body: 'hello',
    }])
    const chat = useChatStore()
    await chat.initialize()
    await chat.selectTarget('#general')
    const onEvent = api.listenToChatEvents.mock.calls[0][0]

    onEvent({
      type: 'message',
      notify: false,
      message: {
        id: 'm1', target: '#general', serverTime: '2026-01-01T00:00:00.000Z', body: 'edited',
      },
    })
    expect(chat.latestLiveMessage).toBeNull()
    expect(chat.activeMessages[0].body).toBe('edited')

    onEvent({
      type: 'message',
      notify: false,
      message: {
        id: 'm2', target: '#general', serverTime: '2026-01-01T00:00:01.000Z', body: 'fresh',
      },
    })
    expect(chat.latestLiveMessage?.id).toBe('m2')
    expect(chat.activeMessages.map(message => message.id)).toEqual(['m1', 'm2'])
  })

  it('keeps never-loaded rooms unloaded when live messages arrive', async () => {
    const chat = useChatStore()
    await chat.initialize()
    const onEvent = api.listenToChatEvents.mock.calls[0][0]

    onEvent({
      type: 'message',
      notify: false,
      message: {
        id: 'd1', target: 'anna', serverTime: '2026-01-01T00:00:00.000Z', body: 'hi',
      },
    })

    expect(chat.messagesByTarget.anna).toBeUndefined()
    expect(chat.latestLiveMessage?.id).toBe('d1')
  })

  it('keeps live arrivals out of a windowed room until the latest page reloads', async () => {
    const chat = useChatStore()
    await chat.initialize()
    await chat.selectTarget('#general')
    expect(chat.windowedByTarget['#general']).toBe(true)
    const onEvent = api.listenToChatEvents.mock.calls[0][0]

    onEvent({
      type: 'message',
      notify: false,
      message: {
        id: 'm9', target: '#general', serverTime: '2026-01-01T00:00:09.000Z', body: 'below the gap',
      },
    })
    expect(chat.activeMessages.map(message => message.id)).toEqual(['m1'])
    expect(chat.latestLiveMessage?.id).toBe('m9')

    api.listChatMessages.mockResolvedValue([
      { id: 'm1', target: '#general', serverTime: '2026-01-01T00:00:00.000Z', body: 'hello' },
      { id: 'm9', target: '#general', serverTime: '2026-01-01T00:00:09.000Z', body: 'below the gap' },
    ])
    await chat.loadLatest('#general')
    expect(chat.windowedByTarget['#general']).toBeUndefined()
    expect(chat.activeMessages.map(message => message.id)).toEqual(['m1', 'm9'])
  })

  it('releases the event listener when initialization fails so a retry cannot double-subscribe', async () => {
    const firstUnlisten = vi.fn()
    const secondUnlisten = vi.fn()
    api.listenToChatEvents
      .mockResolvedValueOnce(firstUnlisten)
      .mockResolvedValueOnce(secondUnlisten)
    api.chatStatus.mockRejectedValueOnce(new Error('backend not ready'))
    const chat = useChatStore()

    await expect(chat.initialize()).rejects.toThrow('backend not ready')
    expect(firstUnlisten).toHaveBeenCalledTimes(1)

    await chat.initialize()
    expect(api.listenToChatEvents).toHaveBeenCalledTimes(2)
    expect(secondUnlisten).not.toHaveBeenCalled()
  })

  it('sends to the room captured at submit time, not the room active at completion', async () => {
    api.sendChatMessage.mockResolvedValue()
    const chat = useChatStore()
    await chat.initialize()
    await chat.selectTarget('#general')

    await chat.send('hello there', null, '#product')

    expect(api.sendChatMessage).toHaveBeenCalledWith('#product', 'hello there', null)
  })

  it('keeps the newest search results when an older request finishes last', async () => {
    let finishOlder
    api.searchChat
      .mockImplementationOnce(() => new Promise(resolve => {
        finishOlder = resolve
      }))
      .mockResolvedValueOnce([{ id: 'new', target: '#general', body: 'new result' }])
    const chat = useChatStore()
    await chat.initialize()

    chat.searchState.query = 'old'
    const older = chat.runSearch()
    chat.searchState.query = 'new'
    await chat.runSearch()
    finishOlder([{ id: 'old', target: '#general', body: 'stale result' }])
    await older

    expect(chat.searchState.results.map(message => message.id)).toEqual(['new'])
    expect(chat.searchState.loading).toBe(false)
  })
})
