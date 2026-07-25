import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@ai-sdk/vue', () => {
  const { ref: vueRef } = require('vue')
  class MockChat {
    constructor({ id, messages = [] }) {
      this.id = id
      this.state = {
        messagesRef: vueRef(messages),
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
}))

vi.mock('../../services/ai/chatTransport', () => ({
  createMimChatTransport: vi.fn(() => ({})),
}))

vi.mock('../../services/ai/sdkAdapter', () => ({
  addUsage: vi.fn((a, b) => ({ ...a, ...b })),
}))

vi.mock('../../services/ai/recovery', () => ({
  recoverPoisonedMessages: vi.fn(),
}))

vi.mock('../../services/ai/client', () => ({
  generateAiText: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../services/ai/modelControls', () => ({
  normalizeModelId: (id) => id || null,
  resolveDefaultModel: () => ({ id: 'test-model' }),
  modelMenuItems: () => [],
  modelDisplayName: (model) => model?.displayName || model?.name || model?.id || 'Model',
  providerConfigured: vi.fn(() => true),
  resolveConcreteModel: vi.fn(() => null),
  controlForModel: () => ({ kind: '', label: 'Control', default: 'none', id: 'none', option: null, options: [] }),
  defaultControlId: () => 'none',
}))

vi.mock('../../services/dataDir', () => ({
  deleteSession: vi.fn(() => Promise.resolve()),
}))

const _mockRecentAppIds = { value: [] }
vi.mock('../settings.js', () => {
  return {
    useSettingsStore: () => ({
      get recentAppIds() { return _mockRecentAppIds.value },
      set(key, value) {
        if (key === 'recentAppIds') _mockRecentAppIds.value = value
      },
    }),
  }
})

vi.mock('./persistence.js', () => ({
  schedulePersist: vi.fn(),
}))

vi.mock('../../services/ai/tools/gate.js', () => ({
  clearSessionAllowList: vi.fn(),
}))

import { clearSessionAllowList } from '../../services/ai/tools/gate.js'
import * as actions from './actions.js'
import { useChatStore } from './chat.js'
import { chatInstances } from './helpers.js'
import { useProjectStore } from './projects.js'
import { useSessionStore } from './sessions.js'
import { useAppStore } from './apps.js'

function addProject(id = 'project_1') {
  const projStore = useProjectStore()
  projStore.projects.push({
    id,
    name: 'Project',
    path: '',
    workspacePath: null,
    system: false,
    createdAt: new Date().toISOString(),
  })
  return id
}

