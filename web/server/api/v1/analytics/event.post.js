const ALLOWED_EVENT_TYPES = new Set(['page_view', 'download_click'])

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    if (!body || typeof body !== 'object') return { ok: true }

    const { path, referrer, durationSeconds, eventType, meta } = body

    if (!path || typeof path !== 'string') return { ok: true }
    if (path.startsWith('/admin') || path.startsWith('/api')) return { ok: true }

    const type = ALLOWED_EVENT_TYPES.has(eventType) ? eventType : 'page_view'

    let referrerDomain = null
    if (referrer && typeof referrer === 'string') {
      try {
        referrerDomain = new URL(referrer).hostname
      } catch {
        // invalid URL, ignore
      }
    }

    let duration = null
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
      duration = Math.max(0, Math.min(3600, Math.round(durationSeconds)))
    }

    const eventMeta = meta && typeof meta === 'object' ? JSON.stringify(meta) : null

    const db = useDB()
    db.prepare(
      'INSERT INTO page_views (path, referrer_domain, duration_seconds, event_type, event_meta) VALUES (?, ?, ?, ?, ?)'
    ).run(path, referrerDomain, duration, type, eventMeta)
  } catch {
    // silent — never leak errors
  }
  return { ok: true }
})
