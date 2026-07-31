import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TrackerTimeline from './TrackerTimeline.vue'

describe('TrackerTimeline', () => {
  it('clips raw intervals to the ruler and preserves exact proportional geometry', () => {
    const wrapper = mount(TrackerTimeline, {
      props: {
        startMs: 1_000,
        endMs: 11_000,
        nowMs: 6_000,
        blocks: [
          {
            id: 1,
            startMs: -4_000,
            endMs: 3_000,
            durationSeconds: 7,
            activity: 'Work',
            appName: 'Mimir',
          },
          {
            id: 2,
            startMs: 8_000,
            endMs: 15_000,
            durationSeconds: 7,
            activity: 'Leisure',
            domain: 'example.com',
          },
        ],
      },
    })

    const segments = wrapper.findAll('.timeline-fill')
    expect(segments).toHaveLength(2)
    expect(segments[0].attributes('x')).toBe('0%')
    expect(segments[0].attributes('width')).toBe('20%')
    expect(segments[1].attributes('x')).toBe('70%')
    expect(segments[1].attributes('width')).toBe('30%')
    expect(wrapper.find('.timeline-now').attributes('x1')).toBe('50%')
    expect(wrapper.find('svg').attributes('viewBox')).toBeUndefined()
    expect(wrapper.text()).toContain('Work')
    expect(wrapper.text()).toContain('Leisure')
  })
})
