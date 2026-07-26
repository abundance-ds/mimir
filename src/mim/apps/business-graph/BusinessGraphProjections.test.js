import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CrmView from './CrmView.vue'
import EntityList from './EntityList.vue'
import GraphMap from './GraphMap.vue'

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
    expect(wrapper.attributes('role')).toBe('listbox')
    expect(wrapper.attributes('aria-activedescendant')).toBe('graph-list-option-one')
    await wrapper.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.attributes('aria-activedescendant')).toBe('graph-list-option-two')
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
})
