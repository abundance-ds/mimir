import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import WorkbenchSidebar from './WorkbenchSidebar.vue'
const scribeTool = { id: 'app:scribe', title: 'Scribe', icon: 'scribe' }
let wrapper
afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})
describe('WorkbenchSidebar', () => {
  it('keeps human-only microphone mute and Stop available in expanded and rail modes', async () => {
    wrapper = mount(WorkbenchSidebar, {
      props: {
        tools: [scribeTool],
        meetingCapture: {
          id: 'meeting-1',
          title: 'Architecture review',
          lifecycle: 'capturing',
          startedAt: new Date(Date.now() - 62_000).toISOString(),
          durationMs: 0,
          micMuted: false,
        },
      },
    })

    expect(wrapper.get('[data-sidebar-meeting-capture]').text()).toContain('Recording')
    expect(wrapper.get('[data-sidebar-meeting-microphone]').attributes('aria-label'))
      .toBe('Mute microphone')
    await wrapper.get('[data-sidebar-meeting-microphone]').trigger('click')
    expect(wrapper.emitted('setMeetingMicMuted')).toEqual([[true]])
    await wrapper.get('[aria-label="Stop recording"]').trigger('click')
    expect(wrapper.emitted('stopMeeting')).toHaveLength(1)

    await wrapper.setProps({ collapsed: true })
    expect(wrapper.get('[data-sidebar-meeting-microphone]').attributes('aria-label'))
      .toBe('Mute microphone')
    expect(wrapper.get('[aria-label="Stop recording"]').exists()).toBe(true)
    await wrapper.get('[data-sidebar-meeting-open]').trigger('click')
    expect(wrapper.emitted('openMeeting')).toHaveLength(1)

    await wrapper.setProps({
      meetingCapture: {
        ...wrapper.props('meetingCapture'),
        micMuted: true,
      },
    })
    expect(wrapper.get('[data-sidebar-meeting-microphone]').attributes('aria-label'))
      .toBe('Unmute microphone')
    expect(wrapper.get('[data-sidebar-meeting-microphone]').attributes('aria-pressed')).toBe('true')
  })

  it('keeps elapsed time running through silence and collapse, including continued recordings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T10:00:02Z'))
    wrapper = mount(WorkbenchSidebar, {
      props: { tools: [scribeTool], meetingCapture: {
        id: 'continued', lifecycle: 'capturing', micMuted: false,
        startedAt: '2026-09-15T08:00:00Z', recordingStartedAt: '2026-09-16T10:00:00Z',
        durationMs: 3_600_000,
      } },
    })
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('1:00:02')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('1:00:05')
    await wrapper.setProps({ collapsed: true })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('1:00:07')
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.get('[role="status"]').text()).toBe('Recording')
    expect(wrapper.get('[role="status"]').text()).not.toContain('1:00:07')

    await wrapper.setProps({ meetingCapture: {
      ...wrapper.props('meetingCapture'), lifecycle: 'finalizing', durationMs: 3_607_000,
    } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('1:00:07')
    expect(wrapper.get('[role="status"]').text()).toBe('Finalizing')
    await wrapper.setProps({ meetingCapture: null })
    expect(wrapper.find('[data-sidebar-meeting-capture]').exists()).toBe(false)
  })

  it.each([
    { lifecycle: 'stopping' },
    { lifecycle: 'finalizing' },
    { lifecycle: 'capturing', stopPending: true },
  ])('prevents duplicate recording actions while $lifecycle with $stopPending', async state => {
    wrapper = mount(WorkbenchSidebar, {
      props: { tools: [scribeTool], meetingCapture: { id: 'm1', micMuted: false, durationMs: 65_000, ...state } },
    })
    expect(wrapper.get('[data-sidebar-meeting-elapsed]').text()).toBe('1:05')
    for (const selector of ['[data-sidebar-meeting-microphone]', '[data-sidebar-meeting-stop]']) {
      expect(wrapper.get(selector).element.disabled).toBe(true)
      await wrapper.get(selector).trigger('click')
    }
    expect(wrapper.emitted('setMeetingMicMuted')).toBeUndefined()
    expect(wrapper.emitted('stopMeeting')).toBeUndefined()
    await wrapper.get('[data-sidebar-meeting-open]').trigger('click')
    expect(wrapper.emitted('openMeeting')).toHaveLength(1)
  })

  it.each([false, true])('keeps recording below Scribe when Tools are reordered, collapsed=%s', async collapsed => {
    const otherTool = { id: 'graph', title: 'Graph', icon: 'graph' }
    wrapper = mount(WorkbenchSidebar, { props: {
      collapsed, tools: [scribeTool, otherTool],
      meetingCapture: { id: 'm1', lifecycle: 'capturing', durationMs: 65_000 },
    } })
    const recording = wrapper.get('[data-sidebar-meeting-capture]').element
    const scribe = wrapper.get('[data-tool-key="app:scribe"]').element
    expect(scribe.nextElementSibling).toBe(recording)
    expect(wrapper.get('nav[aria-label="Tools"]').element.contains(recording)).toBe(true)

    await wrapper.setProps({ tools: [otherTool, scribeTool] })
    expect(wrapper.get('[data-sidebar-meeting-capture]').element).toBe(recording)
    expect(scribe.nextElementSibling).toBe(recording)
    expect(wrapper.get('[data-tool-key="graph"]').element.nextElementSibling).toBe(scribe)
    await wrapper.get('[data-sidebar-meeting-stop]').trigger('click')
    expect(wrapper.emitted('stopMeeting')).toHaveLength(1)
    expect(wrapper.emitted('launch')).toBeUndefined()
    expect(wrapper.emitted('reorderTools')).toBeUndefined()
  })

  it('uses the Tools heading slot for Sidebar restore and keeps navigation rows mounted', async () => {
    wrapper = mount(WorkbenchSidebar, { props: { tools: [{ id: 'graph', title: 'Graph', icon: 'graph' }] } })
    const heading = wrapper.get('[data-tools-heading]').element
    const row = wrapper.get('[data-tool-key]').element
    expect(wrapper.find('[data-tools-disclosure], [data-activities-disclosure]').exists()).toBe(false)
    await wrapper.setProps({ collapsed: true })
    expect(heading.contains(wrapper.get('[data-sidebar-restore]').element)).toBe(true)
    expect(wrapper.get('[data-tool-key]').element).toBe(row)
    expect(wrapper.get('[data-sidebar-header]').find('button').exists()).toBe(false)
    await wrapper.get('[data-sidebar-restore]').trigger('click')
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
  })

  it('keeps Files mounted and remembers its height through Files and Sidebar collapse', async () => {
    wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body, props: { filesHeight: 300 }, slots: { files: ({ collapse }) => h('div', [h('input', { 'data-files-search': '', value: 'selected file' }), h('button', { 'data-files-collapse': '', onClick: collapse }, 'Collapse Files')]) },
    })
    const input = wrapper.get('[data-files-search]').element
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('328px')
    expect(wrapper.find('[data-sidebar-files-toggle]').exists()).toBe(false)
    await wrapper.get('[data-files-collapse]').trigger('click')
    expect(wrapper.emitted('toggleFiles')).toHaveLength(1)
    await wrapper.setProps({ filesCollapsed: true })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(false)
    expect(wrapper.get('[data-sidebar-files-content]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-sidebar-files-resize]').exists()).toBe(false)
    await wrapper.setProps({ filesCollapsed: false, collapsed: true })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    expect(wrapper.get('[data-files-search]').element).toBe(input)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(false)
    await wrapper.get('[data-sidebar-files-restore]').trigger('click')
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
    await wrapper.setProps({ collapsed: false })
    expect(wrapper.get('[data-files-search]').element).toBe(input)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(true)
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('328px')
  })

  it('changes Files height by keyboard with bounds', async () => {
    wrapper = mount(WorkbenchSidebar, { props: { filesHeight: 240 } })
    const handle = wrapper.get('[data-sidebar-files-resize]')
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('resizeFiles').at(-1)).toEqual([268])
    await handle.trigger('keydown', { key: 'ArrowDown', shiftKey: true })
    expect(wrapper.emitted('resizeFiles').at(-1)).toEqual([184])
    await handle.trigger('keydown', { key: 'Home' })
    expect(wrapper.emitted('resizeFiles').at(-1)).toEqual([112])
    await handle.trigger('keydown', { key: 'End' })
    expect(wrapper.emitted('resizeFiles').at(-1)).toEqual([488])
  })

  it('opens both Sidebar and Files from the bottom rail icon without losing saved height', async () => {
    wrapper = mount(WorkbenchSidebar, { props: { collapsed: true, filesCollapsed: true, filesHeight: 300 } })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    await wrapper.get('[data-sidebar-files-restore]').trigger('click')
    expect(wrapper.emitted('toggleCollapse')).toEqual([[]])
    expect(wrapper.emitted('toggleFiles')).toEqual([[]])
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    await wrapper.setProps({ collapsed: false, filesCollapsed: false })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('328px')
  })

  it('saves a completed drag once, and restores height on Escape or pointer cancellation', async () => {
    wrapper = mount(WorkbenchSidebar, { props: { filesHeight: 240 } })
    const handle = wrapper.get('[data-sidebar-files-resize]')
    const pointer = (type, clientY) => window.dispatchEvent(new PointerEvent(type, { clientY, pointerId: 1 }))
    await handle.trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    pointer('pointermove', 250)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('318px')
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('268px')
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    await handle.trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    pointer('pointermove', 200)
    pointer('pointerup', 200)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('resizeFiles')).toEqual([[340]])
    await handle.trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    pointer('pointermove', 200)
    pointer('pointercancel', 200)
    expect(wrapper.emitted('resizeFiles')).toHaveLength(1)
  })

  it('snaps Files closed and opens it again during the same drag without losing the mounted browser', async () => {
    wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body, props: { filesHeight: 240 },
      slots: { files: '<input data-files-search value="retained" />' },
    })
    const input = wrapper.get('[data-files-search]').element
    const pointer = (type, clientY) => window.dispatchEvent(new PointerEvent(type, { clientY, pointerId: 1 }))
    await wrapper.get('[data-sidebar-files-resize]').trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    pointer('pointermove', 460) // Below the usable minimum, but above the collapse threshold.
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('140px')
    pointer('pointermove', 490)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    expect(wrapper.find('[data-sidebar-files-resize]').exists()).toBe(false)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(false)
    expect(wrapper.emitted('toggleFiles')).toBeUndefined()
    pointer('pointermove', 483) // Small pointer jitter must not reopen it.
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    pointer('pointermove', 450)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('140px')
    expect(wrapper.get('[data-files-search]').element).toBe(input)
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(true)
    pointer('pointerup', 350)
    expect(wrapper.emitted('resizeFiles')).toEqual([[190]])
    expect(wrapper.emitted('toggleFiles')).toBeUndefined()
    await wrapper.setProps({ filesHeight: 190 })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('218px')
  })

  it('saves drag collapse on release, suppresses its click, and can drag open again', async () => {
    wrapper = mount(WorkbenchSidebar, { attachTo: document.body, props: { filesHeight: 240 } })
    await wrapper.get('[data-sidebar-files-resize]').trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 510, pointerId: 1 }))
    await wrapper.vm.$nextTick()
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 510, pointerId: 1 }))
    expect(wrapper.emitted('toggleFiles')).toEqual([[]])
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    await wrapper.setProps({ filesCollapsed: true })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-files-toggle]').element)
    await wrapper.get('[data-sidebar-files-toggle]').trigger('click', { detail: 1 })
    expect(wrapper.emitted('toggleFiles')).toHaveLength(1)
    await wrapper.get('[data-sidebar-files-toggle]').trigger('pointerdown', { button: 0, clientY: 500, pointerId: 2 })
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 340, pointerId: 2 }))
    expect(wrapper.emitted('resizeFiles')).toEqual([[160]])
    expect(wrapper.emitted('toggleFiles')).toHaveLength(2)
    await wrapper.setProps({ filesCollapsed: false, filesHeight: 160 })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('188px')
  })

  it.each(['Escape', 'pointercancel'])('restores the open Files height when a snapped drag is cancelled with %s', async cancel => {
    wrapper = mount(WorkbenchSidebar, { attachTo: document.body, props: { filesHeight: 240 } })
    await wrapper.get('[data-sidebar-files-resize]').trigger('pointerdown', { button: 0, clientY: 300, pointerId: 1 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 510, pointerId: 1 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    if (cancel === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 510, pointerId: 1 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('268px')
    expect(wrapper.emitted('toggleFiles')).toBeUndefined()
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-files-resize]').element)
  })

  it('previews an upward drag from collapsed and saves height only on release', async () => {
    wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body,
      props: { filesCollapsed: true, filesHeight: 300 },
      slots: { files: '<input data-files-search value="retained" />' },
    })
    const row = wrapper.get('[data-sidebar-files-toggle]')
    await row.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 40, clientY: 500 })
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 497 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 450 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('78px')
    expect(wrapper.get('[data-sidebar-files-content]').isVisible()).toBe(true)
    expect(wrapper.get('[data-sidebar-files-content]').attributes('inert')).toBeDefined()
    expect(wrapper.find('[data-sidebar-files-toggle]').exists()).toBe(false)
    expect(wrapper.emitted('toggleFiles')).toBeUndefined()
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 310 }))
    expect(wrapper.emitted('resizeFiles')).toEqual([[190]])
    expect(wrapper.emitted('toggleFiles')).toEqual([[]])
    await wrapper.setProps({ filesCollapsed: false, filesHeight: 190 })
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('218px')
    expect(document.activeElement).toBe(wrapper.get('[data-sidebar-files-resize]').element)
  })

  it.each(['Escape', 'pointercancel', 'return', 'rail'])('cancels collapsed dragging with %s without changing saved state or allowing a stray click', async cancel => {
    wrapper = mount(WorkbenchSidebar, { attachTo: document.body, props: { filesCollapsed: true, filesHeight: 300 } })
    await wrapper.get('[data-sidebar-files-toggle]').trigger('pointerdown', { button: 0, pointerId: 1, clientX: 40, clientY: 500 })
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 300 }))
    await wrapper.vm.$nextTick()
    if (cancel === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else if (cancel === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))
    else if (cancel === 'rail') await wrapper.setProps({ collapsed: true })
    else window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 499 }))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 499 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-sidebar-files]').element.style.height).toBe('28px')
    await wrapper.get('[data-sidebar-files-toggle]').trigger('click', { detail: 1 })
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    expect(wrapper.emitted('toggleFiles')).toBeUndefined()
    expect(wrapper.emitted('toggleCollapse')).toBeUndefined()
    // The next deliberate click still restores the saved height.
    await wrapper.get('[data-sidebar-files-toggle]').trigger('pointerdown', { button: 0, pointerId: 2, clientX: 40, clientY: 500 })
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 40, clientY: 500 }))
    await wrapper.get('[data-sidebar-files-toggle]').trigger('click', { detail: 1 })
    expect(wrapper.emitted('toggleFiles')).toEqual([[]])
  })

  it('keeps click behavior for a small movement and uses the minimum size after a short drag', async () => {
    wrapper = mount(WorkbenchSidebar, { attachTo: document.body, props: { filesCollapsed: true, filesHeight: 300 } })
    await wrapper.get('[data-sidebar-files-toggle]').trigger('pointerdown', { button: 0, pointerId: 1, clientX: 40, clientY: 500 })
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 41, clientY: 497 }))
    await wrapper.get('[data-sidebar-files-toggle]').trigger('click', { detail: 1 })
    expect(wrapper.emitted('toggleFiles')).toEqual([[]])
    expect(wrapper.emitted('resizeFiles')).toBeUndefined()
    await wrapper.get('[data-sidebar-files-toggle]').trigger('pointerdown', { button: 0, pointerId: 2, clientX: 40, clientY: 500 })
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 40, clientY: 480 }))
    expect(wrapper.emitted('resizeFiles')).toEqual([[112]])
  })

  it('moves keyboard focus through Tools without opening a tool', async () => {
    wrapper = mount(WorkbenchSidebar, {
      attachTo: document.body,
      props: { tools: [
        { id: 'today', title: 'Today', icon: 'today' },
        { id: 'graph', title: 'Graph', icon: 'graph' },
        { id: 'scribe', title: 'Scribe', icon: 'scribe' },
      ] },
    })
    const today = wrapper.get('[data-tool-key="today"] button')
    const graph = wrapper.get('[data-tool-key="graph"] button')
    const scribe = wrapper.get('[data-tool-key="scribe"] button')
    today.element.focus()
    await today.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(graph.element)
    await graph.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(scribe.element)
    await scribe.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(today.element)
    expect(wrapper.emitted('launch')).toBeUndefined()
  })
  it('launches a tool without creating a session row', async () => {
    wrapper = mount(WorkbenchSidebar, {
      props: { tools: [{ id: 'graph', title: 'Graph', icon: 'graph' }] },
    })
    await wrapper.get('[data-tool-key="graph"]').trigger('click')
    expect(wrapper.emitted('launch')).toEqual([['graph']])
    expect(wrapper.find('[data-sidebar-row^="activity:"]').exists()).toBe(false)
  })
})
