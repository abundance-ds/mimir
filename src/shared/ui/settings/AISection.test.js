import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('../../../services/ai/client.js', () => ({
  getAiKeyStatus: vi.fn(),
  getModelRegistry: vi.fn(),
  setAiApiKey: vi.fn(),
}))

import { getAiKeyStatus, getModelRegistry, setAiApiKey } from '../../../services/ai/client.js'
import { useSettingsStore } from '../../../stores/settings.js'
import AISection from './AISection.vue'

const registry = {
  defaults: { ghost: ['gpt-mini', 'claude-haiku', 'claude-fast'] },
  models: [
    { id: 'gpt-mini', provider: 'openai', displayName: 'GPT Mini', shortLabel: 'Mini' },
    { id: 'claude-haiku', provider: 'anthropic', displayName: 'Claude Haiku', shortLabel: 'Haiku' },
    { id: 'claude-fast', provider: 'anthropic', displayName: 'Claude Fast', shortLabel: 'Fast' },
  ],
}

function statuses(overrides = {}) {
  return [
    { provider: 'anthropic', configured: true, maskedPreview: 'sk-ant-…4f2' },
    { provider: 'openai', configured: false },
    { provider: 'google', configured: true },
  ].map((status) => ({ ...status, ...(overrides[status.provider] || {}) }))
}

// happy-dom localStorage is incomplete — provide a working mock (mirrors settings.test.js)
const storage = new Map()
const localStorageMock = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

