import { DOMWrapper, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import TrackerCategorySelect from './TrackerCategorySelect.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TrackerCategorySelect', () => {
  it('uses a Mimir listbox and selects with the keyboard', async () => {
    const wrapper = mount(TrackerCategorySelect, {
      attachTo: document.body,
      props: {
        modelValue: 'Leisure',
        options: ['Work', 'Leisure', 'Other', 'UNKNOWN'],
        ariaLabel: 'Category for Safari',
      },
    })

    expect(wrapper.find('select').exists()).toBe(false)
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'ArrowDown' })

    const listbox = new DOMWrapper(document.querySelector('[role="listbox"]'))
    expect(listbox.exists()).toBe(true)
    expect(document.activeElement.dataset.trackerCategoryOption).toBe('Leisure')

    await listbox.trigger('keydown', { key: 'ArrowDown' })
    await listbox.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toEqual([['Other']])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('[role="combobox"]').element)
    wrapper.unmount()
  })

  it('closes on Escape without changing the category', async () => {
    const wrapper = mount(TrackerCategorySelect, {
      attachTo: document.body,
      props: {
        modelValue: 'Work',
        options: ['Work', 'Leisure'],
        ariaLabel: 'Category for Ghostty',
      },
    })

    await wrapper.get('[role="combobox"]').trigger('click')
    const listbox = new DOMWrapper(document.querySelector('[role="listbox"]'))
    await listbox.trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    wrapper.unmount()
  })

  it('hands Tab focus to the next field outside the teleported menu', async () => {
    const before = document.createElement('button')
    before.textContent = 'Before'
    document.body.append(before)
    const wrapper = mount(TrackerCategorySelect, {
      attachTo: document.body,
      props: {
        modelValue: 'Work',
        options: ['Work', 'Leisure'],
        ariaLabel: 'Category for Ghostty',
      },
    })
    const after = document.createElement('input')
    document.body.append(after)

    await wrapper.get('[role="combobox"]').trigger('click')
    await new DOMWrapper(document.querySelector('[role="listbox"]')).trigger('keydown', {
      key: 'Tab',
    })

    expect(document.activeElement).toBe(after)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    wrapper.unmount()
  })
})
