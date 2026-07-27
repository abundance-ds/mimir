import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CrmView from './CrmView.vue'
import EntityList from './EntityList.vue'
import GraphMap from './GraphMap.vue'
import PortfolioView from './PortfolioView.vue'

describe('business graph projections', () => {
  it('opens map nodes with both Enter and Space keyboard actions', async () => {
    const wrapper = mount(GraphMap, {
      props: {
        nodes: [{
          id: 'project-atlas',
          kind: 'project',
          title: 'Atlas',
          relations: [],
        }],
      },
    })
    const node = wrapper.get('[data-map-node="project-atlas"]')
    await node.trigger('keydown', { key: 'Enter' })
    await node.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('open')).toEqual([
      ['project-atlas'],
      ['project-atlas'],
    ])
  })

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
    await listbox.trigger('keydown', { key: 'ArrowDown' })
    expect(listbox.attributes('aria-activedescendant')).toBe('graph-list-option-two')
    expect(wrapper.get('#graph-list-option-two').attributes('aria-selected')).toBe('true')
  })

  it('includes project-level has_contact edges in the CRM contact projection', () => {
    const wrapper = mount(CrmView, {
      props: {
        companies: [{ id: 'company-acme', title: 'Acme' }],
        people: [{ id: 'person-alex', title: 'Alex', relations: [] }],
        projects: [{
          id: 'project-atlas',
          title: 'Atlas',
          relations: [
            { relation: 'for_company', target: 'company-acme' },
            { relation: 'has_contact', target: 'person-alex' },
          ],
        }],
        issues: [],
      },
    })
    expect(wrapper.get('[data-company-card="company-acme"]').text()).toContain('Alex')
    expect(wrapper.get('[data-company-card="company-acme"]').text()).toContain('1people')
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