describe('panel cross-store actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chatInstances.clear()
  })

  it('replaces the active unstarted project chat instead of accumulating drafts', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const first = await actions.startProjectChat(projectId)
    const second = await actions.startProjectChat(projectId)

    expect(sessionStore.sessions).toHaveLength(1)
    expect(sessionStore.sessions[0].id).toBe(second.id)
    expect(sessionStore.sessions.some((s) => s.id === first.id)).toBe(false)
  })

  it('keeps a project chat once it has messages', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const first = await actions.startProjectChat(projectId)
    chatStore.getChatInstance(first.id).state.messagesRef.value = [{ id: 'm1', role: 'user', parts: [] }]
    const second = await actions.startProjectChat(projectId)

    expect(sessionStore.sessions).toHaveLength(2)
    expect(sessionStore.sessions.map((s) => s.id)).toContain(first.id)
    expect(sessionStore.sessions.map((s) => s.id)).toContain(second.id)
  })

  it('selectSession skips chat creation for app sessions', () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const appSession = sessionStore.createSession(null, {
      projectId,
      type: 'app',
      appId: 'test-app',
      appName: 'Test App',
      appStatus: 'running',
    })

    actions.selectSession(appSession.id)

    expect(chatInstances.has(appSession.id)).toBe(false)
    expect(sessionStore.activeSessionId).toBe(appSession.id)
  })

  it('does not discard app sessions when creating a new chat', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const appSession = sessionStore.createSession(null, {
      projectId,
      type: 'app',
      appId: 'test-app',
      appName: 'Test App',
      appStatus: 'running',
    })
    sessionStore.selectSession(appSession.id)

    await actions.startProjectChat(projectId)

    expect(sessionStore.sessions.some((s) => s.id === appSession.id)).toBe(true)
  })

  it('launchApp creates an app session and tracks usage', async () => {
    const projectId = addProject()
    const appStore = useAppStore()
    const sessionStore = useSessionStore()

    appStore.apps = [{ id: 'my-app', name: 'My App' }]

    const session = await actions.launchApp('my-app', projectId)

    expect(session).not.toBe(null)
    expect(session.type).toBe('app')
    expect(session.appId).toBe('my-app')
    expect(session.appName).toBe('My App')
    expect(session.appStatus).toBe('ready')
    expect(session.appEvents).toEqual([])
    expect(sessionStore.activeSessionId).toBe(session.id)
  })

  it('launchApp returns null for unknown app', async () => {
    addProject()
    const appStore = useAppStore()
    appStore.apps = []

    const session = await actions.launchApp('nonexistent')
    expect(session).toBe(null)
  })

  it('launchApp sets appStatus to setup when app has setup fields', async () => {
    const projectId = addProject()
    const appStore = useAppStore()

    appStore.apps = [{
      id: 'setup-app',
      name: 'Setup App',
      setup: { fields: [{ name: 'input1', type: 'text' }] },
    }]

    const session = await actions.launchApp('setup-app', projectId)

    expect(session.appStatus).toBe('setup')
  })

  // ---- forkFromMessage ----

  it('forkFromMessage creates a new session with messages up to the given index', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    session.label = 'Original chat'
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Follow up' }] },
      { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] },
    ]

    const forked = await actions.forkFromMessage(session.id, 1)

    expect(forked).not.toBe(null)
    expect(forked.id).not.toBe(session.id)
    expect(sessionStore.sessions).toHaveLength(2)
    expect(forked._savedMessages).toHaveLength(2)
    expect(forked._savedMessages[0].parts[0].text).toBe('Hello')
    expect(forked._savedMessages[1].parts[0].text).toBe('Hi there')
  })

  it('forkFromMessage preserves projectId, modelId, skill and controlId', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    session.skill = 'peer-review'
    session.controlId = 'think-hard'
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ]

    const forked = await actions.forkFromMessage(session.id, 0)

    expect(forked.projectId).toBe(projectId)
    expect(forked.modelId).toBe(session.modelId)
    expect(forked.skill).toBe('peer-review')
    expect(forked.controlId).toBe('think-hard')
  })

  it('forkFromMessage labels with "Branch of [original]"', async () => {
    const projectId = addProject()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    session.label = 'My analysis'
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    ]

    const forked = await actions.forkFromMessage(session.id, 0)

    expect(forked.label).toBe('Branch of My analysis')
  })

  it('forkFromMessage cleans messages (strips incomplete tool parts)', async () => {
    const projectId = addProject()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Do it' }] },
      {
        id: 'm2', role: 'assistant', parts: [
          { type: 'text', text: 'Ok' },
          { type: 'tool-invocation', toolName: 'read', state: 'input-available', input: {} },
        ],
      },
    ]

    const forked = await actions.forkFromMessage(session.id, 1)

    const assistantParts = forked._savedMessages[1].parts
    expect(assistantParts.some(p => p.type === 'tool-invocation' && p.state === 'input-available')).toBe(false)
  })

  it('forkFromMessage returns the new session as active', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ]

    const forked = await actions.forkFromMessage(session.id, 0)

    expect(sessionStore.activeSessionId).toBe(forked.id)
  })

  it('forkFromMessage returns null for unknown session', async () => {
    addProject()
    const result = await actions.forkFromMessage('nonexistent', 0)
    expect(result).toBe(null)
  })

  // ---- Archive: flushChatToSession ----

  it('archiveActiveSession preserves chat messages in _savedMessages', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
    ]
    sessionStore.selectSession(session.id)

    actions.archiveActiveSession()

    expect(session.archived).toBe(true)
    expect(session._savedMessages).toHaveLength(2)
    expect(session._savedMessages[0].parts[0].text).toBe('hello')
    expect(session._savedMessages[1].parts[0].text).toBe('hi there')
  })

  it('doneSession preserves chat messages in _savedMessages', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
      { id: 'm3', role: 'assistant', parts: [{ type: 'tool-invocation', toolName: 'read_file', toolCallId: 'tc1', input: { path: '/a.md' }, state: 'output-available', output: 'ok' }] },
    ]
    sessionStore.selectSession(session.id)

    actions.doneSession()

    expect(session.archived).toBe(true)
    expect(session._savedMessages).toHaveLength(3)
    expect(session._savedMessages[2].parts[0].toolName).toBe('read_file')
  })

  it('cleanUpProject preserves messages for all archived sessions', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const s1 = await actions.startProjectChat(projectId)
    const chat1 = chatStore.getChatInstance(s1.id)
    chat1.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
    ]

    actions.cleanUpProject(projectId)

    expect(s1.archived).toBe(true)
    expect(s1._savedMessages).toHaveLength(2)
    expect(s1._savedMessages[1].parts[0].text).toBe('reply')
  })

  // ---- Archive: view without unarchiving ----

  it('viewArchivedSession loads session without unarchiving', async () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()
    const chatStore = useChatStore()

    const session = await actions.startProjectChat(projectId)
    const chat = chatStore.getChatInstance(session.id)
    chat.state.messagesRef.value = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ]
    sessionStore.selectSession(session.id)
    actions.doneSession()

    expect(session.archived).toBe(true)

    const viewed = await actions.viewArchivedSession(projectId, session.id)

    expect(viewed).not.toBe(null)
    expect(viewed.archived).toBe(true)
    expect(sessionStore.activeSessionId).toBe(session.id)
    expect(chatInstances.has(session.id)).toBe(true)
  })

  it('selectSession creates chat for archived sessions', () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const session = sessionStore.createSession(null, { projectId })
    session.archived = true

    actions.selectSession(session.id)

    expect(chatInstances.has(session.id)).toBe(true)
    expect(sessionStore.activeSessionId).toBe(session.id)
  })

  it('selectSession clears the session allow list so tool approvals do not carry over', () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const s1 = sessionStore.createSession(null, { projectId })
    const s2 = sessionStore.createSession(null, { projectId })

    actions.selectSession(s1.id)
    clearSessionAllowList.mockClear()

    actions.selectSession(s2.id)

    expect(clearSessionAllowList).toHaveBeenCalled()
  })

  it('unarchiveSession sets archived to false and creates chat', () => {
    const projectId = addProject()
    const sessionStore = useSessionStore()

    const session = sessionStore.createSession(null, { projectId })
    session.archived = true
    sessionStore.archivedMetas.push({ id: session.id, projectId, label: session.label })

    actions.unarchiveSession(session.id)

    expect(session.archived).toBe(false)
    expect(sessionStore.archivedMetas.some(m => m.id === session.id)).toBe(false)
    expect(chatInstances.has(session.id)).toBe(true)
  })
})
