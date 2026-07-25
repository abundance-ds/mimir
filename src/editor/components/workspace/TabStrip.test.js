import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TabStrip from './TabStrip.vue'

const twoDocs = [
  { id: 'tab-1', name: 'doc.md', dirty: false },
  { id: 'tab-2', name: 'notes.md', dirty: true },
]

function mountStrip(props = {}, options = {}) {
  return mount(TabStrip, { ...options, props: { tabs: twoDocs, ...props } })
}

/** Helper: returns the file-tab buttons (excludes nav ‹›  and + buttons) */
function fileTabs(wrapper) {
  return wrapper.findAll('button.file-tab')
}

describe('TabStrip', () => {
  it('renders all tab names', () => {
    const w = mountStrip()
    const tabs = fileTabs(w)
    expect(tabs).toHaveLength(2)
    expect(tabs[0].text()).toContain('doc.md')
    expect(tabs[1].text()).toContain('notes.md')
  })

  it('shows dirty indicator for modified files', () => {
    const w = mountStrip()
    const tabs = fileTabs(w)
    // dirty dot = span with bg-accent + rounded-full
    const cleanDots = tabs[0].findAll('span').filter(s =>
      s.classes().includes('bg-accent') && s.classes().includes('rounded-full'),
    )
    const dirtyDots = tabs[1].findAll('span').filter(s =>
      s.classes().includes('bg-accent') && s.classes().includes('rounded-full'),
    )
    expect(cleanDots).toHaveLength(0)
    expect(dirtyDots).toHaveLength(1)
  })

  it('uses failure tone for failed save indicators', () => {
    const w = mountStrip({
      tabs: [{ id: 'failed-tab', name: 'doc.md', dirty: true, saveTone: 'failed' }],
    })
    const dot = fileTabs(w)[0].find('span.bg-rem')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('title')).toBe('Save failed')
  })

  it('emits select-tab with index on pointerdown+pointerup', async () => {
    const w = mountStrip()
    const tab = fileTabs(w)[1]
    await tab.trigger('pointerdown', { button: 0, clientX: 100, clientY: 10 })
    await document.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 10 }))
    expect(w.emitted('select-tab')).toBeTruthy()
    expect(w.emitted('select-tab')[0]).toEqual([1])
  })

  it('emits close-tab with index on close button click', async () => {
    const w = mountStrip()
    const closeBtn = w.get('button[aria-label="Close doc.md"]')
    await closeBtn.trigger('click')
    expect(w.emitted('close-tab')).toBeTruthy()
    expect(w.emitted('close-tab')[0]).toEqual([0])
    // click.stop should prevent select-tab from also firing
    expect(w.emitted('select-tab')).toBeFalsy()
  })

  it('emits add-tab on plus button click', async () => {
    const w = mountStrip()
    const plusBtn = w.find('button[aria-label="New tab"]')
    expect(plusBtn.exists()).toBe(true)
    await plusBtn.trigger('click')
    expect(w.emitted('add-tab')).toBeTruthy()
  })

  it('keeps the last-tab close affordance available for embedded pane collapse', () => {
    const w = mountStrip({ tabs: [{ id: 'tab-solo', name: 'solo.md', dirty: false }] })
    const closeButton = w.get('button[aria-label="Close solo.md"]')
    expect(closeButton.attributes('title')).toBe('Close tab')
  })

  it('applies active class to selected tab', () => {
    const w = mountStrip({ activeTab: 1 })
    const tabs = fileTabs(w)
    expect(tabs[0].classes()).not.toContain('tab-active')
    expect(tabs[1].classes()).toContain('tab-active')
  })

  it('uses a valid tablist with sibling keyboard-operable close buttons', async () => {
    const w = mountStrip({ activeTab: 1 })
    const tabs = fileTabs(w)
    expect(w.get('[role="tablist"]').attributes('aria-label')).toBe('Open editor tabs')
    expect(tabs.map(tab => tab.attributes('role'))).toEqual(['tab', 'tab'])
    expect(tabs.map(tab => tab.attributes('aria-selected'))).toEqual(['false', 'true'])
    expect(tabs.map(tab => tab.attributes('tabindex'))).toEqual(['-1', '0'])
    expect(tabs[0].find('button').exists()).toBe(false)

    const close = w.get('button[aria-label="Close notes.md"]')
    await close.trigger('keydown', { key: 'Enter' })
    await close.trigger('click')
    expect(w.emitted('close-tab').at(-1)).toEqual([1])
  })

  it('moves tab focus and selection with horizontal, Home, and End keys', async () => {
    const w = mountStrip({}, { attachTo: document.body })
    const tabs = fileTabs(w)

    await tabs[0].trigger('keydown', { key: 'ArrowRight' })
    await w.vm.$nextTick()
    expect(w.emitted('select-tab').at(-1)).toEqual([1])
    expect(document.activeElement).toBe(tabs[1].element)

    await tabs[1].trigger('keydown', { key: 'Home' })
    await w.vm.$nextTick()
    expect(w.emitted('select-tab').at(-1)).toEqual([0])
    expect(document.activeElement).toBe(tabs[0].element)

    await tabs[0].trigger('keydown', { key: 'End' })
    expect(w.emitted('select-tab').at(-1)).toEqual([1])

    await tabs[0].trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('select-tab').at(-1)).toEqual([1])
    w.unmount()
  })

  it('scrolls a newly active tab into view immediately', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const w = mountStrip()
    await w.setProps({ activeTab: 1 })
    await w.vm.$nextTick()
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    })
  })

  it('cancels a drag on Escape and pointercancel without reordering', async () => {
    const w = mountStrip({}, { attachTo: document.body })
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'
    const tab = fileTabs(w)[0]
    await tab.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 10 }))
    expect(document.body.style.cursor).toBe('grabbing')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
    expect(w.emitted('reorder-tab')).toBeFalsy()

    await tab.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    document.dispatchEvent(new PointerEvent('pointercancel'))
    expect(w.emitted('select-tab')).toBeFalsy()
    expect(w.emitted('reorder-tab')).toBeFalsy()
    w.unmount()
  })
})
