export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  let currentPath = null
  let enterTime = null

  function send(path, duration, eventType = 'page_view', meta = null) {
    if (!path || path.startsWith('/admin') || path.startsWith('/api')) return
    const body = { path, eventType, durationSeconds: Math.min(Math.max(duration, 0), 3600) }
    if (document.referrer) body.referrer = document.referrer
    if (meta) body.eventMeta = meta
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' })
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/v1/analytics/event', blob)
    } else {
      fetch('/api/v1/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {})
    }
  }

  currentPath = window.location.pathname
  enterTime = Date.now()

  router.afterEach((to) => {
    if (currentPath && !currentPath.startsWith('/admin')) {
      send(currentPath, Math.round((Date.now() - enterTime) / 1000))
    }
    currentPath = to.path
    enterTime = Date.now()
  })

  window.addEventListener('beforeunload', () => {
    if (currentPath && !currentPath.startsWith('/admin')) {
      send(currentPath, Math.round((Date.now() - enterTime) / 1000))
    }
  })

  nuxtApp.provide('trackDownload', (platform) => {
    send(window.location.pathname, 0, 'download_click', { platform })
  })
})
