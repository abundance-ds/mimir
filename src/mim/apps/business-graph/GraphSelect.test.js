import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GraphSelect from './GraphSelect.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GraphSelect', () => {
  it('renders a custom listbox and selects with keyboard navigation', async () => {
    const wrapper = mount(GraphSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'plan',
        ariaLabel: 'Issue status',
        options: [
          { value: 'backlog', label: 'Backlog' },
          { value: 'plan', label: 'Plan' },
          { value: 'in-progress', label: 'In progress' },
        ],
      },
    })

    expect(wrapper.find('select').exists()).toBe(false)
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'ArrowDown' })

    const menu = new DOMWrapper(document.querySelector('[role="listbox"]'))
    expect(menu.exists()).toBe(true)
    expect(document.activeElement.dataset.graphSelectOption).toBe('plan')
    await menu.trigger('keydown', { key: 'ArrowDown' })
    await menu.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toEqual([['in-progress']])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('[role="combobox"]').element)
    wrapper.unmount()
  })

  it('filters long entity menus without native datalist UI', async () => {
    const wrapper = mount(GraphSelect, {
      attachTo: document.body,
      props: {
        modelValue: '',
        ariaLabel: 'Issue project',
        searchable: true,
        options: [
          { value: '', label: 'No project' },
          { value: 'atlas', label: 'Project Atlas', hint: 'team · atlas' },
          { value: 'horizon', label: 'Horizon study', hint: 'project · horizon' },
        ],
      },
    })

    await wrapper.get('[role="combobox"]').trigger('click')
    const search = new DOMWrapper(document.querySelector('[data-graph-select-search]'))
    await search.setValue('atlas')

    const options = [...document.querySelectorAll('[data-graph-select-option]')]
    expect(options).toHaveLength(1)
    expect(options[0].dataset.graphSelectOption).toBe('atlas')
    expect(document.querySelector('datalist')).toBeNull()
    wrapper.unmount()
  })
})
