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
      endpoint: 'wss://chat.shoulde.rs/webirc',
      account: 'waqr',
      relayReady: true,
      diagnostic: null,
    })
    api.chatConfig.mockResolvedValue({
      endpoint: 'wss://chat.shoulde.rs/webirc',
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
      endpoint: 'wss://chat.shoulde.rs/webirc',
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
