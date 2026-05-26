import { describe, it, expect } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import ContextDonut from './ContextDonut.vue'

function factory(props = {}) {
  return shallowMount(ContextDonut, { props })
}

describe('ContextDonut', () => {
  it('renders without error with default props', () => {
    const wrapper = factory()
    expect(wrapper.exists()).toBe(true)
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('shows no fill arc when percent is 0', () => {
    const wrapper = factory({ percent: 0, size: 16 })
    const circles = wrapper.findAll('circle')
    // Only the track circle, no fill circle
    expect(circles).toHaveLength(1)
  })

  it('shows fill arc when percent > 0', () => {
    const wrapper = factory({ percent: 0.5, size: 16 })
    const circles = wrapper.findAll('circle')
    // Track circle + fill circle
    expect(circles).toHaveLength(2)
  })

  it('tooltip text includes token count and percentage', () => {
    const wrapper = factory({
      percent: 0.25,
      tokenCount: 50000,
      contextWindow: 200000,
    })
    const tooltip = wrapper.find('.donut-tooltip')
    expect(tooltip.text()).toContain('50k')
    expect(tooltip.text()).toContain('200k')
    expect(tooltip.text()).toContain('25%')
  })

  it('tooltip includes cost label when provided', () => {
    const wrapper = factory({
      percent: 0.1,
      tokenCount: 1000,
      contextWindow: 10000,
      costLabel: '$0.05',
    })
    const tooltip = wrapper.find('.donut-tooltip')
    expect(tooltip.text()).toContain('$0.05')
  })

  it('does not show cost in tooltip when costLabel is empty', () => {
    const wrapper = factory({
      percent: 0.1,
      tokenCount: 1000,
      contextWindow: 10000,
      costLabel: '',
    })
    const tooltipDivs = wrapper.findAll('.donut-tooltip div')
    // Only the context line div, no cost div
    expect(tooltipDivs).toHaveLength(1)
  })

  it('fill color is ink-4 when percent < 0.6', () => {
    const wrapper = factory({ percent: 0.3, size: 16 })
    const fillCircle = wrapper.findAll('circle')[1]
    expect(fillCircle.attributes('stroke')).toBe('var(--color-ink-4)')
  })

  it('fill color is accent when percent >= 0.6 and < 0.85', () => {
    const wrapper = factory({ percent: 0.7, size: 16 })
    const fillCircle = wrapper.findAll('circle')[1]
    expect(fillCircle.attributes('stroke')).toBe('var(--color-accent)')
  })

  it('fill color is rem when percent >= 0.85', () => {
    const wrapper = factory({ percent: 0.9, size: 16 })
    const fillCircle = wrapper.findAll('circle')[1]
    expect(fillCircle.attributes('stroke')).toBe('var(--color-rem)')
  })

  it('formats million-scale token counts', () => {
    const wrapper = factory({
      percent: 0.5,
      tokenCount: 1_500_000,
      contextWindow: 3_000_000,
    })
    const tooltip = wrapper.find('.donut-tooltip')
    expect(tooltip.text()).toContain('1.5M')
    expect(tooltip.text()).toContain('3.0M')
  })
})
