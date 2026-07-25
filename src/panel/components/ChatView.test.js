import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'

// Mock all transitive deps pulled in by the chat store / actions
vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../../services/ai/chatTransport', () => ({ createMimChatTransport: vi.fn() }))
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

import ChatView from './ChatView.vue'
import { useSessionStore } from '../../stores/panel/sessions.js'
import { useChatStore } from '../../stores/panel/chat.js'
import { useProjectStore } from '../../stores/panel/projects.js'
import { useSettingsStore } from '../../stores/settings.js'
import { invoke } from '@tauri-apps/api/core'

function factory() {
  return shallowMount(ChatView)
}

describe('ChatView', () => {
  beforeEach(() => {
    const sessionStore = useSessionStore()
    sessionStore.sessions = [{
      id: 'test-session',
      label: 'Test Chat',
      projectId: 'general',
      modelId: 'claude-test',
      controlId: '',
      archived: false,
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _savedMessages: [],
      proposals: [],
      usage: { estimatedCost: 0.05 },
    }]
    sessionStore.activeSessionId = 'test-session'
  })

  it('renders without error', () => {
    const wrapper = factory()
    expect(wrapper.exists()).toBe(true)
  })


  it('renders the Composer component', () => {
    const wrapper = factory()
    const composer = wrapper.findComponent({ name: 'Composer' })
    expect(composer.exists()).toBe(true)
  })

  it('renders action bar when pending proposals exist', async () => {
    const sessionStore = useSessionStore()
    const wrapper = factory()
    sessionStore.activeSession.proposals = [
      { id: 'p1', path: 'test.md', status: 'pending', targetText: 'old', replacement: 'new' },
    ]
    await wrapper.vm.$nextTick()
    const bar = wrapper.findComponent({ name: 'ProposalActionBar' })
    expect(bar.exists()).toBe(true)
  })

  it('does not show chat-error when there is no error', () => {
    const wrapper = factory()
    expect(wrapper.find('.chat-error').exists()).toBe(false)
  })

  // ---- Below-row: project name ----

  it('shows project name in below-row', () => {
    const projStore = useProjectStore()
    projStore.projects = [
      { id: 'general', name: 'General', system: true },
      { id: 'my-proj', name: 'My Project', system: false },
    ]
    const sessionStore = useSessionStore()
    sessionStore.sessions[0].projectId = 'my-proj'
    const wrapper = factory()
    const projectLabel = wrapper.find('.chat-project-name')
    expect(projectLabel.exists()).toBe(true)
    expect(projectLabel.text()).toContain('My Project')
  })

  // ---- Below-row: approval picker ----

  it('shows approval mode trigger with current mode', () => {
    const settingsStore = useSettingsStore()
    settingsStore.aiApprovalMode = 'normal'
    const wrapper = factory()
    const trigger = wrapper.find('.approval-trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('normal')
  })

  it('opens approval menu on click', async () => {
    const wrapper = factory()
    expect(wrapper.find('.approval-menu').exists()).toBe(false)
    await wrapper.find('.approval-trigger').trigger('click')
    expect(wrapper.find('.approval-menu').exists()).toBe(true)
    const options = wrapper.findAll('.approval-option')
    expect(options).toHaveLength(3)
  })

  it('selecting a mode closes the menu', async () => {
    const wrapper = factory()
    await wrapper.find('.approval-trigger').trigger('click')
    expect(wrapper.find('.approval-menu').exists()).toBe(true)
    const options = wrapper.findAll('.approval-option')
    await options[2].trigger('click') // click "Bypass Approval"
    expect(wrapper.find('.approval-menu').exists()).toBe(false)
  })

  // ---- Proposal action bar ----

  describe('proposal action bar', () => {
    it('shows ProposalActionBar when proposals are pending', async () => {
      const sessionStore = useSessionStore()
      sessionStore.activeSession.proposals = [
        { id: 'p1', path: 'a.md', status: 'pending', targetText: 'a', replacement: 'b' },
      ]
      const wrapper = factory()
      await wrapper.vm.$nextTick()
      const bar = wrapper.findComponent({ name: 'ProposalActionBar' })
      expect(bar.exists()).toBe(true)
    })

    it('hides ProposalActionBar when all proposals resolved', async () => {
      const sessionStore = useSessionStore()
      sessionStore.activeSession.proposals = [
        { id: 'p1', path: 'a.md', status: 'accepted', targetText: 'a', replacement: 'b' },
      ]
      const wrapper = factory()
      await wrapper.vm.$nextTick()
      const bar = wrapper.findComponent({ name: 'ProposalActionBar' })
      expect(bar.exists()).toBe(false)
    })
  })

  // ---- applyProposal ----

  describe('applyProposal', () => {
    let sessionStore

    function makeProposal(overrides = {}) {
      return {
        id: 'p-' + Math.random().toString(36).slice(2, 8),
        path: 'test.md',
        status: 'pending',
        targetText: 'old text',
        replacement: 'new text',
        ...overrides,
      }
    }

    async function callApply(wrapper, proposal) {
      const applyFn = wrapper.vm.$.setupState.applyProposal
      await applyFn(proposal)
      await flushPromises()
    }

    beforeEach(() => {
      sessionStore = useSessionStore()
      invoke.mockReset()
      invoke.mockResolvedValue(undefined)
    })

    it('delegates proposal apply to the central coordinator', async () => {
      const proposal = makeProposal({
        type: 'create',
        absolutePath: '/project/new-file.md',
        replacement: 'file contents here',
      })
      sessionStore.activeSession.proposals = [proposal]

      const wrapper = factory()
      await callApply(wrapper, proposal)

      expect(invoke).toHaveBeenCalledWith('proposal_apply', { id: proposal.id })
      expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
    })

    it('marks proposal failed when central apply rejects', async () => {
      const proposal = makeProposal({
        type: 'edit',
        absolutePath: '/project/existing.md',
        targetText: 'old text',
        replacement: 'new text',
      })
      sessionStore.activeSession.proposals = [proposal]

      invoke.mockImplementation((cmd) => {
        if (cmd === 'proposal_apply') return Promise.reject(new Error('Target text is ambiguous in file'))
        return Promise.resolve(undefined)
      })

      const wrapper = factory()
      await callApply(wrapper, proposal)

      expect(invoke).toHaveBeenCalledWith('proposal_apply', { id: proposal.id })
      expect(proposal.status).toBe('failed')
      expect(proposal.failReason).toContain('Target text is ambiguous')
    })

    it('document proposals also go through central apply', async () => {
      const proposal = makeProposal({
        path: 'current-document.md',
        targetText: 'old',
        replacement: 'new',
      })
      delete proposal.absolutePath
      delete proposal.type
      sessionStore.activeSession.proposals = [proposal]

      invoke.mockResolvedValue({ delivered: true })

      const wrapper = factory()
      await callApply(wrapper, proposal)

      expect(invoke).not.toHaveBeenCalledWith('notify_file_updated', expect.anything())
      expect(invoke).toHaveBeenCalledWith('proposal_apply', { id: proposal.id })
    })

    it('skips duplicate calls when status is already applying', async () => {
      const proposal = makeProposal({
        type: 'create',
        absolutePath: '/project/file.md',
        replacement: 'content',
        status: 'applying',
      })
      sessionStore.activeSession.proposals = [proposal]

      const wrapper = factory()
      await callApply(wrapper, proposal)

      expect(invoke).not.toHaveBeenCalledWith('write_text_file', expect.anything())
      expect(invoke).not.toHaveBeenCalledWith('proposal_apply', expect.anything())
      expect(proposal.status).toBe('applying')
    })
  })
})
