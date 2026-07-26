import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENTS_STARTER, CLAUDE_ALIAS } from '../../agentInstructions.js'
import AboutSection from './AboutSection.vue'

describe('About agent instruction starters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies starter content without writing project files', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mount(AboutSection)

    await wrapper.get('[data-copy-agents]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith(AGENTS_STARTER)
    expect(wrapper.get('[data-copy-agents]').text()).toContain('Copied AGENTS.md')

    await wrapper.get('[data-copy-claude]').trigger('click')
    expect(writeText).toHaveBeenLastCalledWith(CLAUDE_ALIAS)
    expect(CLAUDE_ALIAS).toBe('@AGENTS.md\n')
    expect(wrapper.get('[data-copy-claude]').text()).toContain('Copied CLAUDE.md')
  })
})
