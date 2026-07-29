import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import EntityList from './EntityList.vue'
import NowView from './NowView.vue'
import PortfolioView from './PortfolioView.vue'

describe('business graph projections', () => {
  it('exposes list selection through the listbox accessibility contract', async () => {
    const wrapper = mount(EntityList, {
      props: {
        nodes: [
          { id: 'one', kind: 'note', title: 'One', scopeId: 'project:test' },
          { id: 'two', kind: 'note', title: 'Two', scopeId: 'project:test' },
        ],
        scopes: [{ id: 'project:test', kind: 'project' }],
      },
    })
    const listbox = wrapper.get('[data-graph-entity-list]')
    expect(listbox.attributes('role')).toBe('listbox')
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-one')
    expect(wrapper.findAll('.entity-kind').map(label => label.text())).toEqual(['note', 'note'])
    expect(wrapper.get('#graph-list-option-one .entity-line-1').element.firstElementChild)
      .toBe(wrapper.get('#graph-list-option-one .entity-kind').element)
    const secondRow = wrapper.get('#graph-list-option-two')
    secondRow.element.scrollIntoView = vi.fn()
    await listbox.trigger('keydown', { key: 'ArrowDown' })
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-two')
    expect(secondRow.attributes('aria-selected')).toBe('true')
    expect(secondRow.element.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })

    await listbox.trigger('keydown', { key: 'ArrowDown' })
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-two')
    await listbox.trigger('keydown', { key: 'ArrowUp' })
    await listbox.trigger('keydown', { key: 'ArrowUp' })
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-one')
  })

  it('preserves selection by node ID without hijacking scroll when results change', async () => {
    const one = { id: 'one', kind: 'note', title: 'One' }
    const two = { id: 'two', kind: 'note', title: 'Two' }
    const three = { id: 'three', kind: 'note', title: 'Three' }
    const wrapper = mount(EntityList, {
      attachTo: document.body,
      props: { nodes: [one, two] },
    })
    const listbox = wrapper.get('[data-graph-entity-list]')
    const secondRow = wrapper.get('#graph-list-option-two')
    secondRow.element.scrollIntoView = vi.fn()

    await listbox.trigger('keydown', { key: 'ArrowDown' })
    expect(secondRow.element.scrollIntoView).toHaveBeenCalledOnce()
    secondRow.element.scrollIntoView.mockClear()

    await wrapper.setProps({ nodes: [two, one, three] })
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-two')
    expect(wrapper.get('#graph-list-option-two').attributes('aria-selected')).toBe('true')
    expect(secondRow.element.scrollIntoView).not.toHaveBeenCalled()

    expect(listbox.attributes('tabindex')).toBe('0')
    expect(wrapper.findAll('[role="option"]').every(row => row.attributes('tabindex') === '-1'))
      .toBe(true)
    await wrapper.get('#graph-list-option-one').trigger('mousedown')
    expect(document.activeElement).toBe(listbox.element)
    wrapper.unmount()
  })

  it('summarizes evidence and decisions on the project dashboard', () => {
    const project = {
      id: 'project-atlas',
      kind: 'project',
      title: 'Atlas',
      relations: [],
      scopeId: 'project:test',
    }
    const wrapper = mount(PortfolioView, {
      props: {
        projects: [project],
        issues: [],
        scopes: [{ id: 'project:test', kind: 'project' }],
        nodes: [
          project,
          {
            id: 'study-1',
            kind: 'study',
            title: 'Pivotal study',
            relations: [{ relation: 'related_to', target: 'project-atlas' }],
          },
          {
            id: 'decision-1',
            kind: 'decision',
            title: 'Use matched cohort',
            relations: [{ relation: 'part_of', target: 'project-atlas' }],
          },
        ],
      },
    })

    expect(wrapper.get('[data-project-card="project-atlas"]').text()).toContain('1 evidence')
    expect(wrapper.get('[data-project-card="project-atlas"]').text()).toContain('1 decision')
  })

  it('expands change snippets in place and pages through history', async () => {
    const event = {
      id: 'event-1',
      timestamp: '2026-07-29T08:40:00.000Z',
      nodeId: 'issue-1',
      nodeKind: 'issue',
      title: 'Extract evidence',
      summary: 'Changed status · Extract evidence',
      action: 'graph.update',
      eventType: 'status-changed',
      graphRevision: 8,
      actor: { id: 'local-human', label: 'You', initials: 'ME' },
      changes: [{ field: 'status', before: 'plan', after: 'in-progress' }],
      data: {},
    }
    const wrapper = mount(NowView, {
      props: {
        events: [event],
        total: 80,
        offset: 0,
        limit: 50,
        canSummarise: true,
      },
    })

    expect(wrapper.get('.now-event-type').text()).toBe('Status')
    expect(wrapper.get('.now-event-change').text()).toBe('Plan → In Progress')
    expect(wrapper.get('.now-event-actor').text()).toBe('You')
    expect(wrapper.text()).not.toContain('ME')

    await wrapper.get('[data-graph-event="event-1"]').trigger('click')
    expect(wrapper.get('.now-event-detail').text()).toContain('plan')
    expect(wrapper.get('.now-event-detail').text()).toContain('in-progress')
    expect(wrapper.emitted('open')).toBeUndefined()

    await wrapper.get('[data-now-event-open="issue-1"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['issue-1']])

    expect(wrapper.get('.now-pagination').text()).toContain('1–1 of 80')
    await wrapper.get('[data-now-page-next]').trigger('click')
    expect(wrapper.emitted('page')).toEqual([[50]])

    await wrapper.get('[data-graph-control="changes-summarise"]').trigger('click')
    expect(wrapper.emitted('summarise')).toEqual([[]])
  })
})
