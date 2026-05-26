const ALLOWED_TYPES = new Set([
  'app.open', 'session.create', 'chat.send', 'tool.execute',
  'ghost.trigger', 'ghost.accept', 'inline_ai.use', 'export.run',
  'file.open', 'comment.add', 'diff.review', 'skill.use',
  'app.launch', 'board.action', 'error', 'ai.error',
])

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event)
    const events = body?.events
    if (!Array.isArray(events) || events.length === 0 || events.length > 50) {
      return { ok: true }
    }

    const db = useDB()
    const stmt = db.prepare(
      'INSERT INTO telemetry_events (device_id, event_type, event_data, app_version, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insert = db.transaction((rows) => {
      for (const row of rows) stmt.run(...row)
    })

    const rows = []
    for (const e of events) {
      if (!e.device_id || typeof e.device_id !== 'string' || e.device_id.length > 64) continue
      if (!ALLOWED_TYPES.has(e.event_type)) continue
      rows.push([
        e.device_id,
        e.event_type,
        e.event_data ? JSON.stringify(e.event_data) : null,
        e.app_version || null,
        e.platform || null,
        e.timestamp || new Date().toISOString(),
      ])
    }
    if (rows.length) insert(rows)
  } catch {
    // silent — never leak errors
  }
  return { ok: true }
})
