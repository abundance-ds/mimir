export default defineEventHandler(() => {
  const db = useDB()

  const activeDevices = {
    today: db.prepare(
      `SELECT COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE created_at >= date('now')`
    ).get().count,
    week: db.prepare(
      `SELECT COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE created_at >= date('now', '-7 days')`
    ).get().count,
    month: db.prepare(
      `SELECT COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE created_at >= date('now', '-30 days')`
    ).get().count,
  }

  const totalEvents = {
    week: db.prepare(
      `SELECT COUNT(*) as count FROM telemetry_events WHERE created_at >= date('now', '-7 days')`
    ).get().count,
  }

  const errors = {
    week: db.prepare(
      `SELECT COUNT(*) as count FROM telemetry_events WHERE event_type IN ('error', 'ai.error') AND created_at >= date('now', '-7 days')`
    ).get().count,
  }

  const downloads = {
    week: db.prepare(
      `SELECT COUNT(*) as count FROM page_views WHERE event_type = 'download_click' AND created_at >= date('now', '-7 days')`
    ).get().count,
  }

  const topVersionRow = db.prepare(
    `SELECT app_version, COUNT(*) as count FROM telemetry_events WHERE app_version IS NOT NULL AND created_at >= date('now', '-30 days') GROUP BY app_version ORDER BY count DESC LIMIT 1`
  ).get()
  const topVersion = topVersionRow?.app_version || null

  const dailyActive = db.prepare(
    `SELECT date(created_at) as date, COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE created_at >= date('now', '-14 days') GROUP BY date(created_at) ORDER BY date ASC`
  ).all()

  const featureUsage = db.prepare(
    `SELECT event_type as feature, COUNT(*) as count FROM telemetry_events WHERE event_type NOT IN ('app.open', 'error', 'ai.error') AND created_at >= date('now', '-7 days') GROUP BY event_type ORDER BY count DESC`
  ).all()

  const versions = db.prepare(
    `SELECT app_version as version, COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE app_version IS NOT NULL AND created_at >= date('now', '-30 days') GROUP BY app_version ORDER BY count DESC`
  ).all()

  const platforms = db.prepare(
    `SELECT platform, COUNT(DISTINCT device_id) as count FROM telemetry_events WHERE platform IS NOT NULL AND created_at >= date('now', '-30 days') GROUP BY platform ORDER BY count DESC`
  ).all()

  return {
    activeDevices,
    totalEvents,
    errors,
    downloads,
    topVersion,
    dailyActive,
    featureUsage,
    versions,
    platforms,
  }
})
