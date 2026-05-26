export default defineEventHandler((event) => {
  const query = getQuery(event)
  const db = useDB()

  const from = query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const to = query.to || new Date().toISOString().slice(0, 10)

  const where = `WHERE created_at >= ? AND created_at < date(?, '+1 day')`
  const params = [from, to]

  const summaryRow = db.prepare(
    `SELECT COUNT(*) as totalViews, COUNT(DISTINCT path) as uniquePaths, AVG(duration_seconds) as avgDuration FROM page_views ${where}`
  ).get(...params)

  const downloads = db.prepare(
    `SELECT COUNT(*) as count FROM page_views ${where} AND event_type = 'download_click'`
  ).get(...params).count

  const summary = {
    totalViews: summaryRow.totalViews,
    uniquePaths: summaryRow.uniquePaths,
    downloads,
    avgDuration: Math.round(summaryRow.avgDuration || 0),
  }

  const dailyViews = db.prepare(
    `SELECT date(created_at) as date, COUNT(*) as count FROM page_views ${where} GROUP BY date(created_at) ORDER BY date ASC`
  ).all(...params)

  const topPages = db.prepare(
    `SELECT path, COUNT(*) as count, ROUND(AVG(duration_seconds)) as avgDuration FROM page_views ${where} GROUP BY path ORDER BY count DESC LIMIT 20`
  ).all(...params)

  const downloadRows = db.prepare(
    `SELECT event_meta FROM page_views ${where} AND event_type = 'download_click' AND event_meta IS NOT NULL`
  ).all(...params)

  const platformCounts = {}
  for (const row of downloadRows) {
    try {
      const meta = JSON.parse(row.event_meta)
      if (meta.platform) {
        platformCounts[meta.platform] = (platformCounts[meta.platform] || 0) + 1
      }
    } catch {
      // skip malformed meta
    }
  }
  const downloadsByPlatform = Object.entries(platformCounts)
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count)

  const topReferrers = db.prepare(
    `SELECT referrer_domain as domain, COUNT(*) as count FROM page_views ${where} AND referrer_domain IS NOT NULL GROUP BY referrer_domain ORDER BY count DESC LIMIT 20`
  ).all(...params)

  return { summary, dailyViews, topPages, downloadsByPlatform, topReferrers }
})
