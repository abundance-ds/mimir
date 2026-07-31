import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TrackerClassifications from './TrackerClassifications.vue'

describe('TrackerClassifications', () => {
  it('presents a queued unknown application as an editable pending rule', () => {
    const wrapper = mount(TrackerClassifications, {
      props: {
        saveRule: vi.fn(),
        rules: [{
          key: 'com.mitchellh.ghostty',
          activity: 'UNKNOWN',
          subcategory: null,
          classifiedBy: 'pending',
          manual: false,
        }],
      },
    })

    const row = wrapper.get('[data-tracker-classification="com.mitchellh.ghostty"]')
    expect(row.text()).toContain('pending')
    expect(row.find('select').exists()).toBe(false)
    expect(row.get('[data-tracker-category-trigger]').text()).toContain('UNKNOWN')
    wrapper.unmount()
  })

  it('saves a manual correction and explicitly applies it to history', async () => {
    const saveRule = vi.fn().mockResolvedValue({})
    const wrapper = mount(TrackerClassifications, {
      attachTo: document.body,
      props: {
        saveRule,
        rules: [{
          key: 'Safari | example.com',
          activity: 'Leisure',
          subcategory: 'Browsing',
          classifiedBy: 'ai:model',
          manual: false,
        }],
      },
    })
    const row = wrapper.get('[data-tracker-classification="Safari | example.com"]')
    await row.get('[data-tracker-category-trigger]').trigger('click')
    await new DOMWrapper(
      document.querySelector('[data-tracker-category-option="Work"]'),
    ).trigger('click')
    await row.get('input').setValue('Research')
    await row.get('[data-tracker-classification-save]').trigger('click')
    await flushPromises()

    expect(saveRule).toHaveBeenCalledWith({
      key: 'Safari | example.com',
      activity: 'Work',
      subcategory: 'Research',
      applyHistory: true,
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    wrapper.unmount()
  })
})
