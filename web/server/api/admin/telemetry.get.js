export default defineEventHandler((event) => {
  const query = getQuery(event)
  const db = useDB()

  const page = Math.max(1, parseInt(query.page) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 50))
  const offset = (page - 1) * limit

  const from = query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const to = query.to || new Date().toISOString().slice(0, 10)

  const conditions = ['created_at >= ?', 'created_at < date(?, \'+1 day\')']
  const params = [from, to]

  if (query.type) {
    conditions.push('event_type = ?')
    params.push(query.type)
  }
  if (query.platform) {
    conditions.push('platform = ?')
    params.push(query.platform)
  }
  if (query.device) {
    conditions.push('device_id = ?')
    params.push(query.device)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const total = db.prepare(
    `SELECT COUNT(*) as count FROM telemetry_events ${where}`
  ).get(...params).count

  const events = db.prepare(
    `SELECT id, device_id, event_type, event_data, app_version, platform, created_at FROM telemetry_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map((row) => ({
    ...row,
    event_data: row.event_data ? JSON.parse(row.event_data) : null,
  }))

  const dailyActive = db.prepare(
    `SELECT date(created_at) as date, COUNT(DISTINCT device_id) as count FROM telemetry_events ${where} GROUP BY date(created_at) ORDER BY date ASC`
  ).all(...params)

  const eventTypes = db.prepare(
    `SELECT event_type as type, COUNT(*) as count FROM telemetry_events ${where} GROUP BY event_type ORDER BY count DESC`
  ).all(...params)

  const platforms = db.prepare(
    `SELECT platform, COUNT(DISTINCT device_id) as count FROM telemetry_events ${where} AND platform IS NOT NULL GROUP BY platform ORDER BY count DESC`
  ).all(...params)

  return { events, total, dailyActive, eventTypes, platforms }
})
