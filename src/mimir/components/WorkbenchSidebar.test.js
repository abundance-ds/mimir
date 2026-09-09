import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkbenchSidebar from './WorkbenchSidebar.vue'
let wrapper
afterEach(() => wrapper?.unmount())
describe('WorkbenchSidebar', () => {
  it('keeps human-only microphone mute and Stop available in expanded and rail modes', async () => {
    wrapper = mount(WorkbenchSidebar, {
      props: {
        meetingCapture: {
          id: 'meeting-1',
          title: 'Architecture review',
          lifecycle: 'capturing',
          startedAt: new Date(Date.now() - 62_000).toISOString(),
          durationMs: 62_000,
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
    await wrapper.get('[title="Open recording"]').trigger('click')
    expect(wrapper.emitted('openMeeting')).toHaveLength(1)

    await wrapper.setProps({
      meetingCapture: {
        ...wrapper.props('meetingCapture'),
        micMuted: true,
      },
    })
    expect(wrapper.get('[data-sidebar-meeting-microphone]').attributes('aria-label'))
      .toBe('Unmute microphone')
  })

  it('does not insert a restore row into the sidebar rail', () => {
    const wrapper = mount(WorkbenchSidebar, { props: { collapsed: true } })
    expect(wrapper.find('[data-sidebar-restore]').exists()).toBe(false)
    expect(wrapper.get('[data-sidebar-header]').element.nextElementSibling.contains(wrapper.get('[data-sidebar-workspace]').element)).toBe(true)
  })

  it('keeps Files mounted when Tools or the sidebar is collapsed', async () => {
    wrapper = mount(WorkbenchSidebar, {
      props: { tools: [{ id: 'graph', title: 'Graph', icon: 'graph' }] },
      slots: { files: '<input data-files value="selected file" />' },
    })
    const files = wrapper.get('[data-files]').element
    await wrapper.get('[data-tools-disclosure]').trigger('click')
    expect(wrapper.emitted('toggleTools')).toHaveLength(1)
    await wrapper.setProps({ toolsCollapsed: true })
    expect(wrapper.get('[data-files]').element).toBe(files)
    expect(
      wrapper.get('nav[aria-label="Tools"]').attributes('style'),
    ).toContain('display: none')
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.get('[data-files]').element).toBe(files)
    expect(
      wrapper.get('nav[aria-label="Tools"]').attributes('style') || '',
    ).toContain('display: none')
    expect(wrapper.find('[data-sidebar-collapse]').exists()).toBe(false)
    expect(wrapper.get('[data-sidebar-header]').find('button').exists()).toBe(false)
    await wrapper.get('[aria-label="Open Files"]').trigger('click')
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
  })
  it('retains the Tools heading space without a hidden keyboard stop', async () => {
    wrapper = mount(WorkbenchSidebar)
    const disclosure = wrapper.get('[data-tools-disclosure]').element
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.get('[data-tools-disclosure]').element).toBe(disclosure)
    expect(wrapper.get('[data-tools-disclosure]').classes()).toContain('invisible')
    expect(wrapper.get('[data-tools-disclosure]').attributes('tabindex')).toBe('-1')
    expect(wrapper.get('[data-tools-disclosure]').attributes('aria-hidden')).toBe('true')
    await wrapper.setProps({ collapsed: false })
    expect(wrapper.get('[data-tools-disclosure]').classes()).not.toContain('invisible')
    expect(wrapper.get('[data-tools-disclosure]').attributes('tabindex')).toBeUndefined()
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
