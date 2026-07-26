;(function() {
  'use strict'

  const isIframe = window.parent !== window
  const T = window.__TAURI_INTERNALS__

  // If we're not in an iframe and there's no Tauri, bail
  if (!isIframe && !T) {
    console.warn('[mim-sdk] Not running in Tauri or iframe')
    return
  }

  // ── Invoke layer ──────────────────────────────────────────────
  // In iframe: postMessage to parent. In standalone: direct Tauri invoke.

  let _msgId = 0
  const _pending = new Map()
  const _toolHandlers = new Map()
  const _toolCalls = new Map()

  function invokeViaBridge(command, args) {
    return new Promise((resolve, reject) => {
      const id = `sdk_${++_msgId}_${Date.now()}`
      _pending.set(id, { resolve, reject })
      window.parent.postMessage({
        type: 'mim:invoke',
        id,
        command,
        args: args || {},
      }, '*')
    })
  }

  if (isIframe) {
    window.addEventListener('message', async (event) => {
      if (event.source !== window.parent) return
      const message = event.data
      if (message?.type === 'mim:result') {
        const { id, result, error } = message
        const pending = _pending.get(id)
        if (!pending) return
        _pending.delete(id)
        if (error) pending.reject(new Error(error))
        else pending.resolve(result)
        return
      }
      if (message?.type === 'mim:tool-cancel') {
        _toolCalls.get(message.id)?.abort()
        _toolCalls.delete(message.id)
        return
      }
      if (message?.type !== 'mim:tool-call') return
      const localName = String(message.tool || '').split('.').at(-1)
      const handler = _toolHandlers.get(message.tool) || _toolHandlers.get(localName)
      if (!handler) {
        window.parent.postMessage({
          type: 'mim:tool-response',
          id: message.id,
          result: null,
          error: {
            code: 'unavailable',
            message: `No handler is attached for '${message.tool}'.`,
          },
        }, '*')
        return
      }
      const controller = new AbortController()
      _toolCalls.set(message.id, controller)
      try {
        const value = await handler(message.input || {}, {
          context: message.context || {},
          signal: controller.signal,
          tool: message.tool,
        })
        if (!controller.signal.aborted) {
          const result = value && typeof value === 'object'
            && ('value' in value || 'displayText' in value || 'metadata' in value)
            ? value
            : { value }
          window.parent.postMessage({
            type: 'mim:tool-response',
            id: message.id,
            result,
            error: null,
          }, '*')
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          window.parent.postMessage({
            type: 'mim:tool-response',
            id: message.id,
            result: null,
            error: {
              code: error?.code || 'handler',
              message: error?.message || String(error),
              data: error?.data || null,
            },
          }, '*')
        }
      } finally {
        _toolCalls.delete(message.id)
      }
    })
  }

  const invoke = isIframe
    ? invokeViaBridge
    : T.invoke.bind(T)

  // ── Parse identity ────────────────────────────────────────────
  // From URL: app://localhost/{appId}/index.html?instanceId=...&workspacePath=...
  const pathParts = window.location.pathname.split('/').filter(Boolean)
  const appId = pathParts[0] || ''

  const urlParams = new URLSearchParams(window.location.search)
  const instanceId = urlParams.get('instanceId') || ''
  const workspacePath = urlParams.get('workspacePath') || ''

  if (!appId) {
    console.warn('[mim-sdk] Could not parse app identity from URL:', window.location.href)
  }

  // ── SDK ───────────────────────────────────────────────────────

  const sdk = {
    app: Object.freeze({ id: appId, instanceId, workspacePath }),

    data: Object.freeze({
      async load(key) {
        const raw = await invoke('app_data_load', { appId, key })
        return raw != null ? JSON.parse(raw) : null
      },
      async save(key, value) {
        await invoke('app_data_save', { appId, key, value: JSON.stringify(value) })
      },
      async delete(key) {
        await invoke('app_data_delete', { appId, key })
      },
    }),

    ui: Object.freeze({
      async alert(message) {
        await invoke('plugin:dialog|message', {
          message: String(message),
          title: null,
          kind: null,
          buttons: null,
        })
      },
      async confirm(message) {
        const result = await invoke('plugin:dialog|message', {
          message: String(message),
          title: null,
          kind: null,
          buttons: 'YesNo',
        })
        return result === 'Yes'
      },
      async openFile(options) {
        return invoke('plugin:dialog|open', { options: options || {} })
      },
      async saveFile(options) {
        return invoke('plugin:dialog|save', { options: options || {} })
      },
    }),

    fs: Object.freeze({
      async readText(path, encoding) {
        if (encoding && encoding.toLowerCase() !== 'utf-8') {
          const result = await invoke('read_binary_file', { path })
          const bytes = binaryResultToBytes(result)
          if (encoding.toLowerCase() === 'latin1' || encoding.toLowerCase() === 'iso-8859-1') {
            return Array.from(bytes, b => String.fromCharCode(b)).join('')
          }
          return new TextDecoder(encoding).decode(bytes)
        }
        const result = await invoke('read_text_file', { path })
        return typeof result === 'object' ? result.content : result
      },
      async writeText(path, content) {
        await invoke('write_text_file', { path, content })
      },
      async exists(path) {
        return invoke('path_exists', { path })
      },
    }),
    http: Object.freeze({
      async fetch(url, opts = {}) {
        const result = await invoke('app_http_request', {
          url,
          method: opts.method || 'GET',
          headers: opts.headers || null,
          body: opts.body || null,
          timeoutMs: opts.timeout || null,
        })
        return {
          status: result.status,
          headers: result.headers,
          body: result.body,
          get ok() { return result.status >= 200 && result.status < 300 },
          json() { return JSON.parse(result.body) },
        }
      },
    }),
    tools: Object.freeze({
      async list() {
        const response = await invoke('tool_registry_list')
        return response?.tools || []
      },
      async call(name, input = {}) {
        const response = await invoke('tool_registry_call', {
          request: {
            tool: String(name),
            input,
            caller: { kind: 'app', id: appId },
            requestId: null,
            cwd: workspacePath || null,
            metadata: instanceId ? { appInstanceId: instanceId } : {},
          },
        })
        if (response?.error) {
          throw Object.assign(new Error(response.error.message || 'Tool call failed.'), response.error)
        }
        return response?.result?.value
      },
      handle(name, handler) {
        if (!name || typeof handler !== 'function') {
          throw new TypeError('mim.tools.handle requires a tool name and handler function')
        }
        _toolHandlers.set(String(name), handler)
        return () => _toolHandlers.delete(String(name))
      },
    }),
    workspace: Object.freeze({
      openFile(path) {
        if (!isIframe) return Promise.reject(new Error('Open-file routing requires an embedded app.'))
        window.parent.postMessage({ type: 'mim:open-file', path: String(path) }, '*')
        return Promise.resolve()
      },
    }),
  }

  Object.freeze(sdk)
  window.mim = sdk
  if (isIframe) {
    window.parent.postMessage({ type: 'mim:ready', appId }, '*')
  }

  function binaryResultToBytes(result) {
    if (result instanceof ArrayBuffer) return new Uint8Array(result)
    if (ArrayBuffer.isView(result)) {
      return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
    }
    if (Array.isArray(result)) return Uint8Array.from(result)
    if (typeof result === 'string') {
      return Uint8Array.from(atob(result), character => character.charCodeAt(0))
    }
    throw new Error('The native file reader returned an unsupported binary payload.')
  }
})()
