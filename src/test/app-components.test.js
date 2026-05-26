import { describe, it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'

// --- AI mocks (same as smoke.test.js) ---
vi.mock('@ai-sdk/vue', () => ({ Chat: vi.fn() }))
vi.mock('ai', () => ({ lastAssistantMessageIsCompleteWithToolCalls: vi.fn() }))
vi.mock('../services/ai/chatTransport', () => ({ createShouldersChatTransport: vi.fn() }))
vi.mock('../services/ai/sdkAdapter', () => ({ addUsage: vi.fn() }))
vi.mock('../services/ai/recovery', () => ({ recoverPoisonedMessages: vi.fn() }))
vi.mock('../services/ai/client', () => ({ generateAiText: vi.fn() }))
vi.mock('../services/ai/modelControls', () => ({
  controlForModel: () => ({ id: '', label: '', options: [] }),
  defaultControlId: () => '',
  modelDisplayName: () => '',
  modelMenuItems: () => [{ id: 'test-model', displayName: 'Test', provider: 'anthropic' }],
  normalizeModelId: (id) => id || null,
  providerConfigured: () => false,
  resolveConcreteModel: () => 'test',
  resolveDefaultModel: () => ({ id: 'test-model' }),
}))
vi.mock('../stores/panel/persistence', () => ({
  schedulePersist: vi.fn(),
  loadInitialState: vi.fn(),
}))

// --- Store mocks ---
vi.mock('../stores/panel/sessions.js', () => ({
  useSessionStore: () => ({ selectableModels: [{ id: 'test-model', displayName: 'Test', provider: 'anthropic' }], removeSession: vi.fn() }),
}))
vi.mock('../stores/panel/projects.js', () => ({
  useProjectStore: () => ({ projects: [{ id: 'p1', name: 'Test Project' }] }),
}))
const _mockGetApp = vi.fn((id) => ({ id, name: 'Test App', icon: '🔧', ui: 'standard', description: 'A test app' }))
vi.mock('../stores/panel/apps.js', () => ({
  useAppStore: () => ({ getApp: _mockGetApp }),
}))
vi.mock('../stores/panel/actions.js', () => ({
  doneSession: vi.fn(),
  launchApp: vi.fn(),
}))
vi.mock('../stores/panel/helpers.js', () => ({
  plainProject: (p) => p,
  formatCost: (c) => `$${c.toFixed(2)}`,
  isAppSession: (s) => s.type === 'app',
  sessionStatusKind: () => 'ready',
  basename: (p) => p.split('/').pop(),
  chatInstances: new Map(),
  cleanMessagesForPersist: (m) => m,
}))

// --- Utility mocks ---
vi.mock('../shared/utils/path.js', () => ({ basename: (p) => p.split('/').pop() }))
vi.mock('../apps/bridge.js', () => ({
  createAppBridge: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}))
vi.mock('../apps/runner.js', () => ({
  createAppHandle: vi.fn(() => ({ start: vi.fn(), cancel: vi.fn(), promise: null })),
}))

// --- Components ---
import AppSetup from '../panel/components/AppSetup.vue'
import AppStandard from '../panel/components/AppStandard.vue'
import AppCustom from '../panel/components/AppCustom.vue'
import AppView from '../panel/components/AppView.vue'

// =============================================================================
// AppSetup
// =============================================================================
describe('AppSetup', () => {
  const baseApp = {
    name: 'Review App',
    icon: '📝',
    description: 'Reviews your document',
    setup: {
      fields: [
        { id: 'title', label: 'Title', type: 'text', default: '' },
        { id: 'notes', label: 'Notes', type: 'textarea', default: 'default notes' },
        { id: 'doc', label: 'Document', type: 'file' },
        { id: 'model', label: 'Model', type: 'model' },
      ],
    },
  }
  const baseSession = { id: 's1', appId: 'review' }

  it('renders app name and description from props', () => {
    const w = shallowMount(AppSetup, {
      props: { app: baseApp, session: baseSession },
    })
    expect(w.find('.as-title').text()).toBe('Review App')
    expect(w.find('.as-desc').text()).toBe('Reviews your document')
  })

  it('renders correct number of fields from manifest', () => {
    const w = shallowMount(AppSetup, {
      props: { app: baseApp, session: baseSession },
    })
    const fieldEls = w.findAll('.as-field')
    expect(fieldEls).toHaveLength(4)
  })

  it('clicking Start emits start with field values', async () => {
    const w = shallowMount(AppSetup, {
      props: { app: baseApp, session: baseSession },
    })
    // Set a value via the text input
    const input = w.find('input[type="text"]')
    await input.setValue('My Title')

    await w.find('.as-start').trigger('click')
    expect(w.emitted('start')).toBeTruthy()
    const payload = w.emitted('start')[0][0]
    expect(payload.title).toBe('My Title')
    expect(payload.notes).toBe('default notes')
  })

  it('clicking Back emits back', async () => {
    const w = shallowMount(AppSetup, {
      props: { app: baseApp, session: baseSession },
    })
    await w.find('.as-back').trigger('click')
    expect(w.emitted('back')).toBeTruthy()
  })

  it('shows "Ready to start" when no fields defined', () => {
    const w = shallowMount(AppSetup, {
      props: {
        app: { name: 'Simple App', setup: { fields: [] } },
        session: baseSession,
      },
    })
    expect(w.find('.as-empty').text()).toContain('Ready to start')
    expect(w.findAll('.as-field')).toHaveLength(0)
  })

  it('model field defaults to first selectable model when no default specified', () => {
    const appNoDefault = {
      name: 'App',
      setup: {
        fields: [{ id: 'model', label: 'Model', type: 'model' }],
      },
    }
    const w = shallowMount(AppSetup, {
      props: { app: appNoDefault, session: baseSession },
    })
    w.find('.as-start').trigger('click')
    const payload = w.emitted('start')[0][0]
    expect(payload.model).toBe('test-model')
  })
})

// =============================================================================
// AppStandard
// =============================================================================
describe('AppStandard', () => {
  function makeSession(overrides = {}) {
    return {
      id: 's1',
      label: 'Test Run',
      projectId: 'p1',
      appId: 'review',
      appStatus: 'running',
      appEvents: [],
      appResult: null,
      appError: null,
      appStartedAt: null,
      appCompletedAt: null,
      usage: {},
      ...overrides,
    }
  }

  const baseApp = { name: 'Review App', icon: '📝' }

  it('shows "Running" badge when appStatus is running', () => {
    const w = shallowMount(AppStandard, {
      props: { session: makeSession({ appStatus: 'running' }), app: baseApp },
    })
    const badge = w.find('.aw-badge')
    expect(badge.text()).toContain('Running')
    expect(badge.classes()).toContain('aw-badge--running')
  })

  it('shows "Completed" badge when appStatus is completed', () => {
    const w = shallowMount(AppStandard, {
      props: { session: makeSession({ appStatus: 'completed' }), app: baseApp },
    })
    const badge = w.find('.aw-badge')
    expect(badge.text()).toContain('Completed')
    expect(badge.classes()).toContain('aw-badge--done')
  })

  it('shows "Failed" badge when appStatus is failed', () => {
    const w = shallowMount(AppStandard, {
      props: { session: makeSession({ appStatus: 'failed' }), app: baseApp },
    })
    const badge = w.find('.aw-badge')
    expect(badge.text()).toContain('Failed')
    expect(badge.classes()).toContain('aw-badge--error')
  })

  it('renders timeline steps from appEvents', () => {
    const events = [
      { type: 'step', name: 'Parsing' },
      { type: 'log', message: 'Loaded file' },
      { type: 'step', name: 'Reviewing' },
    ]
    const w = shallowMount(AppStandard, {
      props: { session: makeSession({ appEvents: events }), app: baseApp },
    })
    const steps = w.findAll('.aw-step')
    expect(steps).toHaveLength(2)
    expect(steps[0].find('.aw-step-name').text()).toBe('Parsing')
    expect(steps[1].find('.aw-step-name').text()).toBe('Reviewing')
  })

  it('shows error message when status is failed', () => {
    const w = shallowMount(AppStandard, {
      props: {
        session: makeSession({ appStatus: 'failed', appError: 'Model rate-limited' }),
        app: baseApp,
      },
    })
    const errorEl = w.find('.aw-error')
    expect(errorEl.exists()).toBe(true)
    expect(errorEl.text()).toContain('Model rate-limited')
  })

  it('shows annotated file banner when result has annotatedPath', () => {
    const w = shallowMount(AppStandard, {
      props: {
        session: makeSession({
          appStatus: 'completed',
          appResult: { annotatedPath: '/docs/output_reviewed.docx' },
        }),
        app: baseApp,
      },
    })
    expect(w.text()).toContain('output_reviewed.docx')
    expect(w.text()).toContain('/docs')
  })

  it('shows cancel button during running, rerun/done buttons when completed', () => {
    const running = shallowMount(AppStandard, {
      props: { session: makeSession({ appStatus: 'running' }), app: baseApp },
    })
    expect(running.find('.aw-btn--cancel').exists()).toBe(true)
    expect(running.find('.aw-btn--rerun').exists()).toBe(false)
    expect(running.find('.aw-btn--done').exists()).toBe(false)

    const completed = shallowMount(AppStandard, {
      props: { session: makeSession({ appStatus: 'completed' }), app: baseApp },
    })
    expect(completed.find('.aw-btn--cancel').exists()).toBe(false)
    expect(completed.find('.aw-btn--rerun').exists()).toBe(true)
    expect(completed.find('.aw-btn--done').exists()).toBe(true)
  })

  it('formatTokens displays correctly (1000 → "1.0k", 1500000 → "1.5M")', () => {
    // Test through rendered output by providing usage in a done event
    const events = [
      { type: 'done', summary: 'All done', usage: { input_tokens: 1000, output_tokens: 1500000 } },
    ]
    const w = shallowMount(AppStandard, {
      props: {
        session: makeSession({ appStatus: 'completed', appEvents: events }),
        app: baseApp,
      },
    })
    const usageValues = w.findAll('.aw-usage-value')
    // Input: 1000 → "1.0k", Output: 1500000 → "1.5M"
    const texts = usageValues.map((el) => el.text())
    expect(texts).toContain('1.0k')
    expect(texts).toContain('1.5M')
  })
})

// =============================================================================
// AppCustom
// =============================================================================
describe('AppCustom', () => {
  const baseSession = { id: 's1', appId: 'my-custom', projectId: 'p1', appName: 'Custom Thing' }
  const baseApp = { name: 'Custom Thing', icon: '🎨' }

  it('renders iframe with correct src URL containing appId and projectId', () => {
    const w = shallowMount(AppCustom, {
      props: { session: baseSession, app: baseApp },
    })
    const iframe = w.find('iframe')
    expect(iframe.exists()).toBe(true)
    const src = iframe.attributes('src')
    expect(src).toContain('my-custom')
    expect(src).toContain('projectId=p1')
  })

  it('shows app name in toolbar', () => {
    const w = shallowMount(AppCustom, {
      props: { session: baseSession, app: baseApp },
    })
    expect(w.find('.ac-toolbar-name').text()).toBe('Custom Thing')
  })

  it('shows app icon in toolbar when provided', () => {
    const w = shallowMount(AppCustom, {
      props: { session: baseSession, app: baseApp },
    })
    const icon = w.find('.ac-toolbar-icon')
    expect(icon.exists()).toBe(true)
    expect(icon.text()).toBe('🎨')
  })
})

// =============================================================================
// AppView
// =============================================================================
describe('AppView', () => {
  it('shows AppSetup when appStatus is setup', () => {
    const w = shallowMount(AppView, {
      props: { session: { id: 's1', appId: 'test', appStatus: 'setup' } },
    })
    expect(w.findComponent(AppSetup).exists()).toBe(true)
    expect(w.findComponent(AppStandard).exists()).toBe(false)
    expect(w.findComponent(AppCustom).exists()).toBe(false)
  })

  it('shows AppCustom when app.ui is custom and status is not setup', () => {
    // Temporarily override getApp to return custom UI
    _mockGetApp.mockReturnValueOnce({ id: 'test', name: 'Test', ui: 'custom' })

    const w = shallowMount(AppView, {
      props: { session: { id: 's1', appId: 'test', appStatus: 'running' } },
    })
    expect(w.findComponent(AppCustom).exists()).toBe(true)
    expect(w.findComponent(AppSetup).exists()).toBe(false)
    expect(w.findComponent(AppStandard).exists()).toBe(false)
  })

  it('shows AppStandard for standard-ui apps', () => {
    const w = shallowMount(AppView, {
      props: {
        session: { id: 's1', appId: 'test', appStatus: 'running', appEvents: [], usage: {} },
      },
    })
    expect(w.findComponent(AppStandard).exists()).toBe(true)
    expect(w.findComponent(AppSetup).exists()).toBe(false)
    expect(w.findComponent(AppCustom).exists()).toBe(false)
  })
})
