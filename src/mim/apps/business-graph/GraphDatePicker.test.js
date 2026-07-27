import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GraphDatePicker from './GraphDatePicker.vue'

describe('GraphDatePicker', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('uses a custom calendar and emits an ISO local date', async () => {
    wrapper = mount(GraphDatePicker, {
      attachTo: document.body,
      props: {
        modelValue: '',
        ariaLabel: 'Issue due date',
      },
    })

    await wrapper.get('button').trigger('click')
    const popover = document.querySelector('[data-graph-date-popover]')
    expect(popover).not.toBeNull()
    expect(popover.querySelector('input, select, datalist')).toBeNull()

    popover.querySelector('[data-graph-control="date-today"]').click()
    const date = new Date()
    const expected = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
    expect(wrapper.emitted('update:modelValue')).toEqual([[expected]])
  })

  it('supports calendar keyboard navigation without a native date input', async () => {
    wrapper = mount(GraphDatePicker, {
      attachTo: document.body,
      props: {
        modelValue: '2026-07-26',
        ariaLabel: 'Issue due date',
      },
    })

    await wrapper.get('button').trigger('click')
    const selected = document.querySelector('[data-date-value="2026-07-26"]')
    await selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement.getAttribute('data-date-value')).toBe('2026-07-01')

    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    await Promise.resolve()
    expect(document.activeElement.getAttribute('data-date-value')).toBe('2026-08-01')
    expect(document.querySelector('input[type="date"]')).toBeNull()
  })
})
