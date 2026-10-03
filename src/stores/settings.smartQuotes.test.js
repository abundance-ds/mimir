import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from './settings.js'

describe('native smart quote settings', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {}
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    vi.useRealTimers()
  })

  const quoteCalls = () => invoke.mock.calls.filter(([command]) => command === 'set_smart_quotes')

  it('disables inherited smart quotes when old settings have no saved choice', async () => {
    const store = useSettingsStore()
    await store.load()
    await flushPromises()
    expect(store.smartQuotes).toBe(false)
    expect(quoteCalls()).toEqual([['set_smart_quotes', { enabled: false }]])
  })

  it('waits for saved settings before applying a second window’s choice', async () => {
    let finishLoad
    invoke.mockImplementation(command => command === 'settings_load'
      ? new Promise(resolve => { finishLoad = resolve })
      : Promise.resolve())
    const store = useSettingsStore()
    const loading = store.load()
    await flushPromises()
    expect(quoteCalls()).toEqual([])
    finishLoad({ settings: { editor: { smartQuotes: true } } })
    await loading
    await flushPromises()
    expect(quoteCalls()).toEqual([['set_smart_quotes', { enabled: true }]])

    store.set('smartQuotes', false)
    await store.flush()
    await flushPromises()
    expect(quoteCalls().at(-1)).toEqual(['set_smart_quotes', { enabled: false }])
    expect(invoke).toHaveBeenCalledWith('settings_save_editor', {
      editor: expect.objectContaining({ smartQuotes: false }),
    })

    invoke.mockImplementation(command => Promise.resolve(command === 'settings_load'
      ? { settings: { editor: { smartQuotes: true } } }
      : undefined))
    await store.load({ force: true })
    await flushPromises()
    expect(quoteCalls().at(-1)).toEqual(['set_smart_quotes', { enabled: true }])
  })

  it('requires an explicit boolean to enable quote replacement', async () => {
    invoke.mockImplementation(command => Promise.resolve(command === 'settings_load'
      ? { settings: { editor: { smartQuotes: 'false' } } }
      : undefined))
    const store = useSettingsStore()
    await store.load()
    await flushPromises()
    expect(store.smartQuotes).toBe(false)
    expect(quoteCalls()).toEqual([['set_smart_quotes', { enabled: false }]])
  })

  it('keeps browser previews free of native calls', async () => {
    delete window.__TAURI_INTERNALS__
    const store = useSettingsStore()
    await store.load()
    store.set('smartQuotes', true)
    await store.flush()
    await flushPromises()
    expect(quoteCalls()).toEqual([])
  })
})
