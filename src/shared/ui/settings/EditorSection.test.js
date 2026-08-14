import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useSettingsStore } from '../../../stores/settings.js'
import EditorSection from './EditorSection.vue'

// happy-dom localStorage is incomplete — provide a working mock (mirrors settings.test.js)
const storage = new Map()
const localStorageMock = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

describe('EditorSection', () => {
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
    const wrapper = mount(EditorSection, { global: { plugins: [pinia] } })
    await flushPromises()
    return { wrapper, store: useSettingsStore() }
  }

  function rowFor(wrapper, label) {
    return wrapper.findAll('.setting-row').find((row) => row.text().includes(label))
  }

  it('steps the editor font size and clamps at 12–24', async () => {
    const { wrapper, store } = await render()
    const row = rowFor(wrapper, 'Text size')
    const [minus, plus] = row.findAll('.stepper-btn')

    expect(row.get('.stepper-value').text()).toBe('16px')
    await plus.trigger('click')
    expect(store.editorFontSize).toBe(17)
    expect(row.get('.stepper-value').text()).toBe('17px')
    await minus.trigger('click')
    expect(store.editorFontSize).toBe(16)

    store.set('editorFontSize', 24)
    await nextTick()
    expect(plus.attributes('disabled')).toBeDefined()
    expect(minus.attributes('disabled')).toBeUndefined()

    store.set('editorFontSize', 12)
    await nextTick()
    expect(minus.attributes('disabled')).toBeDefined()
    expect(plus.attributes('disabled')).toBeUndefined()
  })

  it('steps the terminal font size through its labelled controls', async () => {
    const { wrapper, store } = await render()
    const row = rowFor(wrapper, 'Terminal size')
    const decrease = wrapper.get('[aria-label="Decrease terminal font size"]')
    const increase = wrapper.get('[aria-label="Increase terminal font size"]')

    expect(row.get('.stepper-value').text()).toBe('12px')
    await increase.trigger('click')
    expect(store.mimirTerminalFontSize).toBe(13)
    await decrease.trigger('click')
    expect(store.mimirTerminalFontSize).toBe(12)

    store.set('mimirTerminalFontSize', 9)
    await nextTick()
    expect(decrease.attributes('disabled')).toBeDefined()

    store.set('mimirTerminalFontSize', 24)
    await nextTick()
    expect(increase.attributes('disabled')).toBeDefined()
  })

  it('selects the editor typeface from the font dropdown', async () => {
    const { wrapper, store } = await render()
    const trigger = wrapper.get('.dropdown-trigger')

    expect(trigger.text()).toContain('Commit Mono')
    expect(wrapper.find('.dropdown-menu').exists()).toBe(false)

    await trigger.trigger('click')
    const items = wrapper.findAll('.dropdown-item')
    expect(items.map((item) => item.text())).toEqual(['Commit Mono', 'System Mono', 'Sans'])

    await items[2].trigger('click')
    expect(store.editorFontFamily).toBe('sans')
    expect(wrapper.find('.dropdown-menu').exists()).toBe(false)
    expect(trigger.text()).toContain('Sans')
  })

  it('closes the font dropdown on an outside pointerdown', async () => {
    const { wrapper } = await render()

    await wrapper.get('.dropdown-trigger').trigger('click')
    expect(wrapper.find('.dropdown-menu').exists()).toBe(true)

    document.dispatchEvent(new Event('pointerdown'))
    await nextTick()
    expect(wrapper.find('.dropdown-menu').exists()).toBe(false)
  })

  it('flips every editor toggle through the store and back', async () => {
    const { wrapper, store } = await render()

    async function toggle(label) {
      const control = rowFor(wrapper, label).get('.toggle-switch')
      const wasOn = control.classes().includes('toggle-on')
      await control.trigger('click')
      expect(control.classes().includes('toggle-on')).toBe(!wasOn)
      return control
    }

    expect(store.editorToolbarMode).toBe('top')
    await toggle('Toolbar')
    expect(store.editorToolbarMode).toBe('none')
    await toggle('Toolbar')
    expect(store.editorToolbarMode).toBe('top')

    expect(store.editorWordWrap).toBe(true)
    await toggle('Word wrap')
    expect(store.editorWordWrap).toBe(false)

    expect(store.editorLineNumbers).toBe(false)
    const lineNumbers = rowFor(wrapper, 'Line numbers').get('.toggle-switch')
    expect(lineNumbers.attributes('aria-pressed')).toBe('false')
    await toggle('Line numbers')
    expect(store.editorLineNumbers).toBe(true)
    expect(lineNumbers.attributes('aria-pressed')).toBe('true')

    expect(store.editorLivePreview).toBe(true)
    await toggle('Live preview')
    expect(store.editorLivePreview).toBe(false)

    expect(store.editorSpellCheck).toBe(false)
    await toggle('Spell check')
    expect(store.editorSpellCheck).toBe(true)

    expect(store.editorAutoSave).toBe(true)
    await toggle('Auto-save')
    expect(store.editorAutoSave).toBe(false)
  })

  it('switches line width through the segmented control', async () => {
    const { wrapper, store } = await render()
    const buttons = rowFor(wrapper, 'Line width').findAll('.segmented-btn')

    expect(buttons.map((b) => b.text())).toEqual(['Normal', 'Wide', 'Off'])
    expect(buttons[0].classes()).toContain('segmented-active')

    await buttons[1].trigger('click')
    expect(store.editorLineWidth).toBe('wide')
    expect(buttons[1].classes()).toContain('segmented-active')
    expect(buttons[0].classes()).not.toContain('segmented-active')

    await buttons[2].trigger('click')
    expect(store.editorLineWidth).toBe('off')
  })
})
