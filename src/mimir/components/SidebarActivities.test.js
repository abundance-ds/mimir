import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SidebarActivities from './SidebarActivities.vue'
import WorkingIndicator from './WorkingIndicator.vue'

const tabs = [
  { id: 'agent', title: 'Fix Files', status: 'working', kind: 'agent', host: { type: 'pty' } },
  { id: 'terminal', title: 'Build', status: 'done', kind: 'terminal' },
]
let wrapper
function render() {
  wrapper = mount(SidebarActivities, { attachTo: document.body, props: { tabs, activeId: 'agent' } })
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})
const row = id => wrapper.get(`[data-activity-key="${id}"]`)
const select = id => row(id).get('button')
async function menuAction(label) {
  await flushPromises()
  const item = [...document.querySelectorAll('[role=menuitem]')].find(el => el.textContent.includes(label))
  expect(item).toBeTruthy()
  item.click()
  await flushPromises()
}

describe('Sidebar Activities', () => {
  it('selects the session without a duplicate row close button', async () => {
    render()
    expect(select('agent').attributes('aria-current')).toBe('page')
    await select('terminal').get('svg').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['terminal']])
    expect(wrapper.find('[data-activity-close]').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('select')).toHaveLength(1)
  })

  it('restores the original status hierarchy, including blocking prompts and active rows', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-11T12:00:30Z')
    const states = [
      { id: 'working', status: 'working', unread: true },
      { id: 'starting', status: 'starting' },
      { id: 'attention', status: 'needs-input' },
      { id: 'prompt-ready', status: 'needs-input' },
      { id: 'active', status: 'needs-input', unread: true },
      { id: 'error', status: 'error' },
      { id: 'api-error', status: 'idle', error: 'API authentication failed' },
      { id: 'working-error', status: 'working', error: 'API rate limit exceeded' },
      { id: 'unread', status: 'idle', unread: true },
      { id: 'done', status: 'done' },
      { id: 'idle', status: 'idle', kind: 'terminal' },
      { id: 'interrupted', status: 'interrupted' },
      { id: 'resuming', status: 'starting' },
    ].map(state => ({ title: state.id, kind: 'agent', updatedAt: '2026-09-11T12:00:00Z', ...state }))
    render()
    await wrapper.setProps({ tabs: states, activeId: 'active', blockingIds: new Set(['attention', 'active']), restoringIds: new Set(['resuming']) })
    expect(row('working').get('[data-activity-working]').findAll('span')).toHaveLength(9)
    expect(row('working').find('[data-activity-unread]').exists()).toBe(false)
    expect(row('starting').get('[aria-label="Starting"]').exists()).toBe(true)
    expect(row('attention').get('[data-activity-attention]').classes()).toContain('bg-attn/65')
    for (const id of ['error', 'api-error', 'working-error']) {
      expect(row(id).get('[data-activity-error]').classes()).toContain('bg-rem')
      expect(select(id).attributes('aria-label')).toContain('Error')
      expect(row(id).find('[data-activity-working]').exists()).toBe(false)
    }
    expect(row('unread').get('[data-activity-unread]').classes()).toContain('bg-info/60')
    for (const id of ['prompt-ready', 'active', 'done', 'idle', 'interrupted', 'resuming']) {
      expect(row(id).get('[data-activity-time]').text()).toBe('now')
      expect(row(id).find('[data-activity-working], [data-activity-error], [data-activity-attention], [data-activity-unread]').exists()).toBe(false)
    }
    expect(select('resuming').attributes('title')).toContain('Resuming')
    const grid = row('working').get('[data-activity-working]').element
    await wrapper.setProps({ tabs: states.map(tab => ({ ...tab, updatedAt: '2026-09-11T12:00:20Z' })) })
    expect(row('working').get('[data-activity-working]').element).toBe(grid)
    expect(wrapper.findAll('[data-activity-key]').map(el => el.attributes('data-activity-key'))).toEqual(states.map(tab => tab.id))
  })

  it('updates relative times with one clock and stops it on unmount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-11T12:00:30Z')
    render()
    await wrapper.setProps({ tabs: tabs.map(tab => ({ ...tab, status: 'idle', updatedAt: '2026-09-11T12:00:00Z' })) })
    expect(row('agent').get('[data-activity-time]').text()).toBe('now')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(row('agent').get('[data-activity-time]').text()).toBe('1m')
    expect(row('terminal').get('[data-activity-time]').text()).toBe('1m')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the working animation in the rail through Sidebar collapse and expansion', async () => {
    render()
    await wrapper.setProps({ rail: true })
    expect(row('agent').get('[data-activity-working]').isVisible()).toBe(true)
    expect(row('agent').findAll('svg')).toHaveLength(1)
    expect(row('agent').findComponent(WorkingIndicator).props('paused')).toBe(false)
    await wrapper.setProps({ rail: false })
    expect(row('agent').findComponent(WorkingIndicator).props('paused')).toBe(false)
  })

  it('moves focus with arrows and restores it after a keyboard menu', async () => {
    render()
    select('agent').element.focus()
    await select('agent').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(select('terminal').element)
    expect(wrapper.emitted('select')).toBeUndefined()
    await select('terminal').trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(select('agent').element)
    await select('agent').trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(select('agent').element)
  })

  it('renames from F2 and the menu, with cancellation for IME, blur, and collapse', async () => {
    render()
    await select('terminal').trigger('keydown', { key: 'F2' })
    expect(wrapper.get('input').element.selectionEnd).toBe('Build'.length)
    await wrapper.get('input').setValue('  New name  ')
    await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('rename')).toBeUndefined()
    await wrapper.get('input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('rename')).toEqual([[{ id: 'terminal', title: 'New name' }]])
    await row('agent').trigger('contextmenu')
    await menuAction('Rename')
    await wrapper.get('input').trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(select('agent').element)
    await select('agent').trigger('dblclick')
    await wrapper.get('input').trigger('blur')
    await select('agent').trigger('dblclick')
    await wrapper.setProps({ rail: true })
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.emitted('rename')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('emits the same session order and lifecycle actions from its menu', async () => {
    render()
    await row('agent').trigger('contextmenu')
    await menuAction('Move down')
    expect(wrapper.emitted('reorder')).toEqual([[['terminal', 'agent']]])
    await row('agent').trigger('contextmenu')
    await menuAction('Stop and archive')
    expect(wrapper.emitted('close')).toEqual([['agent']])
  })

  it('retains row identity and attention through Sidebar collapse, and offers New when empty', async () => {
    render()
    const element = row('agent').element
    await wrapper.setProps({ tabs: [{ ...tabs[0], status: 'idle', unread: true }, tabs[1]], activeId: 'terminal', rail: true })
    expect(wrapper.find('[data-activities-disclosure]').exists()).toBe(false)
    expect(wrapper.get('nav').isVisible()).toBe(true)
    expect(wrapper.find('[aria-label="Activities need attention"]').exists()).toBe(true)
    await wrapper.setProps({ rail: false })
    expect(row('agent').element).toBe(element)
    expect(select('agent').attributes('aria-label')).toBe('Fix Files — Unread')
    expect(row('agent').find('[data-activity-close]').exists()).toBe(false)
    await select('agent').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['agent']])
    await wrapper.setProps({ rail: false, tabs: [] })
    expect(wrapper.text()).toContain('No open activities')
    await wrapper.get('[aria-label="New Activity"]').trigger('click')
    expect(wrapper.emitted('new')).toHaveLength(1)
  })
})
