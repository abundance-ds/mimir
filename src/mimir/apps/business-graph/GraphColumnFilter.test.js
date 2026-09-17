import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GraphColumnFilter from './GraphColumnFilter.vue'
let wrapper
const body = () => new DOMWrapper(document.body)
const option = id => body().get(`[data-graph-control="graph-filter-option-kind-${id}"]`)
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })
function render(props = {}) {
  wrapper = mount(GraphColumnFilter, { attachTo: document.body, props: {
    column: 'kind', label: 'Kind', options: [{ value: 'note', label: 'Note' }, { value: 'project', label: 'Project' }],
    modelValue: [], 'onUpdate:modelValue': modelValue => wrapper.setProps({ modelValue }), ...props,
  } })
  return wrapper
}

describe('Graph column filter in a clipped pane', () => {
  it('shows the active count and names, clears in one click, and restores focus', async () => {
    render({ modelValue: ['note', 'project'] })
    const trigger = wrapper.get('[aria-haspopup="dialog"]')
    expect(trigger.text()).toBe('2')
    expect(trigger.attributes('title')).toBe('Kind: Note, Project')
    const clear = wrapper.get('[data-graph-control="graph-filter-clear-kind"]')
    clear.element.focus()
    await clear.trigger('click')
    expect(wrapper.props('modelValue')).toEqual([])
    expect(document.activeElement).toBe(trigger.element)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-graph-control="graph-filter-clear-kind"]').exists()).toBe(false)
  })

  it('puts selected options first on open without moving rows during selection', async () => {
    render({ modelValue: ['project'] })
    const trigger = wrapper.get('[aria-haspopup="dialog"]')
    const labels = () => body().findAll('[role="checkbox"]').map(item => item.text())
    await trigger.trigger('click')
    expect(labels()).toEqual(['Project', 'Note'])
    await option('project').trigger('click')
    await option('note').trigger('click')
    expect(labels()).toEqual(['Project', 'Note'])
    await trigger.trigger('click')
    await trigger.trigger('click')
    expect(labels()).toEqual(['Note', 'Project'])
  })

  it('renders outside the pane and keeps option clicks inside the open filter', async () => {
    render()
    const trigger = wrapper.get('[aria-haspopup="dialog"]')
    await trigger.trigger('click')
    const menu = body().get('[data-graph-column-filter]').element
    expect(menu.parentElement).toBe(document.body)
    expect(wrapper.element.contains(menu)).toBe(false)
    expect(menu.hasAttribute('data-modal-portal')).toBe(true)
    // WebKit does not focus a button on click. Focus the chosen row before the
    // browser can blur the old row; prevent that mousedown default.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    option('project').element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    option('project').element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(option('project').element)
    await option('project').get('.graph-column-option-label').trigger('click')
    expect(wrapper.props('modelValue')).toEqual(['project'])
    expect(option('project').attributes('aria-checked')).toBe('true')
    await option('note').trigger('click')
    expect(wrapper.props('modelValue')).toEqual(['project', 'note'])
    expect(body().find('[data-graph-column-filter]').exists()).toBe(true)
    await body().get('[data-graph-column-filter]').trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(trigger.element)
    expect(body().find('[data-graph-column-filter]').exists()).toBe(false)
  })

  it('closes on a second icon click even when native focus dismisses it before click', async () => {
    render({ modelValue: ['note'] })
    const trigger = wrapper.get('[aria-haspopup="dialog"]')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    await trigger.trigger('pointerdown', { button: 0 })
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    trigger.element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(trigger.element)
    // Reproduce a host focus change between the pointer press and click.
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await trigger.trigger('click', { detail: 1 })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(body().find('[data-graph-column-filter]').exists()).toBe(false)
    expect(wrapper.props('modelValue')).toEqual(['note'])
    await trigger.trigger('pointerdown', { button: 0 })
    await trigger.trigger('click', { detail: 1 })
    expect(trigger.attributes('aria-expanded')).toBe('true')
    // Keyboard activation uses the current state, without a pointer press.
    await trigger.trigger('click', { detail: 0 })
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('clamps a menu near the window edge and dismisses only an outside click', async () => {
    render()
    const trigger = wrapper.get('[aria-haspopup="dialog"]')
    vi.spyOn(trigger.element, 'getBoundingClientRect').mockReturnValue({ left: window.innerWidth - 26, right: window.innerWidth, top: 35, bottom: 63 })
    await trigger.trigger('click')
    const menu = body().get('[data-graph-column-filter]')
    expect(parseFloat(menu.element.style.left) + parseFloat(menu.element.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
    await menu.trigger('pointerdown')
    expect(body().find('[data-graph-column-filter]').exists()).toBe(true)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(body().find('[data-graph-column-filter]').exists()).toBe(false)
  })
})
