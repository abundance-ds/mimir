const ENDPOINT = 'https://mim.shoulde.rs/api/v1/telemetry/events'
const FLUSH_INTERVAL = 60_000
const MAX_BATCH = 50

let queue = []
let deviceId = null
let initialized = false
let _settings = null

export function init(settingsStore) {
  if (initialized || !window.__TAURI_INTERNALS__) return
  initialized = true
  _settings = settingsStore

  deviceId = _settings.telemetryDeviceId
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    _settings.set('telemetryDeviceId', deviceId)
  }

  setInterval(flush, FLUSH_INTERVAL)
  window.addEventListener('beforeunload', flush)

  const params = new URLSearchParams(window.location.search)
  if (params.get('view') !== 'editor') {
    emit('app.open')
  }
}

export function emit(type, data) {
  if (!deviceId) return
  if (_settings && _settings.telemetryEnabled === false) return
  queue.push({
    device_id: deviceId,
    event_type: type,
    event_data: data || undefined,
    app_version: getVersion(),
    platform: getPlatform(),
    timestamp: new Date().toISOString(),
  })
}

export function fromAudit(eventType, payload) {
  const map = {
    'session.create': () => ['session.create'],
    'session.archive': () => ['session.archive'],
    'session.fork': () => ['session.create'],
    'tool.execute': () => payload?.success !== false ? ['tool.execute', { tool: payload?.toolName }] : null,
    'export.run': () => ['export.run', { format: payload?.format }],
  }
  const result = map[eventType]?.()
  if (result) emit(result[0], result[1])
}

function flush() {
  if (!queue.length) return
  const batch = queue.splice(0, MAX_BATCH)
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {})
  } catch {}
}

function getPlatform() {
  const p = navigator.userAgentData?.platform || navigator.platform || ''
  if (/mac/i.test(p)) return 'macos'
  if (/win/i.test(p)) return 'windows'
  if (/linux/i.test(p)) return 'linux'
  return 'unknown'
}

function getVersion() {
  try { return document.querySelector('meta[name="app-version"]')?.content || '0.3.0' } catch { return '0.3.0' }
}
