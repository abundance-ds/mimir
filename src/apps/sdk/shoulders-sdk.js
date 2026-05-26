;(function() {
  'use strict'

  const isIframe = window.parent !== window
  const T = window.__TAURI_INTERNALS__

  // If we're not in an iframe and there's no Tauri, bail
  if (!isIframe && !T) {
    console.warn('[shoulders-sdk] Not running in Tauri or iframe')
    return
  }

  // ── Invoke layer ──────────────────────────────────────────────
  // In iframe: postMessage to parent. In standalone: direct Tauri invoke.

  let _msgId = 0
  const _pending = new Map()

  function invokeViaBridge(command, args) {
    return new Promise((resolve, reject) => {
      const id = `sdk_${++_msgId}_${Date.now()}`
      _pending.set(id, { resolve, reject })
      window.parent.postMessage({
        type: 'shoulders:invoke',
        id,
        command,
        args: args || {},
      }, '*')
    })
  }

  if (isIframe) {
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'shoulders:result') return
      const { id, result, error } = event.data
      const pending = _pending.get(id)
      if (!pending) return
      _pending.delete(id)
      if (error) pending.reject(new Error(error))
      else pending.resolve(result)
    })
  }

  const invoke = isIframe
    ? invokeViaBridge
    : T.invoke.bind(T)

  // ── Parse identity ────────────────────────────────────────────
  // From URL: app://localhost/{appId}/index.html?projectId=...&sessionId=...
  const pathParts = window.location.pathname.split('/').filter(Boolean)
  const appId = pathParts[0] || ''

  // projectId comes from query params (set by AppCustom.vue) or URL path (legacy)
  const urlParams = new URLSearchParams(window.location.search)
  const projectId = urlParams.get('projectId') || pathParts[1] || ''
  const sessionId = urlParams.get('sessionId') || ''

  if (!appId) {
    console.warn('[shoulders-sdk] Could not parse app identity from URL:', window.location.href)
  }

  // ── SDK ───────────────────────────────────────────────────────

  const sdk = {
    app: Object.freeze({ id: appId, projectId, sessionId }),

    data: Object.freeze({
      async load(key) {
        const raw = await invoke('app_data_load', { appId, projectId, key })
        return raw != null ? JSON.parse(raw) : null
      },
      async save(key, value) {
        await invoke('app_data_save', { appId, projectId, key, value: JSON.stringify(value) })
      },
      async delete(key) {
        await invoke('app_data_delete', { appId, projectId, key })
      },
      async keys() {
        return invoke('app_data_keys', { appId, projectId })
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
          const b64 = await invoke('read_binary_file', { path })
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
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
          appId,
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
  }

  Object.freeze(sdk)
  window.shoulders = sdk
})()
