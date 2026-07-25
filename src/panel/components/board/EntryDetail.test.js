import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'

// Mock transitive deps (same pattern as ChatView.test.js)
vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../../../services/ai/chatTransport', () => ({ createMimChatTransport: vi.fn() }))
vi.mock('../../../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../../../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../../../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('../../../services/ai/modelControls', () => ({
  controlForModel: () => ({ id: '', label: '', options: [] }),
  defaultControlId: () => '',
  modelDisplayName: () => '',
  modelMenuItems: () => [],
  normalizeModelId: (id) => id || null,
  providerConfigured: () => false,
  resolveConcreteModel: () => 'test',
  resolveDefaultModel: () => ({ id: 'test-model' }),
}))
vi.mock('../../../stores/panel/persistence', () => ({
  schedulePersist: vi.fn(),
  loadInitialState: vi.fn(),
}))

vi.mock('../../../services/board/loader.js', () => ({
  ISSUE_STATUSES: ['backlog', 'plan', 'in-progress', 'review', 'done'],
  PRIORITIES: ['low', 'normal', 'high', 'urgent'],
  STATUS_LABELS: { backlog: 'Backlog', plan: 'Plan', 'in-progress': 'In Progress', review: 'Review', done: 'Done' },
  PRIORITY_LABELS: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
}))
vi.mock('../../../stores/panel/actions.js', () => ({
  selectSession: vi.fn(),
  startProjectChat: vi.fn(() => Promise.resolve({ id: 'new-session', linkedEntries: [] })),
}))

import EntryDetail from './EntryDetail.vue'

function factory(entry = {}) {
  const defaultEntry = {
    id: 'test-entry',
    meta: {
      type: 'issue',
      title: 'Test Issue',
      status: 'plan',
      priority: 'normal',
      tags: ['tag1'],
      sources: [],
      created: '2026-01-01',
      updated: '2026-01-02',
    },
    body: '# Hello\n\nSome **bold** text',
  }
  const merged = { ...defaultEntry, ...entry }
  if (entry.meta) merged.meta = { ...defaultEntry.meta, ...entry.meta }
  return shallowMount(EntryDetail, {
    props: { entry: merged, backLabel: 'Back' },
    global: { stubs: { PriorityIcon: true } },
  })
}

describe('EntryDetail', () => {
  describe('rendered markdown body', () => {
    it('renders markdown as HTML in view mode', () => {
      const w = factory()
      const rendered = w.find('.ed-body-rendered')
      expect(rendered.exists()).toBe(true)
      const html = rendered.html()
      expect(html).toContain('<h1>')
      expect(html).toContain('<strong>')
    })

    it('switches to textarea on click', async () => {
      const w = factory()
      expect(w.find('textarea').exists()).toBe(false)
      await w.find('.ed-body-rendered').trigger('click')
      expect(w.find('textarea').exists()).toBe(true)
    })

    it('saves and returns to view mode on blur', async () => {
      const w = factory()
      // Enter edit mode
      await w.find('.ed-body-rendered').trigger('click')
      expect(w.find('textarea').exists()).toBe(true)
      // Blur the textarea
      await w.find('textarea').trigger('blur')
      expect(w.find('textarea').exists()).toBe(false)
      expect(w.find('.ed-body-rendered').exists()).toBe(true)
    })
  })

  describe('sources', () => {
    it('renders source files', () => {
      const w = factory({ meta: { sources: [{ path: '/a/b.md' }] } })
      expect(w.text()).toContain('b.md')
    })

    it('remove button removes source', async () => {
      const w = factory({ meta: { sources: [{ path: '/a/b.md' }] } })
      expect(w.text()).toContain('b.md')
      await w.find('.ed-source-x').trigger('click')
      expect(w.text()).not.toContain('b.md')
    })

    it('emits save with sources in meta', async () => {
      const w = factory({ meta: { sources: [{ path: '/x/y.md' }] } })
      // Remove the source to trigger a save
      await w.find('.ed-source-x').trigger('click')
      const saveEvents = w.emitted('save')
      expect(saveEvents).toBeTruthy()
      const lastSave = saveEvents[saveEvents.length - 1][0]
      expect(lastSave.meta).toHaveProperty('sources')
      expect(lastSave.meta.sources).toEqual([])
    })
  })

  describe('compact property bar', () => {
    it('renders status pill for issues', () => {
      const w = factory()
      const pill = w.find('.ed-prop-pill')
      expect(pill.exists()).toBe(true)
      expect(pill.text()).toContain('Plan')
    })

    it('does not render property bar for knowledge entries', () => {
      const w = factory({ meta: { type: 'knowledge' } })
      expect(w.find('.ed-props').exists()).toBe(false)
    })
  })

  describe('sessions', () => {
    it('shows Start session button', () => {
      const w = factory()
      const buttons = w.findAll('button')
      const startBtn = buttons.find((b) => b.text().includes('Start session'))
      expect(startBtn).toBeTruthy()
    })
  })

  describe('auto-focus', () => {
    function factoryAttached(entry = {}) {
      const defaultEntry = {
        id: 'test-entry',
        meta: {
          type: 'issue',
          title: 'Test Issue',
          status: 'plan',
          priority: 'normal',
          tags: ['tag1'],
          sources: [],
          created: '2026-01-01',
          updated: '2026-01-02',
        },
        body: '# Hello\n\nSome **bold** text',
      }
      const merged = { ...defaultEntry, ...entry }
      if (entry.meta) merged.meta = { ...defaultEntry.meta, ...entry.meta }
      return shallowMount(EntryDetail, {
        props: { entry: merged, backLabel: 'Back' },
        global: { stubs: { PriorityIcon: true } },
        attachTo: document.body,
      })
    }

    it('focuses title input when title is empty', async () => {
      const w = factoryAttached({ meta: { title: '' } })
      await w.vm.$nextTick()
      await w.vm.$nextTick()
      const titleInput = w.find('.ed-title')
      expect(titleInput.element).toBe(document.activeElement)
      w.unmount()
    })

    it('does not focus title input when title has content', async () => {
      const w = factoryAttached({ meta: { title: 'Existing title' } })
      await w.vm.$nextTick()
      await w.vm.$nextTick()
      const titleInput = w.find('.ed-title')
      expect(titleInput.element).not.toBe(document.activeElement)
      w.unmount()
    })
  })
})
