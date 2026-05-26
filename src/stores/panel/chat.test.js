import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// Set __TAURI_INTERNALS__ before chat.js module loads so isTauri is true
vi.hoisted(() => { window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {} })

// Mock heavy dependencies
vi.mock('@ai-sdk/vue', () => {
  const { ref: vueRef } = require('vue')
  class MockChat {
    constructor({ id }) {
      this.id = id
      this.state = {
        messagesRef: vueRef([]),
        statusRef: vueRef('ready'),
        errorRef: vueRef(null),
      }
      this.sendMessage = vi.fn()
      this.stop = vi.fn()
      this.regenerate = vi.fn()
    }
  }
  return { Chat: MockChat }
})

vi.mock('ai', () => ({
  lastAssistantMessageIsCompleteWithToolCalls: vi.fn(),
  generateText: vi.fn(() => Promise.resolve({ toolCalls: [] })),
  tool: vi.fn((def) => def),
}))

vi.mock('../../services/ai/chatTransport', () => ({
  createShouldersChatTransport: vi.fn(() => ({})),
}))

vi.mock('../../services/ai/sdkAdapter', () => ({
  addUsage: vi.fn((a, b) => ({ ...a, ...b })),
  createSdkModel: vi.fn(() => Promise.resolve({
    model: {},
    modelConfig: { id: 'claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5' },
  })),
  buildProviderOptions: vi.fn(() => ({})),
}))

vi.mock('../../services/ai/recovery', () => ({
  recoverPoisonedMessages: vi.fn(),
}))

vi.mock('../../services/ai/tools/gate.js', () => ({
  clearSessionAllowList: vi.fn(),
}))

vi.mock('../../services/ai/client', () => ({}))

vi.mock('./skills.js', () => ({
  useSkillsStore: () => ({
    skills: [],
    refreshSkills: vi.fn(),
    getSkillPrompt: vi.fn(),
    getSkillMeta: vi.fn(),
  }),
}))

vi.mock('../../services/telemetry.js', () => ({
  emit: vi.fn(),
}))

vi.mock('../../services/ai/modelControls', () => ({
  normalizeModelId: (id) => id || null,
  resolveDefaultModel: () => ({ id: 'test-model' }),
  modelMenuItems: (registry, keyStatuses) => {
    const models = registry?.models || []
    return models.map((m) => ({ ...m }))
  },
  modelDisplayName: (m) => m?.displayName || m?.name || m?.id || 'Model',
  providerConfigured: (keyStatuses, provider) => {
    return (keyStatuses || []).some((k) => k.provider === provider && k.configured)
  },
  resolveConcreteModel: (registry, keyStatuses, modelId) => {
    if (!modelId) return null
    return registry?.models?.find((m) => m.id === modelId) || null
  },
  controlForModel: () => ({ kind: '', label: 'Control', default: 'none', id: 'none', option: null, options: [] }),
  defaultControlId: () => 'none',
}))

vi.mock('../../services/dataDir', () => ({
  deleteSession: vi.fn(() => Promise.resolve()),
}))

// Polyfill localStorage for test env if not available
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.getItem !== 'function') {
  const store = {}
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = String(val) },
    removeItem: (key) => { delete store[key] },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]) },
  }
}

import { generateText } from 'ai'
import { clearSessionAllowList } from '../../services/ai/tools/gate.js'
import { useChatStore } from './chat.js'
import { useSessionStore } from './sessions.js'
import { chatInstances } from './helpers.js'

