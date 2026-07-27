import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import AppearanceSection from './AppearanceSection.vue'

// happy-dom localStorage is incomplete — provide a working mock (mirrors settings.test.js)
const storage = new Map()
const localStorageMock = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

describe('AppearanceSection', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', localStorageMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function render() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AppearanceSection, { global: { plugins: [pinia] } })
    await flushPromises()
    return { wrapper, store: useSettingsStore() }
  }

  function swatchFor(wrapper, label) {
    return wrapper
      .findAll('.theme-swatch')
      .find((swatch) => swatch.get('.swatch-label').text() === label)
  }

  it('renders every theme with only the current one highlighted', async () => {
    const { wrapper } = await render()
    const labels = wrapper.findAll('.swatch-label').map((el) => el.text())

    expect(labels).toEqual([
      'Light', 'North', 'Studio', 'Dark', 'Monokai', 'Dracula', 'Zenith', 'Synthwave',
    ])
    expect(wrapper.findAll('.theme-swatch.active')).toHaveLength(1)
    expect(swatchFor(wrapper, 'Light').classes()).toContain('active') // default parchment
  })

  it('selects a theme, persists it via the store, and applies it to the document', async () => {
    const { wrapper, store } = await render()
    expect(document.documentElement.getAttribute('data-theme')).toBe('parchment')

    await swatchFor(wrapper, 'Dark').trigger('click')
    await flushPromises()

    expect(store.editorTheme).toBe('slate')
    expect(store.isDarkTheme).toBe(true)
    expect(swatchFor(wrapper, 'Dark').classes()).toContain('active')
    expect(swatchFor(wrapper, 'Light').classes()).not.toContain('active')
    expect(wrapper.findAll('.theme-swatch.active')).toHaveLength(1)
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate')
    expect(localStorage.getItem('mim:theme')).toBe('slate')

    // Persist immediately so the debounced editor-settings save cannot leak
    // into a later test, then verify the snapshot survived.
    await store.flush()
    const saved = JSON.parse(localStorage.getItem('mim:editor:settings:v1'))
    expect(saved.editorTheme).toBe('slate')
  })

  it('steps interface zoom through the defined levels and clamps at the ends', async () => {
    const { wrapper, store } = await render()
    const zoomIn = wrapper.get('[aria-label="Zoom interface in"]')
    const zoomOut = wrapper.get('[aria-label="Zoom interface out"]')
    const value = () => wrapper.get('.stepper-value').text()

    expect(value()).toBe('100%')
    await zoomIn.trigger('click')
    expect(store.workbenchZoom).toBe(110)
    expect(value()).toBe('110%')

    await zoomOut.trigger('click')
    await zoomOut.trigger('click')
    expect(store.workbenchZoom).toBe(90)

    store.set('workbenchZoom', 200)
    await nextTick()
    expect(zoomIn.attributes('disabled')).toBeDefined()
    expect(zoomOut.attributes('disabled')).toBeUndefined()

    store.set('workbenchZoom', 50)
    await nextTick()
    expect(zoomOut.attributes('disabled')).toBeDefined()
    expect(zoomIn.attributes('disabled')).toBeUndefined()
  })
})
