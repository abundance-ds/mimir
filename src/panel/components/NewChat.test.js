import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createShouldersChatTransport: vi.fn() }))
vi.mock('../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('../../services/ai/modelControls', () => ({
  controlForModel: () => ({ id: '', label: '', options: [] }),
  defaultControlId: () => '',
  modelDisplayName: () => '',
  modelMenuItems: () => [],
  normalizeModelId: (id) => id || null,
  providerConfigured: () => false,
  resolveConcreteModel: () => 'test',
  resolveDefaultModel: () => ({ id: 'test-model' }),
}))
vi.mock('../../stores/panel/persistence', () => ({
  schedulePersist: vi.fn(),
  loadInitialState: vi.fn(),
}))
vi.mock('../../stores/panel/apps.js', () => {
  const { ref, computed } = require('vue')
  const _apps = ref([])
  const store = {
    apps: _apps,
    recentApps: computed(() => []),
    recentAppIds: ref([]),
    discover: vi.fn(),
    trackUsage: vi.fn(),
    getApp: vi.fn(() => null),
    deleteApp: vi.fn(),
  }
  return {
    useAppStore: () => store,
  }
})
vi.mock('../../services/skills/loader', () => ({
  discoverSkills: vi.fn(() => Promise.resolve([
    { id: 'peer-review', name: 'Peer Review', description: 'Multi-agent academic manuscript review' },
    { id: 'shoulders-meta', name: 'Shoulders Meta', description: 'App reference and contextual help' },
    { id: 'workflow-builder', name: 'Workflow Builder', description: 'Chat-guided workflow creation' },
    { id: 'code-review', name: 'Code Review', description: 'Structured review with checklist' },
    { id: 'latex-helper', name: 'LaTeX Helper', description: 'Formatting and equations' },
    { id: 'citation-scout', name: 'Citation Scout', description: 'Find and verify references' },
    { id: 'data-analysis', name: 'Data Analysis', description: 'R and Python data exploration' },
    { id: 'app-builder', name: 'App Builder', description: 'Build standalone HTML tools' },
  ])),
  readSkillPrompt: vi.fn(() => Promise.resolve('')),
  importSkillFromFolder: vi.fn(),
  importSkillFromFile: vi.fn(),
  createSkillTemplate: vi.fn(),
  removeSkill: vi.fn(),
}))

import { flushPromises } from '@vue/test-utils'
import NewChat from './NewChat.vue'
import { useSessionStore } from '../../stores/panel/sessions.js'

async function factory() {
  const w = shallowMount(NewChat, {
    global: {
      stubs: {
        Composer: {
          name: 'Composer',
          template: '<div class="composer-stub"></div>',
          props: ['modelId', 'models', 'controlId', 'controlLabel', 'controlOptions', 'disabled', 'busy', 'canSend', 'costLabel', 'skills', 'projectFiles', 'hasDocument', 'supportsVision', 'contextPercent', 'contextTokens', 'contextWindow', 'showUsageIndicators'],
          methods: { focus() {}, clearContextChips() {} },
          setup() { return { draft: '', contextChips: [], attachments: [] } },
        },
        IconX: true,
        IconInbox: true,
        IconFolder: true,
        IconChevronDown: true,
        IconBolt: true,
        IconRepeat: true,
        IconChevronRight: true,
        IconFileText: true,
      },
    },
  })
  await flushPromises()
  return w
}

describe('NewChat', () => {
  beforeEach(() => {
    const sessionStore = useSessionStore()
    sessionStore.sessions = [{
      id: 'draft-1',
      label: 'New chat',
      projectId: 'general',
      modelId: 'test-model',
      controlId: '',
      archived: false,
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _savedMessages: [],
      proposals: [],
      usage: {},
    }]
    sessionStore.activeSessionId = 'draft-1'
  })

  it('renders without error', async () => {
    expect((await factory()).exists()).toBe(true)
  })

  it('renders heading', async () => {
    const w = await factory()
    const heading = w.find('h1.nc-heading')
    expect(heading.exists()).toBe(true)
    expect(heading.text()).toContain('What should we work on')
  })

  it('renders the Composer component', async () => {
    const w = await factory()
    expect(w.find('.composer-stub').exists()).toBe(true)
  })

  it('shows project picker with Personal selected', async () => {
    const w = await factory()
    const trigger = w.find('.nc-project-trigger')
    const staticEl = w.find('.nc-project-static')
    const picker = trigger.exists() ? trigger : staticEl
    expect(picker.exists()).toBe(true)
    expect(picker.text()).toContain('Personal')
  })

  it('passes skills to Composer', async () => {
    const w = await factory()
    const composer = w.findComponent({ name: 'Composer' })
    expect(composer.props('skills').length).toBeGreaterThan(0)
  })

  it('passes projectFiles to Composer', async () => {
    const w = await factory()
    const composer = w.findComponent({ name: 'Composer' })
    expect(composer.props('projectFiles')).toEqual([])
  })

  it('passes hasDocument to Composer', async () => {
    const w = await factory()
    const composer = w.findComponent({ name: 'Composer' })
    expect(composer.props('hasDocument')).toBe(false)
  })

  it('page does not scroll', async () => {
    const w = await factory()
    const scroll = w.find('.nc-scroll')
    expect(scroll.exists()).toBe(true)
  })
})
