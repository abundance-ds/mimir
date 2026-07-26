import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostWindow = window

describe('embedded App SDK', () => {
  let invoke

  beforeEach(() => {
    vi.resetModules()
    invoke = vi.fn()
    window.history.replaceState(
      {},
      '',
      '/ledger/index.html?instanceId=instance-7&workspacePath=%2Fwork',
    )
    window.__TAURI_INTERNALS__ = { invoke }
    delete window.mim
  })

  afterEach(() => {
    delete window.mim
    delete window.__TAURI_INTERNALS__
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: hostWindow,
    })
    window.history.replaceState({}, '', '/')
  })

  async function loadSdk() {
    await import('./mim-sdk.js')
    return window.mim
  }

  it('exposes immutable identity, data, file, and HTTP contracts', async () => {
    invoke.mockImplementation(async (command) => ({
      app_data_load: '{"rows":[1,2]}',
      read_text_file: { content: 'hello' },
      path_exists: true,
      app_http_request: {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      },
    })[command])
    const sdk = await loadSdk()

    expect(sdk.app).toEqual({
      id: 'ledger',
      instanceId: 'instance-7',
      workspacePath: '/work',
    })
    expect(Object.isFrozen(sdk)).toBe(true)
    await expect(sdk.data.load('state')).resolves.toEqual({ rows: [1, 2] })
    await sdk.data.save('state', { ready: true })
    await sdk.data.delete('state')
    await expect(sdk.fs.readText('/work/a.md')).resolves.toBe('hello')
    await expect(sdk.fs.exists('/work/a.md')).resolves.toBe(true)
    const response = await sdk.http.fetch('https://example.test/items', {
      method: 'POST',
      body: '{}',
      timeout: 500,
    })
    expect(response.ok).toBe(true)
    expect(response.json()).toEqual({ ok: true })

    expect(invoke).toHaveBeenCalledWith('app_data_save', {
      appId: 'ledger',
      key: 'state',
      value: '{"ready":true}',
    })
    expect(invoke).toHaveBeenCalledWith('app_http_request', {
      url: 'https://example.test/items',
      method: 'POST',
      headers: null,
      body: '{}',
      timeoutMs: 500,
    })
  })

  it('normalizes tool calls and preserves structured tool failures', async () => {
    invoke.mockImplementation(async (command) => {
      if (command === 'tool_registry_list') {
        return { tools: [{ name: 'files.read' }] }
      }
      if (command === 'tool_registry_call') {
        return {
          error: {
            code: 'denied',
            message: 'Tool denied',
            data: { retryable: false },
          },
        }
      }
      return null
    })
    const sdk = await loadSdk()

    await expect(sdk.tools.list()).resolves.toEqual([{ name: 'files.read' }])
    await expect(sdk.tools.call('files.read', { path: 'a.md' })).rejects.toMatchObject({
      message: 'Tool denied',
      code: 'denied',
      data: { retryable: false },
    })
    expect(invoke).toHaveBeenCalledWith('tool_registry_call', {
      request: {
        tool: 'files.read',
        input: { path: 'a.md' },
        caller: { kind: 'app', id: 'ledger' },
        requestId: null,
        cwd: '/work',
        metadata: { appInstanceId: 'instance-7' },
      },
    })
  })

  it('bridges embedded invokes, editor routing, and cancellable App tools', async () => {
    const parent = { postMessage: vi.fn() }
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: parent,
    })
    delete window.__TAURI_INTERNALS__
    const sdk = await loadSdk()

    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'mim:ready',
      appId: 'ledger',
    }, '*')

    const load = sdk.data.load('embedded')
    const invokeMessage = parent.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'mim:invoke')
    window.dispatchEvent(new MessageEvent('message', {
      source: parent,
      data: {
        type: 'mim:result',
        id: invokeMessage.id,
        result: '{"embedded":true}',
      },
    }))
    await expect(load).resolves.toEqual({ embedded: true })

    await sdk.workspace.openFile('/work/notes.md')
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'mim:open-file',
      path: '/work/notes.md',
    }, '*')

    let handlerSignal
    sdk.tools.handle('wait', (_input, context) => {
      handlerSignal = context.signal
      return new Promise(() => {})
    })
    window.dispatchEvent(new MessageEvent('message', {
      source: parent,
      data: {
        type: 'mim:tool-call',
        id: 'tool-1',
        tool: 'ledger.wait',
        input: { value: 1 },
        context: { activityId: 'agent:1' },
      },
    }))
    await Promise.resolve()
    expect(handlerSignal.aborted).toBe(false)
    window.dispatchEvent(new MessageEvent('message', {
      source: parent,
      data: { type: 'mim:tool-cancel', id: 'tool-1' },
    }))
    expect(handlerSignal.aborted).toBe(true)

    window.dispatchEvent(new MessageEvent('message', {
      source: parent,
      data: {
        type: 'mim:tool-call',
        id: 'tool-2',
        tool: 'ledger.missing',
        input: {},
      },
    }))
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'mim:tool-response',
      id: 'tool-2',
      result: null,
      error: {
        code: 'unavailable',
        message: "No handler is attached for 'ledger.missing'.",
      },
    }, '*')
  })
})
