import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import {
  invokeAppCommand,
  listenForAppTools,
  reconcileAppTools,
  respondToAppTool,
  unregisterAppTools,
} from '../../services/appsCatalog.js'
import EmbeddedAppHost from './EmbeddedAppHost.vue'

vi.mock('../../services/appsCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeAppCommand: vi.fn(),
  listenForAppTools: vi.fn(),
  reconcileAppTools: vi.fn(),
  rejectAppTool: vi.fn(),
  respondToAppTool: vi.fn(),
  unregisterAppTools: vi.fn(),
}))

const app = {
  id: 'ledger',
  title: 'Ledger',
  entry: 'index.html',
  tools: [{
    name: 'total',
    description: 'Read the total.',
    inputSchema: { type: 'object', properties: {} },
  }],
}
const launch = {
  mode: 'embedded',
  appId: 'ledger',
  url: 'about:blank',
}

describe('EmbeddedAppHost', () => {
  let relay
  let unlisten

  beforeEach(() => {
    relay = null
    unlisten = vi.fn()
    vi.mocked(invokeAppCommand).mockReset().mockResolvedValue({ ok: true })
    vi.mocked(reconcileAppTools).mockReset().mockResolvedValue({ revision: 3 })
    vi.mocked(respondToAppTool).mockReset().mockResolvedValue(true)
    vi.mocked(unregisterAppTools).mockReset().mockResolvedValue(4)
    vi.mocked(listenForAppTools).mockReset().mockImplementation(async (options) => {
      relay = options
      return unlisten
    })
  })

  function render() {
    return mount(EmbeddedAppHost, {
      attachTo: document.body,
      props: {
        app,
        launch,
        workspacePath: '/work',
        instanceId: 'app:ledger',
        active: true,
      },
    })
  }

  it('hosts the resolved entry with Activity context and registers tools', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('iframe').attributes('src')).toContain('about:blank')
    expect(wrapper.get('iframe').attributes('src')).toContain('workspacePath=%2Fwork')
    expect(reconcileAppTools).toHaveBeenCalledWith({
      appId: 'ledger',
      instanceId: 'app:ledger',
      tools: app.tools,
    })

    wrapper.unmount()
  })

  it('forwards registry calls into the hosted frame and relays its response', async () => {
    const wrapper = render()
    await flushPromises()
    const frame = wrapper.get('iframe').element
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage')
    await wrapper.get('iframe').trigger('load')

    relay.onCall({ id: 'call-1', tool: 'app.ledger.total', input: {}, context: {} })
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mim:tool-call',
      id: 'call-1',
      tool: 'app.ledger.total',
    }), '*')

    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: {
        type: 'mim:tool-response',
        id: 'call-1',
        result: { value: 42, displayText: '42' },
      },
    }))
    await flushPromises()

    expect(respondToAppTool).toHaveBeenCalledWith('call-1', {
      value: 42,
      displayText: '42',
      metadata: {},
    })
    wrapper.unmount()
  })

  it('bridges SDK invokes and returns results only to its own frame', async () => {
    const wrapper = render()
    await flushPromises()
    const frame = wrapper.get('iframe').element
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage')

    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: {
        type: 'mim:invoke',
        id: 'sdk-1',
        command: 'app_data_load',
        args: { key: 'state' },
      },
    }))
    await flushPromises()

    expect(invokeAppCommand).toHaveBeenCalledWith('ledger', 'app_data_load', { key: 'state' })
    expect(postMessage).toHaveBeenCalledWith({
      type: 'mim:result',
      id: 'sdk-1',
      result: { ok: true },
      error: null,
    }, '*')
    wrapper.unmount()
  })

  it('cleans up its exact provider instance on unmount', async () => {
    const wrapper = render()
    await flushPromises()
    wrapper.unmount()
    await flushPromises()

    expect(unlisten).toHaveBeenCalled()
    expect(unregisterAppTools).toHaveBeenCalledWith('ledger', 'app:ledger')
  })

  it('reconciles changed manifest tools and reloads the mounted frame without duplicate listeners', async () => {
    const wrapper = render()
    await flushPromises()
    const firstFrame = wrapper.get('iframe').element
    const updatedTools = [{
      name: 'forecast',
      description: 'Forecast the total.',
      inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    }]

    await wrapper.setProps({
      app: { ...app, tools: updatedTools },
      launch: { ...launch, url: 'about:blank?revision=2' },
    })
    await flushPromises()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(unregisterAppTools).toHaveBeenCalledWith('ledger', 'app:ledger')
    expect(listenForAppTools).toHaveBeenCalledTimes(2)
    expect(reconcileAppTools).toHaveBeenLastCalledWith({
      appId: 'ledger',
      instanceId: 'app:ledger',
      tools: updatedTools,
    })
    expect(wrapper.get('iframe').element).not.toBe(firstFrame)
    expect(wrapper.get('iframe').attributes('src')).toContain('revision=2')
    wrapper.unmount()
  })
})
