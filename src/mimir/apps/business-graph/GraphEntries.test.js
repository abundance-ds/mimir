import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GraphEntries from './GraphEntries.vue'

const projects = [{ id: 'atlas', kind: 'project', title: 'Atlas' }, { id: 'beta', kind: 'project', title: 'Beta' }]
const nodes = [
  projects[0],
  { id: 'note-a', kind: 'note', title: 'Review evidence', updatedAt: '2026-09-14', createdAt: '2026-07-01', relations: [{ relation: 'part_of', target: 'atlas' }, { relation: 'part_of', target: 'beta' }] },
  { id: 'note-b', kind: 'note', title: 'Release notes', updatedAt: '2026-08-16', createdAt: '', projectId: 'missing' },
]
let wrapper
afterEach(() => wrapper?.unmount())
function render(props = {}) {
  wrapper = mount(GraphEntries, { attachTo: document.body, props: { nodes, projects, ...props } })
  return wrapper
}
const body = () => new DOMWrapper(document.body)
const control = id => body().get(`[data-graph-control="${id}"]`)

describe('Graph entry table', () => {
  it('sorts all five columns by their labels and reverses the active order', async () => {
    render()
    expect(wrapper.findAll('thead th').map(th => th.text())).toEqual(['Title', 'Kind', 'Project', 'Created', 'Updated'])
    expect(wrapper.get('th[aria-sort]').attributes('aria-sort')).toBe('descending')
    await control('graph-sort-updated').trigger('click')
    expect(wrapper.emitted('sort').at(-1)).toEqual([{ sortBy: 'updated', direction: 'asc' }])
    for (const field of ['title', 'kind', 'project', 'created']) {
      await control(`graph-sort-${field}`).trigger('click')
      expect(wrapper.emitted('sort').at(-1)).toEqual([{ sortBy: field, direction: undefined }])
    }
    await control('graph-filter-kind').trigger('click')
    expect(wrapper.emitted('sort')).toHaveLength(5)
  })

  it('opens the row entry from every cell, including the project cell', async () => {
    render()
    const row = wrapper.get('[data-entry-row="note-a"]')
    for (const cell of row.findAll('td')) await cell.trigger('click')
    await control('list-open-note-a').trigger('click')
    expect(wrapper.emitted('open')).toEqual(Array.from({ length: 6 }, () => ['note-a']))
    expect(row.get('.graph-entry-project').text()).toBe('Atlas+1')
    expect(row.get('.graph-entry-project').attributes('title')).toBe('Atlas, Beta')
    expect(wrapper.get('[data-entry-row="atlas"] .graph-entry-project').text()).toBe('Atlas')
    expect(wrapper.get('[data-entry-row="note-b"] .graph-entry-project').attributes('title')).toBe('No project')
  })

  it('applies multiple kinds immediately, retains the popup, and restores focus on Escape', async () => {
    render({ 'onUpdate:kinds': kinds => wrapper.setProps({ kinds }) })
    await control('graph-filter-kind').trigger('click')
    await control('graph-filter-option-kind-note').trigger('click')
    await control('graph-filter-option-kind-project').trigger('click')
    expect(wrapper.emitted('update:kinds')).toEqual([[['note']], [['note', 'project']]])
    expect(body().get('[data-graph-column-filter]').exists()).toBe(true)
    expect(control('graph-clear-kinds').text()).toBe('Kind: Note, Project')
    await body().get('[data-graph-column-filter]').trigger('keydown', { key: 'Escape' })
    expect(body().find('[data-graph-column-filter]').exists()).toBe(false)
    expect(document.activeElement).toBe(control('graph-filter-kind').element)
    await control('graph-clear-kinds').trigger('click')
    expect(wrapper.props('kinds')).toEqual([])
  })

  it('finds projects by text, lists the current project first, and retains selected projects outside search', async () => {
    render({ currentProjectId: 'beta', 'onUpdate:projectIds': projectIds => wrapper.setProps({ projectIds }) })
    await control('graph-filter-project').trigger('click')
    expect(body().findAll('[role="checkbox"]')[0].text()).toContain('Beta')
    expect(document.activeElement).toBe(control('graph-filter-search-project').element)
    await control('graph-filter-search-project').setValue('atl')
    expect(body().findAll('[role="checkbox"]').map(item => item.text())).toEqual(['Atlas'])
    await control('graph-filter-option-project-atlas').trigger('click')
    await control('graph-filter-search-project').setValue('no project')
    await control('graph-filter-option-project-__unassigned__').trigger('click')
    expect(wrapper.props('projectIds')).toEqual(['atlas', '__unassigned__'])
    expect(control('graph-clear-projectIds').text()).toBe('Project: Atlas, No project')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(body().find('[data-graph-column-filter]').exists()).toBe(false)
  })

  it('keeps filter and sort controls available with zero results', async () => {
    render({ nodes: [], kinds: ['note'], searchActive: true, sortBy: 'title' })
    expect(wrapper.findAll('thead th')).toHaveLength(5)
    expect(control('graph-clear-kinds').isVisible()).toBe(true)
    expect(wrapper.find('[data-graph-control="graph-empty-create"]').exists()).toBe(false)
    await control('graph-best-match').trigger('click')
    expect(wrapper.emitted('sort')).toEqual([[{ sortBy: 'relevance', direction: 'desc' }]])
    await control('graph-clear-filters').trigger('click')
    expect(wrapper.emitted('update:kinds')).toEqual([[[]]])
    expect(wrapper.emitted('update:projectIds')).toEqual([[[]]])
  })

  it('keeps keyboard selection through refresh and moves through the shown order', async () => {
    render()
    wrapper.vm.focusNode('note-a')
    await flushPromises()
    expect(document.activeElement.dataset.graphNode).toBe('note-a')
    await wrapper.setProps({ nodes: [nodes[2], nodes[1], nodes[0]] })
    expect(control('list-open-note-a').attributes('tabindex')).toBe('0')
    await control('list-open-note-a').trigger('keydown', { key: 'Home' })
    await flushPromises()
    expect(document.activeElement.dataset.graphNode).toBe('note-b')
    await control('list-open-note-b').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(document.activeElement.dataset.graphNode).toBe('note-a')
    await control('list-open-note-a').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(document.activeElement.dataset.graphNode).toBe('atlas')
  })

  it('retains the visible row position through background insertions and resets for an explicit filter', async () => {
    render({ contextKey: 'browse' })
    const scroller = wrapper.get('.graph-entries-scroll').element
    scroller.scrollTop = 34
    scroller.getBoundingClientRect = () => ({ top: 0 })
    const anchor = wrapper.get('[data-entry-row="note-a"]').element
    const atlas = wrapper.get('[data-entry-row="atlas"]').element
    atlas.getBoundingClientRect = () => ({ top: -5, bottom: 29 })
    anchor.getBoundingClientRect = () => ({ top: Array.from(anchor.parentElement.children).indexOf(anchor) * 34 - scroller.scrollTop + 29, bottom: 63 })
    await wrapper.setProps({ nodes: [{ id: 'new', kind: 'note', title: 'New' }, ...nodes] })
    await flushPromises()
    expect(scroller.scrollTop).toBe(68)
    await wrapper.setProps({ contextKey: 'filtered' })
    expect(scroller.scrollTop).toBe(0)
  })

  it('retains selection while a filter query is loading and loads more only on request', async () => {
    render({ canLoadMore: true })
    wrapper.vm.focusNode('note-a')
    await flushPromises()
    await wrapper.setProps({ nodes: [], loading: true })
    await wrapper.setProps({ nodes, loading: false })
    expect(control('list-open-note-a').attributes('tabindex')).toBe('0')
    await control('graph-load-more').trigger('click')
    expect(wrapper.emitted('loadMore')).toHaveLength(1)
    await wrapper.setProps({ loadingMore: true })
    expect(control('graph-load-more').attributes('disabled')).toBeDefined()
  })
})
