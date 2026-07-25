import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { createAppBridge } from './bridge.js'
import { invoke } from '@tauri-apps/api/core'

function makeMockIframe() {
  return {
    contentWindow: { postMessage: vi.fn() },
  }
}

function makeMessageEvent(source, data) {
  return { source, data }
}

describe('createAppBridge', () => {
  let iframe
  let bridge
  let listener

  beforeEach(() => {
    vi.resetAllMocks()
    iframe = makeMockIframe()
    bridge = createAppBridge(iframe, { appId: 'my-app', projectId: 'proj-1' })

    // Capture the listener that gets added to window
    vi.spyOn(window, 'addEventListener')
    vi.spyOn(window, 'removeEventListener')
  })

  describe('structure', () => {
    it('returns object with start and stop', () => {
      expect(bridge).toHaveProperty('start')
      expect(bridge).toHaveProperty('stop')
      expect(typeof bridge.start).toBe('function')
      expect(typeof bridge.stop).toBe('function')
    })
  })

  describe('start()', () => {
    it('adds a message event listener to window', () => {
      bridge.start()
      expect(window.addEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })
  })

  describe('stop()', () => {
    it('removes the message event listener', () => {
      bridge.start()
      bridge.stop()
      expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('is safe to call without start', () => {
      expect(() => bridge.stop()).not.toThrow()
    })

    it('does not call removeEventListener if not started', () => {
      bridge.stop()
      expect(window.removeEventListener).not.toHaveBeenCalled()
    })
  })

  describe('message handling', () => {
    // Helper: start bridge and extract the captured listener
    function startAndGetListener() {
      bridge.start()
      return window.addEventListener.mock.calls.find(
        (c) => c[0] === 'message'
      )[1]
    }

    it('ignores messages from wrong source', async () => {
      const handler = startAndGetListener()
      const event = makeMessageEvent({ not: 'the iframe' }, {
        type: 'mim:invoke',
        id: '1',
        command: 'app_data_load',
        args: {},
      })
      await handler(event)
      expect(invoke).not.toHaveBeenCalled()
      expect(iframe.contentWindow.postMessage).not.toHaveBeenCalled()
    })

    it('ignores messages with wrong type', async () => {
      const handler = startAndGetListener()
      const event = makeMessageEvent(iframe.contentWindow, {
        type: 'something:else',
        id: '1',
        command: 'app_data_load',
        args: {},
      })
      await handler(event)
      expect(invoke).not.toHaveBeenCalled()
    })

    it('rejects non-whitelisted commands with error postMessage', async () => {
      const handler = startAndGetListener()
      const event = makeMessageEvent(iframe.contentWindow, {
        type: 'mim:invoke',
        id: 'req-1',
        command: 'dangerous_command',
        args: {},
      })
      await handler(event)

      expect(invoke).not.toHaveBeenCalled()
      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          type: 'mim:result',
          id: 'req-1',
          error: 'Command not allowed: dangerous_command',
        },
        '*',
      )
    })

    it('invokes allowed command and posts result back', async () => {
      invoke.mockResolvedValue('loaded-data')
      const handler = startAndGetListener()
      const event = makeMessageEvent(iframe.contentWindow, {
        type: 'mim:invoke',
        id: 'req-2',
        command: 'read_text_file',
        args: { path: '/some/file' },
      })
      await handler(event)

      expect(invoke).toHaveBeenCalledWith('read_text_file', { path: '/some/file' })
      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          type: 'mim:result',
          id: 'req-2',
          result: 'loaded-data',
        },
        '*',
      )
    })

    it('posts error back when invoke fails', async () => {
      invoke.mockRejectedValue(new Error('disk full'))
      const handler = startAndGetListener()
      const event = makeMessageEvent(iframe.contentWindow, {
        type: 'mim:invoke',
        id: 'req-3',
        command: 'write_text_file',
        args: { path: '/some/file', content: 'data' },
      })
      await handler(event)

      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          type: 'mim:result',
          id: 'req-3',
          error: 'disk full',
        },
        '*',
      )
    })

    describe('appId/projectId injection', () => {
      it('injects appId and projectId for app_data_load', async () => {
        invoke.mockResolvedValue('data')
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-4',
          command: 'app_data_load',
          args: { key: 'settings', appId: 'forged-id' },
        })
        await handler(event)

        // Should override any forged appId/projectId
        expect(invoke).toHaveBeenCalledWith('app_data_load', {
          key: 'settings',
          appId: 'my-app',
          projectId: 'proj-1',
        })
      })

      it('injects appId and projectId for app_data_save', async () => {
        invoke.mockResolvedValue(undefined)
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-5',
          command: 'app_data_save',
          args: { key: 'k', value: 'v' },
        })
        await handler(event)

        expect(invoke).toHaveBeenCalledWith('app_data_save', {
          key: 'k',
          value: 'v',
          appId: 'my-app',
          projectId: 'proj-1',
        })
      })

      it('injects appId and projectId for app_data_delete', async () => {
        invoke.mockResolvedValue(undefined)
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-6',
          command: 'app_data_delete',
          args: { key: 'k' },
        })
        await handler(event)

        expect(invoke).toHaveBeenCalledWith('app_data_delete', {
          key: 'k',
          appId: 'my-app',
          projectId: 'proj-1',
        })
      })

      it('injects appId and projectId for app_data_keys', async () => {
        invoke.mockResolvedValue([])
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-7',
          command: 'app_data_keys',
          args: {},
        })
        await handler(event)

        expect(invoke).toHaveBeenCalledWith('app_data_keys', {
          appId: 'my-app',
          projectId: 'proj-1',
        })
      })

      it('does NOT inject appId/projectId for non-data commands', async () => {
        invoke.mockResolvedValue('content')
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-8',
          command: 'read_text_file',
          args: { path: '/some/file' },
        })
        await handler(event)

        expect(invoke).toHaveBeenCalledWith('read_text_file', { path: '/some/file' })
        const invokedArgs = invoke.mock.calls[0][1]
        expect(invokedArgs).not.toHaveProperty('appId')
        expect(invokedArgs).not.toHaveProperty('projectId')
      })

      it('does NOT inject for path_exists command', async () => {
        invoke.mockResolvedValue(true)
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-9',
          command: 'path_exists',
          args: { path: '/check' },
        })
        await handler(event)

        const invokedArgs = invoke.mock.calls[0][1]
        expect(invokedArgs).not.toHaveProperty('appId')
        expect(invokedArgs).not.toHaveProperty('projectId')
      })
    })

    describe('app_http_request', () => {
      it('is accepted (not rejected as disallowed)', async () => {
        invoke.mockResolvedValue({ status: 200, headers: {}, body: '' })
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'http-1',
          command: 'app_http_request',
          args: { url: 'https://example.com' },
        })
        await handler(event)

        expect(invoke).toHaveBeenCalled()
        const posted = iframe.contentWindow.postMessage.mock.calls[0][0]
        expect(posted.type).toBe('mim:result')
        expect(posted).not.toHaveProperty('error')
        expect(posted).toHaveProperty('result')
      })

      it('gets appId and projectId injected into args', async () => {
        invoke.mockResolvedValue({ status: 200, headers: {}, body: '' })
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'http-2',
          command: 'app_http_request',
          args: { url: 'https://example.com', method: 'GET', appId: 'forged-id' },
        })
        await handler(event)

        expect(invoke).toHaveBeenCalledWith('app_http_request', {
          url: 'https://example.com',
          method: 'GET',
          appId: 'my-app',
          projectId: 'proj-1',
        })
      })
    })

    describe('allowed commands whitelist', () => {
      const allowedCommands = [
        'app_data_load', 'app_data_save', 'app_data_delete', 'app_data_keys',
        'app_http_request',
        'read_text_file', 'write_text_file', 'path_exists',
        'plugin:dialog|message', 'plugin:dialog|open', 'plugin:dialog|save',
      ]

      for (const cmd of allowedCommands) {
        it(`allows ${cmd}`, async () => {
          invoke.mockResolvedValue(undefined)
          const handler = startAndGetListener()
          const event = makeMessageEvent(iframe.contentWindow, {
            type: 'mim:invoke',
            id: `test-${cmd}`,
            command: cmd,
            args: {},
          })
          await handler(event)

          expect(invoke).toHaveBeenCalled()
          // Should post result, not error
          const posted = iframe.contentWindow.postMessage.mock.calls[0][0]
          expect(posted.type).toBe('mim:result')
          expect(posted).not.toHaveProperty('error')
          expect(posted).toHaveProperty('result')
        })
      }

      it('rejects unlisted command: shell_exec', async () => {
        const handler = startAndGetListener()
        const event = makeMessageEvent(iframe.contentWindow, {
          type: 'mim:invoke',
          id: 'req-bad',
          command: 'shell_exec',
          args: { cmd: 'rm -rf /' },
        })
        await handler(event)

        expect(invoke).not.toHaveBeenCalled()
        const posted = iframe.contentWindow.postMessage.mock.calls[0][0]
        expect(posted.error).toBe('Command not allowed: shell_exec')
      })
    })
  })
})
