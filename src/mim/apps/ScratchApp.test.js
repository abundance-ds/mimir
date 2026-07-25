import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import {
  listenForAppTools,
  loadAppData,
  reconcileAppTools,
  rejectAppTool,
  respondToAppTool,
  saveAppData,
  unregisterAppTools,
} from '../../services/appsCatalog.js'
import ScratchApp from './ScratchApp.vue'

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
  title: 'Scratch',
  tools: [{
    name: 'read',
    description: 'Read Scratch.',
    inputSchema: { type: 'object', properties: {} },
    mcpAlias: 'scratch_read',
  }],
}

describe('ScratchApp', () => {
  let relay
  let unlisten

  beforeEach(() => {
    vi.useFakeTimers()
    relay = null
    unlisten = vi.fn()
    vi.mocked(loadAppData).mockReset().mockResolvedValue(JSON.stringify({
      version: 1,
      text: 'First thought',
      updatedAt: '2026-07-25T10:00:00.000Z',
    }))
    vi.mocked(saveAppData).mockReset().mockResolvedValue()
    vi.mocked(reconcileAppTools).mockReset().mockResolvedValue({ revision: 4 })
    vi.mocked(rejectAppTool).mockReset().mockResolvedValue(true)
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
    return mount(ScratchApp, {
      props: {
        app,
        active: true,
        instanceId: 'app:scratch',
      },
    })
  }

  it('restores durable text and registers the manifest tool after installing listeners', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('textarea').element.value).toBe('First thought')
    expect(listenForAppTools).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'scratch',
      instanceId: 'app:scratch',
    }))
    expect(reconcileAppTools).toHaveBeenCalledWith({
      appId: 'scratch',
      instanceId: 'app:scratch',
      tools: app.tools,
    })
    expect(listenForAppTools.mock.invocationCallOrder[0])
      .toBeLessThan(reconcileAppTools.mock.invocationCallOrder[0])
    expect(wrapper.get('[data-scratch-tool]').text()).toContain('app.scratch.read')
  })

  it('debounces atomic persistence and exposes honest save state', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('textarea').setValue('A sharper thought')
    expect(wrapper.get('[data-scratch-save-state]').text()).toContain('Unsaved')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()

    expect(saveAppData).toHaveBeenCalledTimes(1)
    const [appId, key, raw] = saveAppData.mock.calls[0]
    expect([appId, key]).toEqual(['scratch', 'scratch'])
    expect(JSON.parse(raw)).toMatchObject({ version: 1, text: 'A sharper thought' })
    expect(wrapper.get('[data-scratch-save-state]').text()).toContain('Saved')
  })

  it('serves live scratch text through app.scratch.read', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('textarea').setValue('Tool-visible text')

    await relay.onCall({
      id: 'call-9',
      tool: 'app.scratch.read',
      input: {},
    })

    expect(respondToAppTool).toHaveBeenCalledWith('call-9', {
      value: expect.objectContaining({
        text: 'Tool-visible text',
        characters: 17,
        lines: 1,
      }),
      displayText: 'Tool-visible text',
    })
  })

  it('unregisters its provider and listeners when the Activity leaves the host', async () => {
    const wrapper = render()
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(unregisterAppTools).toHaveBeenCalledWith('scratch', 'app:scratch')
  })
})
