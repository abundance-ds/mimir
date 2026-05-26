export function platformString() {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
}

export function platformKind() {
  const value = platformString().toLowerCase()
  if (/mac|iphone|ipad|ipod/.test(value)) return 'macos'
  if (/win/.test(value)) return 'windows'
  if (/linux|x11|wayland/.test(value)) return 'linux'
  return 'unknown'
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

export function primaryModifierName() {
  return platformKind() === 'macos' ? 'meta' : 'ctrl'
}

export function primaryModifierPressed(event) {
  return platformKind() === 'macos' ? event.metaKey : event.ctrlKey
}
