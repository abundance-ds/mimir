import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GraphDatePicker from './GraphDatePicker.vue'
import GraphSummaryDialog from './GraphSummaryDialog.vue'

describe('GraphSummaryDialog', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('selects an agent, a since date, and optional instructions', async () => {
    wrapper = mount(GraphSummaryDialog, {
      attachTo: document.body,
      props: {
        open: true,
        agents: [
          { id: 'codex-review', title: 'Codex', agentId: 'codex' },
          { id: 'claude-review', title: 'Claude', agentId: 'claude' },
        ],
      },
      global: {
        stubs: { Teleport: true },
      },
    })
    await nextTick()

    expect(wrapper.text()).toContain('Summarise changes')
    expect(wrapper.text()).not.toContain('Change review')
    expect(wrapper.text()).not.toContain('interactive agent Activity')

    await wrapper.get('[data-graph-control="summary-agent"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-graph-select-menu]').classes()).toContain('z-[260]')
    await wrapper.get('[data-graph-select-option="claude-review"]').trigger('click')

    wrapper.findComponent(GraphDatePicker).vm.$emit('update:modelValue', '2026-07-20')
    await nextTick()

    await wrapper.get('[data-graph-control="summary-instructions"]')
      .setValue('Focus on decisions and delivery risks.')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('launch')).toEqual([[
      {
        presetId: 'claude-review',
        since: '2026-07-20',
        instructions: 'Focus on decisions and delivery risks.',
      },
    ]])
  })
})
