import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import EntityList from './EntityList.vue'
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
})
