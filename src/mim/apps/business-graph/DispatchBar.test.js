import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/businessGraph.js', () => ({
  graphContext: vi.fn(),
  searchGraph: vi.fn(),
}))

import { graphContext, searchGraph } from '../../../services/businessGraph.js'
import DispatchBar from './DispatchBar.vue'

const issue = {
  id: 'issue-1',
  kind: 'issue',
  title: 'Extract evidence',
  status: 'plan',
  projectId: 'project-alpha',
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('DispatchBar', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
    vi.resetAllMocks()
  })

  function render(props = {}) {
    wrapper = mount(DispatchBar, {
      attachTo: document.body,
      props: {
        scopeIds: ['project:alpha'],
        nodes: [issue],
        nodeCount: 12,
        echoes: [],
        ...props,
      },
    })
    return wrapper
  }

  it('looks up graph objects live and opens the highlighted result', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: issue }])
    render()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('extract')
    await wait(180)
    await flushPromises()

    expect(searchGraph).toHaveBeenCalledWith('extract', {
      scopeIds: ['project:alpha'],
      limit: 7,
    })
    const result = wrapper.get('[data-dispatch-result="issue-1"]')
    expect(result.text()).toContain('Extract evidence')
    expect(result.text()).toContain('plan')

    await input.trigger('keydown', { key: 'Tab' })
    await flushPromises()
    expect(wrapper.emitted('open-node')).toEqual([['issue-1']])
    expect(wrapper.emitted('dispatch')).toBeUndefined()
  })

  it('dispatches a plain line as a capture job and clears the input', async () => {
    render()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('jana owes us the comparator list by friday')
    await wait(180)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('dispatch')).toEqual([
      ['jana owes us the comparator list by friday'],
    ])
    expect(wrapper.get('[data-dispatch-input]').element.value).toBe('')
  })

  it('arms the context pack before launching delegated work', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: issue }])
    vi.mocked(graphContext).mockResolvedValue({
      graphRevision: 9,
      markdown: '# Business graph context\n\nIssue context.',
    })
    render()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('work extract')
    await wait(180)
    await flushPromises()

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(graphContext).toHaveBeenCalledWith({
      focusId: 'issue-1',
      scopeIds: ['project:alpha'],
      maxNodes: 16,
    })
    expect(wrapper.get('[data-dispatch-pack]').text()).toContain('Issue context.')
    expect(wrapper.text()).toContain('What the agent will see')
    expect(wrapper.emitted('delegate')).toBeUndefined()

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('delegate')).toEqual([[{ node: issue }]])
    expect(wrapper.get('[data-dispatch-input]').element.value).toBe('')
  })

  it('backs out of an armed pack with Escape instead of launching', async () => {
    vi.mocked(searchGraph).mockResolvedValue([{ node: issue }])
    vi.mocked(graphContext).mockResolvedValue({ graphRevision: 9, markdown: 'ctx' })
    render()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('!extract')
    await wait(180)
    await flushPromises()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.get('[data-dispatch-pack]').exists()).toBe(true)

    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[data-dispatch-pack]').exists()).toBe(false)
    expect(wrapper.emitted('delegate')).toBeUndefined()
  })

  it('routes leading-slash lines to the deterministic power lane', async () => {
    render()
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await input.setValue('/board waiting')
    await wait(180)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('power')).toEqual([['/board waiting']])
    expect(wrapper.emitted('dispatch')).toBeUndefined()
    expect(searchGraph).not.toHaveBeenCalled()
  })

  it('renders the scrollback with errors marked', async () => {
    render({
      echoes: [
        { id: 1, kind: 'job', text: '→ file the readout', at: '2026-07-27T08:00:00Z' },
        { id: 2, kind: 'error', text: '/bord: unknown command (try /help)', at: '2026-07-27T08:01:00Z' },
      ],
    })
    const input = wrapper.get('[data-dispatch-input]')
    await input.trigger('focus')
    await flushPromises()

    const scrollback = wrapper.get('.dispatch-scrollback')
    expect(scrollback.text()).toContain('→ file the readout')
    expect(scrollback.text()).toContain('/bord: unknown command (try /help)')
    expect(scrollback.get('.echo-error').text()).toContain('unknown command')
  })
})