describe('AISection', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.mocked(getModelRegistry).mockReset().mockResolvedValue(registry)
    vi.mocked(getAiKeyStatus).mockReset().mockResolvedValue(statuses())
    vi.mocked(setAiApiKey).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.unstubAllGlobals()
  })

  async function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AISection, { global: { plugins: [pinia] } })
    await flushPromises()
    return { wrapper, store: useSettingsStore() }
  }

  it('replaces key management with a notice in browser mode but keeps feature toggles', async () => {
    delete window.__TAURI_INTERNALS__
    const { wrapper } = await render()

    expect(wrapper.text()).toContain('API key management is not available in browser mode.')
    expect(wrapper.find('.key-input').exists()).toBe(false)
    expect(getModelRegistry).not.toHaveBeenCalled()
    expect(getAiKeyStatus).not.toHaveBeenCalled()
    expect(wrapper.findAll('.toggle-switch')).toHaveLength(2)
  })

  it('renders one row per provider with its distinct key-status state', async () => {
    const { wrapper } = await render()
    const rows = wrapper.findAll('.key-row')

    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Anthropic')
    expect(rows[0].text()).toContain('ANTHROPIC_API_KEY')
    expect(rows[0].get('.key-preview').text()).toContain('sk-ant-…4f2')
    expect(rows[0].get('.key-dot').classes()).toContain('configured')

    expect(rows[1].text()).toContain('OPENAI_API_KEY')
    expect(rows[1].get('.key-preview').text()).toBe('Not configured')
    expect(rows[1].get('.key-dot').classes()).not.toContain('configured')

    // Configured but no masked preview falls back to the plain label.
    expect(rows[2].text()).toContain('GOOGLE_AI_API_KEY')
    expect(rows[2].get('.key-preview').text()).toBe('Configured')
    expect(rows[2].get('.key-dot').classes()).toContain('configured')

    expect(wrapper.text()).toContain('Keys are stored securely in your system keychain.')
  })

  it('saves a trimmed key, clears the input, and refreshes the status dot', async () => {
    const { wrapper } = await render()
    const row = wrapper.findAll('.key-row')[1] // openai
    const input = row.get('.key-input')
    const save = row.get('.key-save-btn')

    expect(save.attributes('disabled')).toBeDefined()
    await input.setValue('   ')
    expect(save.attributes('disabled')).toBeDefined()

    await input.setValue('  sk-live-123  ')
    expect(save.attributes('disabled')).toBeUndefined()

    getAiKeyStatus.mockResolvedValue(
      statuses({ openai: { configured: true, maskedPreview: 'sk-…123' } }),
    )
    await save.trigger('click')
    await flushPromises()

    expect(setAiApiKey).toHaveBeenCalledWith('openai', 'sk-live-123')
    expect(input.element.value).toBe('')
    expect(row.get('.key-message').classes()).toContain('success')
    expect(row.get('.key-message').text()).toContain('Key saved successfully.')
    expect(row.get('.key-dot').classes()).toContain('configured')
    expect(row.get('.key-preview').text()).toContain('sk-…123')
  })

  it('saves on Enter from the key input', async () => {
    const { wrapper } = await render()
    const row = wrapper.findAll('.key-row')[0] // anthropic
    await row.get('.key-input').setValue('sk-ant-new')
    await row.get('.key-input').trigger('keydown.enter')
    await flushPromises()

    expect(setAiApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-new')
  })

  it('removes a configured key and refreshes provider availability', async () => {
    const { wrapper } = await render()
    const row = wrapper.findAll('.key-row')[0]
    expect(row.get('[data-ai-remove-key]').text()).toBe('Remove')

    getAiKeyStatus.mockResolvedValue(
      statuses({ anthropic: { configured: false, maskedPreview: null } }),
    )
    await row.get('[data-ai-remove-key]').trigger('click')
    await flushPromises()

    expect(setAiApiKey).toHaveBeenCalledWith('anthropic', '')
    expect(row.get('.key-preview').text()).toBe('Not configured')
    expect(row.find('[data-ai-remove-key]').exists()).toBe(false)
    expect(row.get('.key-message').text()).toContain('Key removed.')
  })

  it('surfaces save failures without clearing the input or refreshing status', async () => {
    const { wrapper } = await render()
    const row = wrapper.findAll('.key-row')[0]
    const input = row.get('.key-input')

    setAiApiKey.mockRejectedValueOnce(new Error('keychain locked'))
    await input.setValue('sk-bad')
    await row.get('.key-save-btn').trigger('click')
    await flushPromises()

    expect(row.get('.key-message').classes()).toContain('error')
    expect(row.get('.key-message').text()).toContain('keychain locked')
    expect(input.element.value).toBe('sk-bad')
    expect(getAiKeyStatus).toHaveBeenCalledTimes(1) // mount only, no refresh

    setAiApiKey.mockRejectedValueOnce('nope')
    await row.get('.key-save-btn').trigger('click')
    await flushPromises()
    expect(row.get('.key-message').text()).toContain('Failed to save key.')
  })

  it('auto-selects the first ghost model whose provider has a key', async () => {
    const { wrapper, store } = await render()

    // gpt-mini is first in the registry order but openai has no key.
    expect(store.aiGhostModel).toBe('claude-haiku')
    expect(wrapper.get('.ghost-picker-trigger').text()).toContain('Haiku')
  })

  it('keeps an explicit ghost model choice that is still usable', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore()
    store.set('aiGhostModel', 'claude-fast')

    const wrapper = mount(AISection, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(store.aiGhostModel).toBe('claude-fast')
    expect(wrapper.get('.ghost-picker-trigger').text()).toContain('Fast')
  })

  it('lists ghost models, disables unconfigured providers, and applies a selection', async () => {
    const { wrapper, store } = await render()

    await wrapper.get('.ghost-picker-trigger').trigger('click')
    const options = wrapper.findAll('.ghost-picker-option')
    expect(options).toHaveLength(3)
    expect(options[0].text()).toContain('Mini')
    expect(options[0].attributes('disabled')).toBeDefined()
    expect(options[1].classes()).toContain('selected')
    expect(options[2].attributes('disabled')).toBeUndefined()

    await options[0].trigger('click')
    expect(store.aiGhostModel).toBe('claude-haiku') // disabled option is inert
    expect(wrapper.find('.ghost-picker-dropdown').exists()).toBe(true)

    await options[2].trigger('click')
    expect(store.aiGhostModel).toBe('claude-fast')
    expect(wrapper.find('.ghost-picker-dropdown').exists()).toBe(false)
    expect(wrapper.get('.ghost-picker-trigger').text()).toContain('Fast')
  })

  it('closes the ghost model dropdown on an outside pointerdown', async () => {
    const { wrapper } = await render()

    await wrapper.get('.ghost-picker-trigger').trigger('click')
    expect(wrapper.find('.ghost-picker-dropdown').exists()).toBe(true)

    document.dispatchEvent(new Event('pointerdown'))
    await nextTick()
    expect(wrapper.find('.ghost-picker-dropdown').exists()).toBe(false)
  })

  it('toggles ghost suggestions and inline rewrite through the store', async () => {
    const { wrapper, store } = await render()

    expect(store.aiGhostSuggestions).toBe(true)
    const ghostToggle = wrapper.findAll('.toggle-switch')[0]
    expect(ghostToggle.classes()).toContain('toggle-on')
    expect(wrapper.find('.ghost-picker-trigger').exists()).toBe(true)

    await ghostToggle.trigger('click')
    expect(store.aiGhostSuggestions).toBe(false)
    expect(ghostToggle.classes()).not.toContain('toggle-on')
    expect(wrapper.find('.ghost-picker-trigger').exists()).toBe(false)

    const rewriteToggle = wrapper.findAll('.toggle-switch')[1]
    expect(store.aiInlineRewrite).toBe(true)
    await rewriteToggle.trigger('click')
    expect(store.aiInlineRewrite).toBe(false)
    await rewriteToggle.trigger('click')
    expect(store.aiInlineRewrite).toBe(true)
  })
})
