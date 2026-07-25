const ALLOWED_COMMANDS = new Set([
  'app_data_load', 'app_data_save', 'app_data_delete', 'app_data_keys',
  'app_http_request',
  'read_text_file', 'read_binary_file', 'write_text_file', 'path_exists',
  'plugin:dialog|message', 'plugin:dialog|open', 'plugin:dialog|save',
])

export function createAppBridge(iframeEl, { appId, projectId }) {
  let _listener = null

  function start() {
    _listener = async (event) => {
      // Only accept messages from our iframe
      if (event.source !== iframeEl?.contentWindow) return
      if (event.data?.type !== 'mim:invoke') return

      const { id, command, args } = event.data

      // Validate command is whitelisted
      if (!ALLOWED_COMMANDS.has(command)) {
        iframeEl.contentWindow.postMessage({
          type: 'mim:result',
          id,
          error: `Command not allowed: ${command}`,
        }, '*')
        return
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core')
        // Inject appId and projectId for data commands (the iframe can't forge these)
        const safeArgs = { ...args }
        if (command.startsWith('app_data_') || command === 'app_http_request') {
          safeArgs.appId = appId
          safeArgs.projectId = projectId
        }
        const result = await invoke(command, safeArgs)
        iframeEl.contentWindow?.postMessage({
          type: 'mim:result',
          id,
          result,
        }, '*')
      } catch (err) {
        iframeEl.contentWindow?.postMessage({
          type: 'mim:result',
          id,
          error: err?.message || String(err),
        }, '*')
      }
    }
    window.addEventListener('message', _listener)
  }

  function stop() {
    if (_listener) {
      window.removeEventListener('message', _listener)
      _listener = null
    }
  }

  return { start, stop }
}