function makeSession(overrides = {}) {
  return {
    id: `test_session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    _savedMessages: [],
    lastError: '',
    updatedAt: new Date().toISOString(),
    proposals: [],
    usage: {},
    modelId: '',
    controlId: 'none',
    projectId: 'general',
    ...overrides,
  }
}

describe('chat store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Clear module-level chat instances between tests
    chatInstances.clear()
  })

  it('getChatInstance returns null for unknown ID', () => {
    const store = useChatStore()
    expect(store.getChatInstance('nonexistent')).toBe(null)
  })

  it('isBudgetWarning and isBudgetBlocked computeds', () => {
    const store = useChatStore()

    // Initial state — not checked
    expect(store.isBudgetWarning).toBe(false)
    expect(store.isBudgetBlocked).toBe(false)

    // Warning threshold (80% of limit)
    store._budgetState = { cost: 8, limit: 10, checked: true }
    expect(store.isBudgetWarning).toBe(true)
    expect(store.isBudgetBlocked).toBe(false)

    // At limit — blocked
    store._budgetState = { cost: 10, limit: 10, checked: true }
    expect(store.isBudgetWarning).toBe(false)
    expect(store.isBudgetBlocked).toBe(true)

    // Over limit — blocked
    store._budgetState = { cost: 12, limit: 10, checked: true }
    expect(store.isBudgetWarning).toBe(false)
    expect(store.isBudgetBlocked).toBe(true)

    // No limit set — neither
    store._budgetState = { cost: 100, limit: 0, checked: true }
    expect(store.isBudgetWarning).toBe(false)
    expect(store.isBudgetBlocked).toBe(false)
  })

  it('getDocumentContext returns _documentContext or localStorage fallback', () => {
    const store = useChatStore()

    // With content in _documentContext
    store._documentContext = { content: 'test content', path: '/test.md' }
    const ctx = store.getDocumentContext()
    expect(ctx).toEqual({ content: 'test content', path: '/test.md' })

    // Falls back to localStorage when _documentContext is empty
    store._documentContext = { content: '', path: '' }
    // localStorage is mocked in jsdom, so it should return empty
    const fallback = store.getDocumentContext()
    expect(fallback.content).toBe('')
  })

  it('_chatVersion increments on getOrCreateChat and destroyChat', () => {
    const store = useChatStore()
    const initialVersion = store._chatVersion

    // Create a mock session
    const session = makeSession({ id: 'test_session_1' })

    store.getOrCreateChat(session)
    expect(store._chatVersion).toBe(initialVersion + 1)

    // Creating again should not increment (already exists)
    store.getOrCreateChat(session)
    expect(store._chatVersion).toBe(initialVersion + 1)

    // Destroying should increment
    store.destroyChat(session.id)
    expect(store._chatVersion).toBe(initialVersion + 2)

    // Destroying non-existent should not increment
    store.destroyChat('nonexistent')
    expect(store._chatVersion).toBe(initialVersion + 2)
  })

  // ---- getOrCreateChat lifecycle ----

  it('getOrCreateChat returns a chat instance and is idempotent', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'lifecycle_1' })

    const chat1 = store.getOrCreateChat(session)
    expect(chat1).toBeTruthy()
    expect(chat1.id).toBe('lifecycle_1')

    const chat2 = store.getOrCreateChat(session)
    expect(chat2).toBe(chat1) // same reference
  })

  it('getOrCreateChat only increments _chatVersion on first create', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'lifecycle_version' })
    const v0 = store._chatVersion

    store.getOrCreateChat(session)
    expect(store._chatVersion).toBe(v0 + 1)

    store.getOrCreateChat(session)
    store.getOrCreateChat(session)
    expect(store._chatVersion).toBe(v0 + 1) // no further increments
  })

  // ---- destroyChat cleanup ----

  it('destroyChat removes chat so getChatInstance returns null', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'destroy_1' })

    store.getOrCreateChat(session)
    expect(store.getChatInstance('destroy_1')).toBeTruthy()

    store.destroyChat('destroy_1')
    expect(store.getChatInstance('destroy_1')).toBe(null)
  })

  it('destroyChat increments _chatVersion', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'destroy_version' })
    store.getOrCreateChat(session)
    const vBefore = store._chatVersion

    store.destroyChat('destroy_version')
    expect(store._chatVersion).toBe(vBefore + 1)
  })

  it('destroyChat calls stop() on the chat instance', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'destroy_stop' })
    const chat = store.getOrCreateChat(session)

    store.destroyChat('destroy_stop')
    expect(chat.stop).toHaveBeenCalled()
  })

  it('destroyChat clears the session allow list', () => {
    const store = useChatStore()
    const session = makeSession({ id: 'destroy_gate' })
    store.getOrCreateChat(session)
    clearSessionAllowList.mockClear()

    store.destroyChat('destroy_gate')

    expect(clearSessionAllowList).toHaveBeenCalled()
  })

  // ---- activeMessages computed ----

  it('activeMessages returns empty array when no active session', () => {
    const store = useChatStore()
    expect(store.activeMessages).toEqual([])
  })

  it('activeMessages returns messagesRef value when active session has chat', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    const testMessages = [{ role: 'user', content: 'hello' }]
    chatInstance.state.messagesRef.value = testMessages

    expect(chat.activeMessages).toEqual(testMessages)
  })

  // ---- activeStatus computed ----

  it('activeStatus returns "ready" when no active session', () => {
    const store = useChatStore()
    expect(store.activeStatus).toBe('ready')
  })

  it('activeStatus returns chat statusRef value when active session has chat', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    chatInstance.state.statusRef.value = 'streaming'

    expect(chat.activeStatus).toBe('streaming')
  })

  // ---- composerStatus computed ----

  it('composerStatus returns "Working" when isActiveBusy', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    chatInstance.state.statusRef.value = 'streaming'

    expect(chat.composerStatus).toBe('Working')
  })

  it('composerStatus returns "Needs attention" when activeError is set', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    chatInstance.state.errorRef.value = { message: 'Something went wrong' }

    expect(chat.composerStatus).toBe('Needs attention')
  })

  it('composerStatus returns "Needs attention" when session.lastError is set', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    chat.getOrCreateChat(session)
    session.lastError = 'Network error'

    expect(chat.composerStatus).toBe('Needs attention')
  })

  it('composerStatus returns "Awaiting review" when session has pending proposals', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    chat.getOrCreateChat(session)
    session.proposals.push({ id: 'p1', status: 'pending' })

    // canUseSessionModel returns false (resolveConcreteModel returns null for empty modelId),
    // so composerStatus would be 'Add API key' before it checks proposals.
    // We need a model that resolveConcreteModel can find.
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    expect(chat.composerStatus).toBe('Awaiting review')
  })

  it('composerStatus returns "Add API key" when model is not configured', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    chat.getOrCreateChat(session)

    // Default empty model resolves to null, so canUseSessionModel is false
    expect(chat.composerStatus).toBe('Add API key')
  })

  // ---- sendMessage guards ----

  it('sendMessage does nothing when no active session', async () => {
    const chat = useChatStore()
    // No session created — should just return without throwing
    await chat.sendMessage('hello')
    // No error thrown means the guard worked
  })

  it('sendMessage does nothing with empty text', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    // Set up a model so canUseSessionModel is true
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)

    await chat.sendMessage('')
    await chat.sendMessage('   ')
    expect(chatInstance.sendMessage).not.toHaveBeenCalled()
  })

  it('sendMessage wraps text attachments in attached-file XML', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)

    await chat.sendMessage('summarize this', [
      { type: 'text', filename: 'notes.md', mediaType: 'text/markdown', content: 'hello world', size: 11 },
    ])

    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
    const sentMsg = chatInstance.sendMessage.mock.calls[0][0]
    expect(sentMsg.text).toContain('<attached-file name="notes.md">')
    expect(sentMsg.text).toContain('hello world')
    expect(sentMsg.text).toContain('summarize this')
  })

  it('sendMessage passes binary attachments as files', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)

    await chat.sendMessage('describe this image', [
      { type: 'image', filename: 'photo.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,abc', size: 1024 },
    ])

    expect(chatInstance.sendMessage).toHaveBeenCalledTimes(1)
    const sentMsg = chatInstance.sendMessage.mock.calls[0][0]
    expect(sentMsg.text).toBe('describe this image')
    expect(sentMsg.files).toBeDefined()
    expect(sentMsg.files.length).toBeGreaterThan(0)
  })

  it('sendMessage does nothing when isActiveBusy', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    chatInstance.state.statusRef.value = 'streaming'

    await chat.sendMessage('hello')
    expect(chatInstance.sendMessage).not.toHaveBeenCalled()
  })

  // ---- getDocumentContext edge cases ----

  it('getDocumentContext falls back to localStorage when _documentContext is empty', () => {
    const store = useChatStore()
    store._documentContext = { content: '', path: '' }

    localStorage.setItem('shoulders:doc', 'stored content')
    localStorage.setItem('shoulders:doc:path', '/stored/path.md')

    const ctx = store.getDocumentContext()
    expect(ctx.content).toBe('stored content')
    expect(ctx.path).toBe('/stored/path.md')

    // Clean up
    localStorage.removeItem('shoulders:doc')
    localStorage.removeItem('shoulders:doc:path')
  })

  it('getDocumentContext returns _documentContext directly when it has content', () => {
    const store = useChatStore()
    // Set localStorage to something — should be ignored
    localStorage.setItem('shoulders:doc', 'should be ignored')
    localStorage.setItem('shoulders:doc:path', '/ignored.md')

    store._documentContext = { content: 'direct content', path: '/direct.md' }
    const ctx = store.getDocumentContext()
    expect(ctx.content).toBe('direct content')
    expect(ctx.path).toBe('/direct.md')

    // Clean up
    localStorage.removeItem('shoulders:doc')
    localStorage.removeItem('shoulders:doc:path')
  })

  // ---- activeError computed ----

  it('activeError returns empty string when no active session', () => {
    const store = useChatStore()
    expect(store.activeError).toBe('')
  })

  it('activeError returns chat errorRef message when set', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)
    chatInstance.state.errorRef.value = { message: 'test error' }

    expect(chat.activeError).toBe('test error')
  })

  it('activeError falls back to session.lastError', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    chat.getOrCreateChat(session)
    session.lastError = 'session-level error'

    expect(chat.activeError).toBe('session-level error')
  })

  // ---- isActiveBusy / canSend ----

  it('isActiveBusy is true for submitted and streaming statuses', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)

    const chat = useChatStore()
    const chatInstance = chat.getOrCreateChat(session)

    chatInstance.state.statusRef.value = 'submitted'
    expect(chat.isActiveBusy).toBe(true)

    chatInstance.state.statusRef.value = 'streaming'
    expect(chat.isActiveBusy).toBe(true)

    chatInstance.state.statusRef.value = 'ready'
    expect(chat.isActiveBusy).toBe(false)
  })

  it('canSend is false when no session, busy, or model not configured', () => {
    const chat = useChatStore()
    // No session
    expect(chat.canSend).toBe(false)

    // With session but model not configured (auto resolves to null)
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    chat.getOrCreateChat(session)
    expect(chat.canSend).toBe(false)

    // Configure model
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    expect(chat.canSend).toBe(true)

    // Make busy
    const chatInstance = chat.getChatInstance(session.id)
    chatInstance.state.statusRef.value = 'streaming'
    expect(chat.canSend).toBe(false)
  })

  // ---- Context window blocking ----

  it('isContextBlocked is false when no active session', () => {
    const chat = useChatStore()
    expect(chat.isContextBlocked).toBe(false)
  })

  it('isContextBlocked is false when session has no lastInputTokens', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    expect(chat.isContextBlocked).toBe(false)
  })

  it('isContextBlocked is false when tokens are under the context window', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.lastInputTokens = 150000

    const chat = useChatStore()
    expect(chat.isContextBlocked).toBe(false)
  })

  it('isContextBlocked is true when tokens reach the context window', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.lastInputTokens = 200000

    const chat = useChatStore()
    expect(chat.isContextBlocked).toBe(true)
  })

  it('isContextBlocked is true when tokens exceed the context window', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.lastInputTokens = 210000

    const chat = useChatStore()
    expect(chat.isContextBlocked).toBe(true)
  })

  it('canSend is false when context window is exceeded', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.lastInputTokens = 200000

    const chat = useChatStore()
    chat.getOrCreateChat(session)
    expect(chat.canSend).toBe(false)
  })

  it('canSend is true when tokens are under the context window', () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test', contextWindow: 200000 }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.lastInputTokens = 100000

    const chat = useChatStore()
    chat.getOrCreateChat(session)
    expect(chat.canSend).toBe(true)
  })

  // ---- Auto-unarchive on send ----

  it('sendMessage auto-unarchives an archived session', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'
    session.archived = true
    sessions.archivedMetas.push({ id: session.id, projectId: session.projectId, label: session.label })

    const chat = useChatStore()
    chat.getOrCreateChat(session)

    await chat.sendMessage('continue this thread')

    expect(session.archived).toBe(false)
    expect(sessions.archivedMetas.some(m => m.id === session.id)).toBe(false)
  })

  it('sendMessage does not change archived status for non-archived sessions', async () => {
    const sessions = useSessionStore()
    const session = sessions.createSession()
    sessions.selectSession(session.id)
    sessions.registry = { models: [{ id: 'test-model', provider: 'test' }] }
    sessions.keyStatuses = [{ provider: 'test', configured: true }]
    session.modelId = 'test-model'

    const chat = useChatStore()
    chat.getOrCreateChat(session)

    await chat.sendMessage('hello')

    expect(session.archived).toBe(false)
  })

  // ---- Auto-title generation ----
  // autoGenerateTitle checks isTauri (false in tests) so we test _doGenerateTitle
  // indirectly by temporarily setting __TAURI_INTERNALS__ on window.

  describe('autoGenerateTitle', () => {
    function makeSessionWithChat(sessions, chat) {
      const session = sessions.createSession()
      sessions.selectSession(session.id)
      const chatInstance = chat.getOrCreateChat(session)
      return { session, chatInstance }
    }

    function setMessages(chatInstance, userText, assistantText) {
      chatInstance.state.messagesRef.value = [
        { role: 'user', parts: [{ type: 'text', text: userText }] },
        { role: 'assistant', parts: [{ type: 'text', text: assistantText }] },
      ]
    }

    async function triggerTitleGeneration(chatInstance) {
      chatInstance.state.statusRef.value = 'streaming'
      await vi.dynamicImportSettled()
      chatInstance.state.statusRef.value = 'ready'
      await vi.dynamicImportSettled()
      await new Promise((r) => setTimeout(r, 50))
    }

    it('sets title and keywords from tool call result', async () => {
      generateText.mockResolvedValueOnce({
        toolCalls: [{
          type: 'tool-call',
          toolName: 'set_title',
          input: { title: 'My Generated Title', keywords: ['test', 'chat'] },
        }],
      })

      const sessions = useSessionStore()
      const chat = useChatStore()
      const { session, chatInstance } = makeSessionWithChat(sessions, chat)
      setMessages(chatInstance, 'Hello there', 'Hi, how can I help?')

      await triggerTitleGeneration(chatInstance)

      expect(session.label).toBe('My Generated Title')
      expect(session.keywords).toEqual(['test', 'chat'])
      expect(session._aiTitle).toBe(true)
    })

    it('does not overwrite title when tool call has no title', async () => {
      generateText.mockResolvedValueOnce({ toolCalls: [] })

      const sessions = useSessionStore()
      const chat = useChatStore()
      const { session, chatInstance } = makeSessionWithChat(sessions, chat)
      session.label = 'Original Label'
      setMessages(chatInstance, 'Hello', 'Hi')

      await triggerTitleGeneration(chatInstance)

      expect(session.label).toBe('Original Label')
    })

    it('does not generate title twice (_aiTitle flag)', async () => {
      generateText.mockResolvedValue({
        toolCalls: [{
          type: 'tool-call',
          toolName: 'set_title',
          input: { title: 'Title', keywords: [] },
        }],
      })

      const sessions = useSessionStore()
      const chat = useChatStore()
      const { session, chatInstance } = makeSessionWithChat(sessions, chat)
      setMessages(chatInstance, 'Hello', 'Hi')

      await triggerTitleGeneration(chatInstance)
      generateText.mockClear()

      await triggerTitleGeneration(chatInstance)
      expect(generateText).not.toHaveBeenCalled()
    })

    it('resets _aiTitle on failure so it can retry', async () => {
      generateText.mockRejectedValueOnce(new Error('API down'))

      const sessions = useSessionStore()
      const chat = useChatStore()
      const { session, chatInstance } = makeSessionWithChat(sessions, chat)
      setMessages(chatInstance, 'Hello', 'Hi')

      await triggerTitleGeneration(chatInstance)

      expect(session._aiTitle).toBe(false)
    })

    it('truncates title to 60 characters', async () => {
      const longTitle = 'A'.repeat(100)
      generateText.mockResolvedValueOnce({
        toolCalls: [{
          type: 'tool-call',
          toolName: 'set_title',
          input: { title: longTitle, keywords: [] },
        }],
      })

      const sessions = useSessionStore()
      const chat = useChatStore()
      const { session, chatInstance } = makeSessionWithChat(sessions, chat)
      setMessages(chatInstance, 'Hello', 'Hi')

      await triggerTitleGeneration(chatInstance)

      expect(session.label.length).toBe(60)
    })
  })

  // ---- Approval queue ----

  describe('approval queue', () => {
    async function getApprovalHandler(session) {
      const chat = useChatStore()
      const config = await chat.buildChatConfig(session)
      return config.toolContext.onApprovalRequest
    }

    it('queues concurrent requests and resolves in order', async () => {
      const sessions = useSessionStore()
      const session = sessions.createSession()
      const chat = useChatStore()
      const handler = await getApprovalHandler(session)

      const p1 = handler('edit', { target: 'a.md' }, { risk: 'medium' })
      const p2 = handler('search', { query: 'test' }, { risk: 'low' })

      expect(chat.getPendingApproval(session.id)?.toolName).toBe('edit')

      chat.resolveApproval(session.id, { approved: true })
      expect((await p1).approved).toBe(true)

      expect(chat.getPendingApproval(session.id)?.toolName).toBe('search')

      chat.resolveApproval(session.id, { approved: false })
      expect((await p2).approved).toBe(false)

      expect(chat.getPendingApproval(session.id)).toBe(null)
    })

    it('resolveApproval with all=true drains entire queue', async () => {
      const sessions = useSessionStore()
      const session = sessions.createSession()
      const chat = useChatStore()
      const handler = await getApprovalHandler(session)

      const p1 = handler('edit', {}, {})
      const p2 = handler('search', {}, {})
      const p3 = handler('run', {}, {})

      chat.resolveApproval(session.id, { approved: false }, true)

      const results = await Promise.all([p1, p2, p3])
      expect(results.every(r => r.approved === false)).toBe(true)
      expect(chat.getPendingApproval(session.id)).toBe(null)
    })

    it('single approval still works without queuing', async () => {
      const sessions = useSessionStore()
      const session = sessions.createSession()
      const chat = useChatStore()
      const handler = await getApprovalHandler(session)

      const p = handler('edit', { target: 'file.md' }, { risk: 'low' })

      expect(chat.getPendingApproval(session.id)?.toolName).toBe('edit')

      chat.resolveApproval(session.id, { approved: true, alwaysAllow: true })
      expect((await p).alwaysAllow).toBe(true)
      expect(chat.getPendingApproval(session.id)).toBe(null)
    })
  })
})
