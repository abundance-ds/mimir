import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ActivityTabs from './ActivityTabs.vue'
const tabs = [
  { id: 'graph', title: 'Graph', unique: true },
  {
    id: 'agent',
    title: 'Fix Files',
    kind: 'agent',
    status: 'idle',
    host: { type: 'pty' },
    source: { presetId: 'codex' },
  },
  { id: 'terminal', title: 'Build', kind: 'terminal', status: 'done' },
]
let wrapper
function render() {
  wrapper = mount(ActivityTabs, {
    attachTo: document.body,
    props: { tabs, activeId: 'agent' },
  })
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})
describe('main tabs', () => {
  it('selects from the icon and full tab button, while Close does not select', async () => {
    const w = render()
    const tab = w.get('[data-main-tab="graph"] [role=tab]')
    await tab.get('svg').trigger('click')
    await tab.trigger('click')
    expect(w.emitted('select')).toEqual([['graph'], ['graph']])
    await w.get('[data-main-tab="terminal"] .tab-close').trigger('click')
    expect(w.emitted('close')).toEqual([['terminal']])
    expect(w.emitted('select')).toHaveLength(2)
  })
  it('scrolls overflowing tabs with a mouse wheel', async () => {
    const w = render()
    const strip = w.get('[role=tablist]')
    Object.defineProperties(strip.element, {
      scrollWidth: { value: 800 },
      clientWidth: { value: 400 },
    })
    await strip.trigger('wheel', { deltaX: 0, deltaY: 40 })
    expect(strip.element.scrollLeft).toBe(40)
  })
  it('returns keyboard context-menu focus to its tab and leaves control keys alone', async () => {
    const w = render()
    const tab = w.get('[data-main-tab="agent"] [role=tab]')
    tab.element.focus()
    await tab.trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    const menu = document.querySelector('[role=menu]')
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(tab.element)
    for (const selector of ['[data-new-main-tab]', '[aria-label="All tabs"]', '.tab-close']) {
      await w.get(selector).trigger('keydown', { key: 'F2' })
      await w.get(selector).trigger('keydown', { key: 'ArrowRight' })
    }
    expect(w.find('[data-tab-rename]').exists()).toBe(false)
    expect(w.emitted('select')).toBeUndefined()
  })
  it('keeps session status in the tooltip and All Tabs without marking normal work as an alert', async () => {
    const w = render()
    await w.setProps({ tabs: tabs.map(tab => tab.id === 'agent' ? { ...tab, status: 'working' } : tab) })
    expect(w.get('[data-main-tab="agent"] [role=tab]').attributes('title')).toBe('Fix Files — Working')
    expect(w.find('[aria-label="Tabs need attention"]').exists()).toBe(false)
    await w.get('[aria-label="All tabs"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[role=listbox]').textContent).toContain('Working')
  })
  it('renames through the context menu with the full current name selected', async () => {
    const w = render()
    await w
      .get('[data-main-tab="agent"]')
      .trigger('contextmenu', { clientX: 10, clientY: 40 })
    await flushPromises()
    const rename = [...document.querySelectorAll('[role=menuitem]')].find(
      (el) => el.textContent.includes('Rename'),
    )
    rename.click()
    await flushPromises()
    const input = w.get('[data-tab-rename]')
    expect(input.element.selectionStart).toBe(0)
    expect(input.element.selectionEnd).toBe('Fix Files'.length)
    await input.setValue('  File navigation  ')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('rename')).toEqual([
      [{ id: 'agent', title: 'File navigation' }],
    ])
  })
  it('cancels rename on Escape and does not save on blur or IME confirmation', async () => {
    const w = render()
    await w.get('[data-main-tab="agent"] [role=tab]').trigger('dblclick')
    await w.get('input').setValue('Changed')
    await w.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(w.emitted('rename')).toBeUndefined()
    await w.get('input').trigger('keydown', { key: 'Escape' })
    expect(w.find('input').exists()).toBe(false)
    await w.get('[data-main-tab="agent"] [role=tab]').trigger('dblclick')
    await w.get('input').trigger('blur')
    expect(w.emitted('rename')).toBeUndefined()
  })
  it('does not rename unique tabs and names the live close operation', async () => {
    const w = render()
    await w.get('[data-main-tab="graph"] [role=tab]').trigger('dblclick')
    expect(w.find('input').exists()).toBe(false)
    expect(
      w.get('[data-main-tab="agent"] .tab-close').attributes('title'),
    ).toBe('Stop and archive')
    await w.get('[data-main-tab="agent"] .tab-close').trigger('click')
    expect(w.emitted('close')).toEqual([['agent']])
  })
  it('switches by visible order and exposes all tabs in a searchable list', async () => {
    const w = render()
    await w
      .get('[data-main-tab="agent"] [role=tab]')
      .trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('select')).toEqual([['terminal']])
    await w.get('[aria-label="All tabs"]').trigger('click')
    await flushPromises()
    const input = document.querySelector('[aria-label="Find tab"]')
    input.value = 'Graph'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.querySelectorAll('[role=option]')).toHaveLength(2)
    document.querySelector('[role=option]').click()
    expect(w.emitted('select').at(-1)).toEqual(['graph'])
  })
  it('keeps search focus for instant filtering, arrows, Enter, and New tab', async () => {
    const w = render()
    expect(w.element.firstElementChild.getAttribute('aria-label')).toBe('All tabs')
    await w.get('[aria-label="All tabs"]').trigger('click')
    await flushPromises()
    const input = document.querySelector('[aria-label="Find tab"]')
    const key = async (value) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
      await flushPromises()
    }
    await key('ArrowDown')
    await key('ArrowDown')
    await key('ArrowUp')
    expect(document.activeElement).toBe(input)
    expect(document.getElementById(input.getAttribute('aria-activedescendant')).textContent).toContain('Fix Files')
    input.value = 'fix'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await key('Enter')
    expect(w.emitted('select')).toEqual([['agent']])
    await w.get('[aria-label="All tabs"]').trigger('click')
    await flushPromises()
    const empty = document.querySelector('[aria-label="Find tab"]')
    empty.value = 'no such session'
    empty.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    empty.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(w.emitted('new')).toHaveLength(1)
  })
  it('offers Stop and archive in the live tab context menu', async () => {
    const w = render()
    await w.get('[data-main-tab="agent"]').trigger('contextmenu')
    await flushPromises()
    const stop = [...document.querySelectorAll('[role=menuitem]')].find(el => el.textContent.includes('Stop and archive'))
    stop.click()
    expect(w.emitted('close')).toEqual([['agent']])
  })

})
