const isTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)

export async function openExternalUrl(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`URL scheme '${url.protocol}' is not allowed.`)
  }

  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url.href)
    return
  }

  const opened = window.open(url.href, '_blank', 'noopener,noreferrer')
  if (!opened) throw new Error('The browser blocked the new window.')
}
