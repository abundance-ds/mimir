import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import {
  listenForAppTools,
  loadAppData,
  reconcileAppTools,
  respondToAppTool,
  saveAppData,
  unregisterAppTools,
} from '../../services/appsCatalog.js'
import TodayApp from './TodayApp.vue'

vi.mock('../../services/appsCatalog.js', () => ({
  listenForAppTools: vi.fn(),
  loadAppData: vi.fn(),
  reconcileAppTools: vi.fn(),
  rejectAppTool: vi.fn(),
  respondToAppTool: vi.fn(),
  saveAppData: vi.fn(),
  unregisterAppTools: vi.fn(),
}))

const app = {
  id: 'scratch',
  title: 'Today',
  tools: [{
    name: 'read',
    description: 'Read the current top priority.',
    inputSchema: { type: 'object', properties: {} },
    mcpAlias: 'scratch_read',
  }],
}

describe('TodayApp', () => {
  let relay
  let unlisten

  beforeEach(() => {
    vi.useFakeTimers()
    relay = null
    unlisten = vi.fn()
    vi.mocked(loadAppData).mockReset().mockResolvedValue(JSON.stringify({
      version: 1,
      text: 'Ship the focused review flow',
      updatedAt: '2026-07-25T10:00:00.000Z',
    }))
    vi.mocked(saveAppData).mockReset().mockResolvedValue()
    vi.mocked(reconcileAppTools).mockReset().mockResolvedValue({ revision: 4 })
    vi.mocked(respondToAppTool).mockReset().mockResolvedValue(true)
    vi.mocked(unregisterAppTools).mockReset().mockResolvedValue(5)
    vi.mocked(listenForAppTools).mockReset().mockImplementation(async (options) => {
      relay = options
      return unlisten
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function render() {
    return mount(TodayApp, {
      props: {
        app,
        active: true,
        instanceId: 'app:scratch',
      },
    })
  }

  it('restores the previous scratch text and installs its reader after the listener', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('textarea').element.value).toBe('Ship the focused review flow')
    expect(reconcileAppTools).toHaveBeenCalledWith({
      appId: 'scratch',
      instanceId: 'app:scratch',
      tools: app.tools,
    })
    expect(listenForAppTools.mock.invocationCallOrder[0])
      .toBeLessThan(reconcileAppTools.mock.invocationCallOrder[0])
  })

  it('debounces durable autosave and keeps the save state honest', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('textarea').setValue('Finish the priority card')
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Unsaved')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(1)
    const [appId, key, raw] = saveAppData.mock.calls[0]
    expect([appId, key]).toEqual(['scratch', 'scratch'])
    expect(JSON.parse(raw)).toMatchObject({ version: 1, text: 'Finish the priority card' })
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Saved')
  })

  it('serves the live priority through the retained scratch reader', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('textarea').setValue('Tool-visible priority')

    await relay.onCall({
      id: 'call-9',
      tool: 'app.scratch.read',
      input: {},
    })

    expect(respondToAppTool).toHaveBeenCalledWith('call-9', {
      value: expect.objectContaining({
        text: 'Tool-visible priority',
        characters: 21,
        lines: 1,
      }),
      displayText: 'Tool-visible priority',
    })
  })

  it('keeps a failed save recoverable without losing the draft', async () => {
    vi.mocked(saveAppData)
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValueOnce()
    const wrapper = render()
    await flushPromises()

    await wrapper.get('textarea').setValue('Keep this exact draft')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(wrapper.get('[data-today-error]').text()).toContain('disk busy')
    expect(wrapper.get('textarea').element.value).toBe('Keep this exact draft')

    await wrapper.get('[data-today-error] button').trigger('click')
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-today-error]').exists()).toBe(false)
    expect(wrapper.get('[data-today-save-state]').text()).toContain('Saved')
  })

  it('retires its reader when the Activity leaves the host', async () => {
    const wrapper = render()
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(unregisterAppTools).toHaveBeenCalledWith('scratch', 'app:scratch')
  })
})
