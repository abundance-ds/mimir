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

  it('keeps file tabs visible and bottom-aligned in the full editor header', () => {
    const w = mountStrip({ activeTab: 0 })
    const tablist = w.get('[role="tablist"]')
    const scrollRegion = w.get('.tab-scroll')

    expect(tablist.classes()).toEqual(expect.arrayContaining(['h-full', 'items-end']))
    expect(scrollRegion.classes()).toEqual(expect.arrayContaining(['h-full', 'items-end']))
    expect(fileTabs(w)[0].classes()).toContain('tab-active')
    expect(fileTabs(w)[0].attributes('aria-label')).toBe('doc.md')
  })

  it('keeps the identifying end of a long tab name separate from its flexible start', () => {
    const name = 'datei mit ein paar charts und nummer 1.md'
    const w = mountStrip({ tabs: [{ id: 'long-tab', name, dirty: false }] })
    const tab = fileTabs(w)[0]
    expect(tab.get('.tab-name-leading').element.textContent).toBe('datei mit ein paar charts und nummer ')
    expect(tab.get('.tab-name-trailing').text()).toBe('1.md')
    expect(tab.attributes('aria-label')).toBe(name)
    expect(w.get('.file-tab-wrap').attributes('style')).toContain('--tab-ideal-width: 188px')
  })

  it('shows the full name and parent directory on hover or keyboard focus', async () => {
    vi.useFakeTimers()
    const name = 'datei mit ein paar charts und nummer 1.md'
    const path = `/project/charts/${name}`
    const w = mountStrip({
      tabs: [{ id: 'long-tab', name, path, dirty: false }],
    }, { attachTo: document.body })
    const tab = fileTabs(w)[0]
    const leading = tab.get('.tab-name-leading').element
    Object.defineProperties(leading, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 240 },
    })

    await tab.trigger('mouseenter')
    vi.advanceTimersByTime(240)
    await w.vm.$nextTick()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(name)
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('/project/charts')

    await tab.trigger('mouseleave')
    await w.vm.$nextTick()
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    await tab.trigger('focus')
    await w.vm.$nextTick()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(name)
    expect(tab.attributes('aria-describedby')).toBe('editor-tab-tooltip')
    w.unmount()
    vi.useRealTimers()
  })

  it('does not add a redundant tooltip when a unique name fits', async () => {
    const w = mountStrip({}, { attachTo: document.body })
    const tab = fileTabs(w)[0]
    const leading = tab.get('.tab-name-leading').element
    Object.defineProperties(leading, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 40 },
    })

    await tab.trigger('focus')
    await w.vm.$nextTick()
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
    w.unmount()
  })

  it('shows the directory for duplicate names even when the label fits', async () => {
    const w = mountStrip({
      tabs: [
        { id: 'first', name: 'report.md', path: '/project/one/report.md', dirty: false },
        { id: 'second', name: 'report.md', path: '/project/two/report.md', dirty: false },
      ],
    }, { attachTo: document.body })
    const tab = fileTabs(w)[0]
    const leading = tab.get('.tab-name-leading').element
    Object.defineProperties(leading, {
      clientWidth: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 60 },
    })

    await tab.trigger('focus')
    await w.vm.$nextTick()
    const tooltip = document.body.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('/project/one')
    expect(w.get('[role="tablist"]').element.contains(tooltip)).toBe(false)
    w.unmount()
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
    expect(plusBtn.classes()).toContain('h-[28px]')
    expect(plusBtn.classes()).not.toContain('my-auto')
    await plusBtn.trigger('click')
    expect(w.emitted('add-tab')).toBeTruthy()
  })

  it('keeps the last-tab close affordance available for embedded pane collapse', () => {
    const w = mountStrip({ tabs: [{ id: 'tab-solo', name: 'solo.md', dirty: false }] })
    const closeButton = w.get('button[aria-label="Close solo.md"]')
    expect(closeButton.attributes('title')).toBe('Close tab')
  })

  it('offers close and Move to Trash actions in a named-file tab menu', async () => {
    const w = mountStrip({
      tabs: [{
        id: 'trash-tab',
        name: 'temp-note.md',
        path: '/work/temp-note.md',
        dirty: true,
        lifecycleAction: 'trash',
      }],
    }, {
      attachTo: document.body,
      global: { stubs: { Teleport: true, Transition: false } },
    })

    await fileTabs(w)[0].trigger('contextmenu', { clientX: 40, clientY: 20 })
    await w.vm.$nextTick()
    const menu = w.get('[role="menu"][aria-label="Tab actions"]')
    expect(menu.findAll('[role="menuitem"]').map(item => item.text())).toEqual([
      expect.stringContaining('Close tab'),
      'Move to Trash…',
    ])
    expect(document.activeElement).toBe(menu.get('[data-tab-menu-action="close"]').element)

    await menu.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(menu.get('[data-tab-menu-action="discard"]').element)
    await menu.trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()
    expect(document.activeElement).toBe(fileTabs(w)[0].element)

    await fileTabs(w)[0].trigger('contextmenu', { clientX: 40, clientY: 20 })
    await w.get('[data-tab-menu-action="discard"]').trigger('click')
    expect(w.emitted('discard-tab')).toEqual([[0]])
    w.unmount()
  })

  it('uses draft language in the tab menu and hides lifecycle actions when unavailable', async () => {
    const w = mountStrip({
      tabs: [{ id: 'draft-tab', name: 'Untitled.md', dirty: true, lifecycleAction: 'draft' }],
    }, { global: { stubs: { Teleport: true, Transition: false } } })

    await fileTabs(w)[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(w.get('[data-tab-menu-action="discard"]').text()).toBe('Discard draft…')

    await w.setProps({ tabs: [{ id: 'draft-tab', name: 'Untitled.md', dirty: true }] })
    await fileTabs(w)[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(w.find('[data-tab-menu-action="discard"]').exists()).toBe(false)
    w.unmount()
  })

  it('applies active class to selected tab', () => {
    const w = mountStrip({ activeTab: 1 })
    const tabs = fileTabs(w)
    expect(tabs[0].classes()).not.toContain('tab-active')
    expect(tabs[1].classes()).toContain('tab-active')
  })

  it('presents Git review as a virtual review tab', () => {
    const w = mountStrip({
      tabs: [{ id: '__git__', name: 'Changes · app.js', type: 'git-review', dirty: false }],
    })
    expect(fileTabs(w)[0].classes()).toContain('tab-review')
    expect(fileTabs(w)[0].attributes('aria-label')).toBe('Changes · app.js')
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
