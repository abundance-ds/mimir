import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync, existsSync } from 'fs'

let _db

export function useDB() {
  if (!_db) {
    const dbPath = join(process.cwd(), 'data', 'analytics.db')
    const dir = dirname(dbPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    _db = new Database(dbPath)
    _db.pragma('journal_mode = WAL')
    _db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        app_version TEXT,
        platform TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_te_created ON telemetry_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_te_device ON telemetry_events(device_id);
      CREATE INDEX IF NOT EXISTS idx_te_type ON telemetry_events(event_type);

      CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        referrer_domain TEXT,
        duration_seconds INTEGER,
        event_type TEXT DEFAULT 'page_view',
        event_meta TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
    `)
  }
  return _db
}
