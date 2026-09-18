import { DOMWrapper, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GraphViewbar from './GraphViewbar.vue'
import { BOARD_GROUP_OPTIONS, BOARD_SORT_OPTIONS, BOARD_STATUSES, PRIORITY_FILTER_OPTIONS } from './useGraphViewState.js'

describe('responsive Graph view controls', () => {
  let resize
  let wrapper
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback }
      observe() {}
      disconnect() {}
    })
    wrapper = mount(GraphViewbar, {
      attachTo: document.body,
      props: {
        section: 'work', view: 'board',
        viewOptions: [{ id: 'board', label: 'Board' }, { id: 'list', label: 'List' }],
        projectFilter: 'p',
        projectOptions: [{ value: '', label: 'All projects' }, { value: 'p', label: 'Project Alpha' }],
        assigneeOptions: [{ value: '', label: 'Anyone' }],
        groupOptions: BOARD_GROUP_OPTIONS, sortOptions: BOARD_SORT_OPTIONS,
        priorityOptions: PRIORITY_FILTER_OPTIONS, statuses: BOARD_STATUSES,
      },
    })
  })
  afterEach(() => {
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('keeps the selected value and clear action when controls move into the header', async () => {
    resize([{ contentRect: { width: 1100 } }])
    await nextTick()
    expect(wrapper.get('[data-graph-filters-trigger]').isVisible()).toBe(false)
    const project = wrapper.get('[data-board-project-filter]')
    expect(project.isVisible()).toBe(true)
    expect(project.text()).toContain('Project Alpha')
    await wrapper.get('[data-graph-control="board-project-filter-clear"]').trigger('click')
    expect(wrapper.emitted('update:projectFilter')).toEqual([['']])

    project.element.focus()
    resize([{ contentRect: { width: 420 } }])
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-graph-filters-trigger]').element)
    expect(wrapper.get('[data-graph-filter-chip="project"]').text()).toContain('Project Alpha')
    await wrapper.get('[data-graph-filters-trigger]').trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(wrapper.get('[data-board-project-filter]').isVisible()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-board-project-filter]').element)
  })

  it('closes a portalled selector safely when the pane becomes narrow', async () => {
    resize([{ contentRect: { width: 1100 } }])
    await nextTick()
    await wrapper.get('[data-board-project-filter]').trigger('click')
    expect(document.querySelector('[data-graph-select-menu]')).not.toBeNull()
    resize([{ contentRect: { width: 420 } }])
    await nextTick()
    await nextTick()
    expect(document.querySelector('[data-graph-select-menu]')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('[data-graph-filters-trigger]').element)
    expect(wrapper.emitted('update:projectFilter')).toBeUndefined()
  })

  it('keeps text search available for a short project list and selects a matching project', async () => {
    resize([{ contentRect: { width: 1100 } }])
    await nextTick()
    await wrapper.setProps({ projectOptions: [
      { value: 'zeta', label: 'Zeta', hint: 'Current workspace' },
      { value: '', label: 'All projects' },
      { value: 'alpha', label: 'Alpha' },
    ] })
    await wrapper.get('[data-board-project-filter]').trigger('click')
    const body = new DOMWrapper(document.body)
    expect(body.findAll('[data-graph-select-option]')[0].text()).toContain('Zeta')
    const search = body.get('[data-graph-select-search]')
    expect(document.activeElement).toBe(search.element)
    await search.setValue('alp')
    expect(body.findAll('[data-graph-select-option]').map(option => option.attributes('data-graph-select-option'))).toEqual(['alpha'])
    await search.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:projectFilter')).toEqual([['alpha']])
  })

  it('shows an icon for any owner and a clearable name for a selected owner', async () => {
    resize([{ contentRect: { width: 700 } }])
    await nextTick()
    const owner = wrapper.get('[data-board-assignee-filter]')
    expect(owner.text()).toBe('')
    expect(owner.attributes('aria-label')).toBe('Owner view: Anyone')
    expect(owner.find('svg').exists()).toBe(true)
    expect(wrapper.get('[data-board-project-filter]').isVisible()).toBe(true)
    expect(wrapper.get('[data-board-priority-filter]').text()).toBe('Filter')
    expect(wrapper.get('[data-board-group]').isVisible()).toBe(false)
    expect(wrapper.get('[data-board-sort]').isVisible()).toBe(false)

    await wrapper.setProps({
      assigneeFilter: 'anna',
      assigneeOptions: [{ value: '', label: 'Anyone' }, { value: 'anna', label: 'Anna' }],
    })
    expect(owner.text()).toBe('Anna')
    await wrapper.get('[data-graph-control="board-assignee-filter-clear"]').trigger('click')
    expect(wrapper.emitted('update:assigneeFilter')).toEqual([['']])

    resize([{ contentRect: { width: 336 } }])
    await nextTick()
    expect(wrapper.find('[data-graph-filter-chip]').exists()).toBe(false)
    expect(wrapper.get('.graph-filter-count').text()).toBe('2')
    expect(wrapper.get('[data-graph-filters-trigger]').attributes('title')).toContain('Owner: Anna')
    await wrapper.get('[data-graph-filters-trigger]').trigger('click')
    expect(wrapper.get('[data-board-assignee-filter]').text()).toBe('Anna')
    expect(wrapper.get('[data-graph-control="board-assignee-filter-clear"]').isVisible()).toBe(true)
  })

  it('offers empty projects only on a project Board without adding a task filter', async () => {
    await wrapper.setProps({ projectFilter: '' })
    const selector = '[data-graph-control="work-show-empty-projects"]'
    expect(wrapper.find(selector).exists()).toBe(false)
    await wrapper.setProps({ groupBy: 'project' })
    await wrapper.get('[data-graph-display-trigger]').trigger('click')
    expect(wrapper.get(selector).attributes('aria-checked')).toBe('false')
    await wrapper.get(selector).trigger('click')
    expect(wrapper.emitted('update:showEmptyProjects')).toEqual([[true]])
    await wrapper.setProps({ showEmptyProjects: true })
    expect(wrapper.get(selector).attributes('aria-checked')).toBe('true')
    expect(wrapper.find('.graph-filter-count').exists()).toBe(false)
    await wrapper.setProps({ view: 'list' })
    expect(wrapper.find(selector).exists()).toBe(false)
  })

  it('keeps layout settings together and excludes collapsed columns from task filters', async () => {
    await wrapper.setProps({ projectFilter: '', collapsedStatuses: ['done'] })
    expect(wrapper.find('[data-graph-filter-chip="columns"]').exists()).toBe(false)
    expect(wrapper.find('.graph-filter-count').exists()).toBe(false)
    const trigger = wrapper.get('[data-graph-display-trigger]')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-board-group]').element)
    const menu = wrapper.get('[data-graph-display-popover]')
    expect(menu.get('[data-board-sort]').isVisible()).toBe(true)
    expect(menu.get('[data-board-columns-trigger]').text()).toContain('1 collapsed')
    expect(menu.find('[data-board-project-filter]').exists()).toBe(false)

    await wrapper.setProps({ groupBy: 'project' })
    expect(menu.isVisible()).toBe(true)
    expect(menu.find('[data-board-columns-trigger]').exists()).toBe(false)
    await menu.trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(document.activeElement).toBe(trigger.element)
    expect(wrapper.get('[data-graph-display-popover]').isVisible()).toBe(false)
  })

  it('keeps Work display controls out of Graph', async () => {
    await wrapper.setProps({ section: 'all', view: 'list' })
    expect(wrapper.find('[data-graph-display-trigger]').exists()).toBe(false)
    expect(wrapper.find('[data-graph-filters-trigger]').exists()).toBe(false)
  })
})
