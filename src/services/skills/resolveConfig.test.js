import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveSkillConfig } from '../../stores/panel/chat.js'

vi.mock('../../stores/panel/skills.js', () => {
  const mockStore = {
    skills: [],
    getSkillMeta: vi.fn(),
    getSkillPrompt: vi.fn(),
    refreshSkills: vi.fn(),
    enabledSkills: [],
  }
  return {
    useSkillsStore: () => mockStore,
    _mockStore: mockStore,
  }
})

vi.mock('@ai-sdk/vue', () => ({
  Chat: vi.fn(),
}))

vi.mock('ai', () => ({
  lastAssistantMessageIsCompleteWithToolCalls: vi.fn(),
}))

vi.mock('../../services/ai/chatTransport', () => ({
  createMimChatTransport: vi.fn(),
}))

vi.mock('../../services/ai/sdkAdapter', () => ({
  addUsage: vi.fn((a, b) => ({ ...a, ...b })),
}))

vi.mock('../../services/ai/recovery', () => ({
  recoverPoisonedMessages: vi.fn(),
}))

vi.mock('../../services/ai/client', () => ({
  generateAiText: vi.fn(),
}))

vi.mock('../../stores/panel/helpers.js', () => ({
  chatInstances: new Map(),
  readHistories: new Map(),
  proposalFinal: new Map(),
  pendingApprovalMap: {},
  sanitizeLoadedMessages: vi.fn(m => m),
}))

vi.mock('../../services/attachments.js', () => ({
  toFileUIParts: vi.fn(() => []),
}))

describe('resolveSkillConfig', () => {
  let mockStore

  beforeEach(async () => {
    const mod = await import('../../stores/panel/skills.js')
    mockStore = mod._mockStore
    mockStore.getSkillMeta.mockReset()
  })

  it('returns base defaults when no skill and no project', () => {
    const session = {}

    expect(resolveSkillConfig(session, 'maxSteps')).toBe(8)
    expect(resolveSkillConfig(session, 'maxOutputTokens')).toBe(1800)
  })

  it('returns project defaults when session has projectId but no skill', () => {
    const session = { projectId: 'proj-1' }

    expect(resolveSkillConfig(session, 'maxSteps')).toBe(12)
    expect(resolveSkillConfig(session, 'maxOutputTokens')).toBe(16000)
  })

  it('returns skill-specific values when skill metadata has them', () => {
    mockStore.getSkillMeta.mockReturnValue({
      id: 'peer-review',
      name: 'Peer Review',
      maxSteps: 10,
      maxOutputTokens: 8000,
    })

    const session = { skill: 'peer-review', projectId: 'proj-1' }

    expect(resolveSkillConfig(session, 'maxSteps')).toBe(10)
    expect(resolveSkillConfig(session, 'maxOutputTokens')).toBe(8000)
  })

  it('falls back to project defaults when skill has no config overrides', () => {
    mockStore.getSkillMeta.mockReturnValue({
      id: 'mim',
      name: 'mim terminal',
    })

    const session = { skill: 'mim', projectId: 'proj-1' }

    expect(resolveSkillConfig(session, 'maxSteps')).toBe(12)
    expect(resolveSkillConfig(session, 'maxOutputTokens')).toBe(16000)
  })

  it('falls back to base defaults when skill has no config and no project', () => {
    mockStore.getSkillMeta.mockReturnValue({
      id: 'mim',
      name: 'mim terminal',
    })

    const session = { skill: 'mim' }

    expect(resolveSkillConfig(session, 'maxSteps')).toBe(8)
    expect(resolveSkillConfig(session, 'maxOutputTokens')).toBe(1800)
  })
})
