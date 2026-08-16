import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DatePicker from './DatePicker.vue'

describe('DatePicker', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('supports a custom trigger, bounded dates, and day states', async () => {
    wrapper = mount(DatePicker, {
      attachTo: document.body,
      props: {
        modelValue: '2026-08-15',
        ariaLabel: 'Choose Journal date',
        variant: 'custom',
        max: '2026-08-16',
        showFooter: false,
        dayState: date => date === '2026-08-14' ? 'entry' : 'empty',
        describeDay: (_date, state) => state === 'entry' ? 'has content' : 'no entry',
      },
      slots: {
        trigger: '<time>Sat 15 Aug</time>',
      },
    })

    await wrapper.get('button').trigger('click')
    const popover = document.querySelector('[data-date-picker-popover]')
    const entry = popover.querySelector('[data-date-value="2026-08-14"]')
    const future = popover.querySelector('[data-date-value="2026-08-17"]')

    expect(wrapper.get('time').text()).toBe('Sat 15 Aug')
    expect(entry.dataset.dayState).toBe('entry')
    expect(entry.getAttribute('aria-label')).toContain('has content')
    expect(future.disabled).toBe(true)
    expect(popover.querySelector('footer')).toBeNull()
    expect(popover.querySelector('[data-date-picker-control="next-month"]').disabled).toBe(true)

    entry.click()
    expect(wrapper.emitted('change')).toEqual([['2026-08-14']])
  })
})
