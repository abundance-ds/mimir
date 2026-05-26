import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TabStrip from './TabStrip.vue'

const twoDocs = [
  { id: 'tab-1', name: 'doc.md', dirty: false },
  { id: 'tab-2', name: 'notes.md', dirty: true },
]

function mountStrip(props = {}) {
  return mount(TabStrip, { props: { tabs: twoDocs, ...props } })
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
    // close button is the × span inside the first tab
    const closeBtn = fileTabs(w)[0]
      .findAll('span')
      .find(s => s.text() === '×')
    expect(closeBtn).toBeTruthy()
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

  it('hides close button when only one tab', () => {
    const w = mountStrip({ tabs: [{ id: 'tab-solo', name: 'solo.md', dirty: false }] })
    const tab = fileTabs(w)[0]
    const closeSpan = tab.findAll('span').find(s => s.text() === '×')
    expect(closeSpan).toBeUndefined()
  })

  it('applies active class to selected tab', () => {
    const w = mountStrip({ activeTab: 1 })
    const tabs = fileTabs(w)
    expect(tabs[0].classes()).not.toContain('tab-active')
    expect(tabs[1].classes()).toContain('tab-active')
  })
})
