use super::model::{
    ActivityBlock, ActivityCategory, ActivityPage, Classification, ClassificationJob, RuntimeState,
    TrackerConfig, TrackerQuery, TRACKER_SCHEMA_VERSION,
};
use chrono::Utc;
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OptionalExtension, Row, Transaction,
};
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

pub struct TrackerStore {
    connection: Connection,
    path: PathBuf,
    startup_diagnostic: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct NewActivityBlock<'a> {
    pub start_ms: i64,
    pub end_ms: i64,
    pub activity: ActivityCategory,
    pub subcategory: Option<&'a str>,
    pub app_name: Option<&'a str>,
    pub bundle_id: Option<&'a str>,
    pub domain: Option<&'a str>,
    pub window_title: Option<&'a str>,
    pub classification_key: Option<&'a str>,
    pub source: &'a str,
    pub off_reason: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct AiUsageRecord<'a> {
    pub feature: &'a str,
    pub model_id: &'a str,
    pub provider: &'a str,
    pub estimated_cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub created_at_ms: i64,
}

impl TrackerStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        match Self::open_once(path) {
            Ok(store) => Ok(store),
            Err(error) if path.is_file() && !error.contains("newer than this build supports") => {
                let quarantined = quarantine_database(path).map_err(|quarantine_error| {
                    format!(
                        "{error} The database also could not be quarantined: {quarantine_error}"
                    )
                })?;
                let mut store = Self::open_once(path)?;
                store.startup_diagnostic = Some(format!(
                    "A damaged Tracker database was moved to {} and a clean database was created. The quarantined file was not deleted.",
                    quarantined.display()
                ));
                Ok(store)
            }
            Err(error) => Err(error),
        }
    }

    fn open_once(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create Tracker data directory: {error}"))?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("Could not open Tracker database: {error}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("Could not configure Tracker database timeout: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA temp_store = MEMORY;",
            )
            .map_err(|error| format!("Could not configure Tracker database: {error}"))?;

        let mut store = Self {
            connection,
            path: path.to_path_buf(),
            startup_diagnostic: None,
        };
        store.migrate()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn startup_diagnostic(&self) -> Option<&str> {
        self.startup_diagnostic.as_deref()
    }

    fn migrate(&mut self) -> Result<(), String> {
        let version = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .map_err(|error| format!("Could not read Tracker schema version: {error}"))?;
        if version > TRACKER_SCHEMA_VERSION {
            return Err(format!(
                "Tracker database schema {version} is newer than this build supports."
            ));
        }

        if version == 0 {
            let transaction = self
                .connection
                .transaction()
                .map_err(|error| format!("Could not begin Tracker schema migration: {error}"))?;
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS tracker_config (
                         id INTEGER PRIMARY KEY CHECK (id = 1),
                         value_json TEXT NOT NULL,
                         updated_at_ms INTEGER NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS runtime_state (
                         id INTEGER PRIMARY KEY CHECK (id = 1),
                         value_json TEXT NOT NULL,
                         updated_at_ms INTEGER NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS activity_blocks (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                         start_ms INTEGER NOT NULL,
                         end_ms INTEGER NOT NULL,
                         activity TEXT NOT NULL,
                         subcategory TEXT,
                         app_name TEXT,
                         bundle_id TEXT,
                         domain TEXT,
                         window_title TEXT,
                         classification_key TEXT,
                         source TEXT NOT NULL,
                         off_reason TEXT,
                         created_at_ms INTEGER NOT NULL,
                         updated_at_ms INTEGER NOT NULL,
                         CHECK (end_ms >= start_ms)
                     );
                     CREATE INDEX IF NOT EXISTS activity_blocks_range
                         ON activity_blocks(start_ms, end_ms);
                     CREATE INDEX IF NOT EXISTS activity_blocks_classification
                         ON activity_blocks(classification_key);
                     CREATE INDEX IF NOT EXISTS activity_blocks_activity
                         ON activity_blocks(activity, start_ms);
                     CREATE TABLE IF NOT EXISTS classifications (
                         key TEXT PRIMARY KEY,
                         activity TEXT NOT NULL,
                         subcategory TEXT,
                         classified_by TEXT NOT NULL,
                         manual INTEGER NOT NULL DEFAULT 0,
                         created_at_ms INTEGER NOT NULL,
                         updated_at_ms INTEGER NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS classifications_activity
                         ON classifications(activity, key);
                     CREATE TABLE IF NOT EXISTS classification_jobs (
                         key TEXT PRIMARY KEY,
                         app_name TEXT NOT NULL,
                         domain TEXT,
                         window_title TEXT,
                         first_seen_ms INTEGER NOT NULL,
                         last_seen_ms INTEGER NOT NULL,
                         attempts INTEGER NOT NULL DEFAULT 0,
                         retry_after_ms INTEGER NOT NULL DEFAULT 0
                     );
                     CREATE TABLE IF NOT EXISTS ai_usage (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                         feature TEXT NOT NULL,
                         model_id TEXT NOT NULL,
                         provider TEXT NOT NULL,
                         estimated_cost REAL NOT NULL DEFAULT 0,
                         input_tokens INTEGER NOT NULL DEFAULT 0,
                         output_tokens INTEGER NOT NULL DEFAULT 0,
                         created_at_ms INTEGER NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS ai_usage_created
                         ON ai_usage(created_at_ms);
                     CREATE TABLE IF NOT EXISTS nudge_events (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                         session_key TEXT NOT NULL,
                         block_id INTEGER,
                         message TEXT NOT NULL,
                         generated_by TEXT NOT NULL,
                         created_at_ms INTEGER NOT NULL,
                         FOREIGN KEY(block_id) REFERENCES activity_blocks(id) ON DELETE SET NULL
                     );
                     CREATE INDEX IF NOT EXISTS nudge_events_session
                         ON nudge_events(session_key, created_at_ms);
                     CREATE TABLE IF NOT EXISTS imports (
                         source_hash TEXT PRIMARY KEY,
                         source_directory TEXT NOT NULL,
                         imported_at_ms INTEGER NOT NULL,
                         blocks INTEGER NOT NULL,
                         classifications INTEGER NOT NULL,
                         report_json TEXT NOT NULL
                     );",
                )
                .map_err(|error| format!("Could not create Tracker schema: {error}"))?;
            transaction
                .pragma_update(None, "user_version", TRACKER_SCHEMA_VERSION)
                .map_err(|error| format!("Could not record Tracker schema version: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Could not commit Tracker schema migration: {error}"))?;
        }

        if self
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not verify Tracker database: {error}"))?
            != "ok"
        {
            return Err("Tracker database integrity check failed.".into());
        }
        Ok(())
    }

    pub fn config(&self) -> Result<TrackerConfig, String> {
        let json = self
            .connection
            .query_row(
                "SELECT value_json FROM tracker_config WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not load Tracker configuration: {error}"))?;
        match json {
            Some(json) => match serde_json::from_str::<TrackerConfig>(&json) {
                Ok(config) => Ok(config.normalized()),
                Err(error) => {
                    log::warn!(
                        "Tracker configuration was invalid and defaults were loaded: {error}"
                    );
                    Ok(TrackerConfig::default())
                }
            },
            None => Ok(TrackerConfig::default()),
        }
    }

    pub fn save_config(&self, config: &TrackerConfig) -> Result<TrackerConfig, String> {
        let config = config.clone().normalized();
        let json = serde_json::to_string(&config)
            .map_err(|error| format!("Could not serialize Tracker configuration: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO tracker_config(id, value_json, updated_at_ms)
                 VALUES(1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at_ms = excluded.updated_at_ms",
                params![json, now_ms()],
            )
            .map_err(|error| format!("Could not save Tracker configuration: {error}"))?;
        Ok(config)
    }

    pub fn runtime_state(&self) -> Result<RuntimeState, String> {
        let json = self
            .connection
            .query_row(
                "SELECT value_json FROM runtime_state WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not load Tracker runtime state: {error}"))?;
        match json {
            Some(json) => match serde_json::from_str(&json) {
                Ok(state) => Ok(state),
                Err(error) => {
                    log::warn!(
                        "Tracker runtime state was invalid and was reset in memory: {error}"
                    );
                    Ok(RuntimeState::default())
                }
            },
            None => Ok(RuntimeState::default()),
        }
    }

    pub fn save_runtime_state(&self, state: &RuntimeState) -> Result<(), String> {
        let json = serde_json::to_string(state)
            .map_err(|error| format!("Could not serialize Tracker runtime state: {error}"))?;
        self.connection
            .execute(
                "INSERT INTO runtime_state(id, value_json, updated_at_ms)
                 VALUES(1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at_ms = excluded.updated_at_ms",
                params![json, now_ms()],
            )
            .map_err(|error| format!("Could not save Tracker runtime state: {error}"))?;
        Ok(())
    }

    pub fn insert_block(&self, block: NewActivityBlock<'_>) -> Result<i64, String> {
        if block.end_ms < block.start_ms {
            return Err("Tracker block end precedes its start.".into());
        }
        let now = now_ms();
        self.connection
            .execute(
                "INSERT INTO activity_blocks(
                   start_ms, end_ms, activity, subcategory, app_name, bundle_id,
                   domain, window_title, classification_key, source, off_reason,
                   created_at_ms, updated_at_ms
                 ) VALUES(
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
                )",
                params![
                    block.start_ms,
                    block.end_ms,
                    block.activity.as_str(),
                    clean(block.subcategory),
                    clean(block.app_name),
                    clean(block.bundle_id),
                    clean(block.domain),
                    clean(block.window_title),
                    clean(block.classification_key),
                    block.source,
                    clean(block.off_reason),
                    now,
                ],
            )
            .map_err(|error| format!("Could not insert Tracker block: {error}"))?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn update_block_end(&self, id: i64, end_ms: i64) -> Result<(), String> {
        let start_ms = self
            .connection
            .query_row(
                "SELECT start_ms FROM activity_blocks WHERE id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("Could not read Tracker block: {error}"))?
            .ok_or_else(|| format!("Tracker block {id} no longer exists."))?;
        let end_ms = end_ms.max(start_ms);
        self.connection
            .execute(
                "UPDATE activity_blocks
                 SET end_ms = ?2, updated_at_ms = ?3
                 WHERE id = ?1",
                params![id, end_ms, now_ms()],
            )
            .map_err(|error| format!("Could not extend Tracker block: {error}"))?;
        Ok(())
    }

    pub fn current_block(&self) -> Result<Option<ActivityBlock>, String> {
        self.connection
            .query_row(
                "SELECT id, start_ms, end_ms, activity, subcategory, app_name,
                        bundle_id, domain, window_title, classification_key,
                        source, off_reason
                 FROM activity_blocks
                 ORDER BY end_ms DESC, id DESC
                 LIMIT 1",
                [],
                block_from_row,
            )
            .optional()
            .map_err(|error| format!("Could not load current Tracker block: {error}"))
    }

    pub fn blocks_in_range(
        &self,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<ActivityBlock>, String> {
        let mut blocks = Vec::new();
        self.visit_blocks_in_range(start_ms, end_ms, |block| {
            blocks.push(block.clone());
            Ok(())
        })?;
        Ok(blocks)
    }

    pub fn visit_blocks_in_range(
        &self,
        start_ms: i64,
        end_ms: i64,
        mut visitor: impl FnMut(&ActivityBlock) -> Result<(), String>,
    ) -> Result<u64, String> {
        if end_ms <= start_ms {
            return Ok(0);
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, start_ms, end_ms, activity, subcategory, app_name,
                        bundle_id, domain, window_title, classification_key,
                        source, off_reason
                 FROM activity_blocks
                 WHERE end_ms > ?1 AND start_ms < ?2
                 ORDER BY start_ms ASC, id ASC",
            )
            .map_err(|error| format!("Could not prepare Tracker range query: {error}"))?;
        let mut rows = statement
            .query(params![start_ms, end_ms])
            .map_err(|error| format!("Could not query Tracker blocks: {error}"))?;
        let mut count = 0_u64;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("Could not read Tracker block row: {error}"))?
        {
            let block = block_from_row(row)
                .map_err(|error| format!("Could not decode Tracker block: {error}"))?;
            visitor(&block)?;
            count = count.saturating_add(1);
        }
        Ok(count)
    }

    pub fn query(&self, query: &TrackerQuery) -> Result<ActivityPage, String> {
        if query.end_ms <= query.start_ms {
            return Ok(ActivityPage {
                blocks: Vec::new(),
                total: 0,
                offset: 0,
                limit: query.limit.unwrap_or(200).clamp(1, 500),
            });
        }

        let mut clauses = vec!["end_ms > ?".to_string(), "start_ms < ?".to_string()];
        let mut values = vec![Value::Integer(query.start_ms), Value::Integer(query.end_ms)];
        if !query.categories.is_empty() {
            clauses.push(format!(
                "activity IN ({})",
                std::iter::repeat_n("?", query.categories.len())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            values.extend(
                query
                    .categories
                    .iter()
                    .map(|category| Value::Text(category.as_str().into())),
            );
        }
        if let Some(search) = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            clauses.push(
                "(LOWER(activity) LIKE ? ESCAPE '\\' \
                  OR LOWER(COALESCE(subcategory, '')) LIKE ? ESCAPE '\\' \
                  OR LOWER(COALESCE(app_name, '')) LIKE ? ESCAPE '\\' \
                  OR LOWER(COALESCE(domain, '')) LIKE ? ESCAPE '\\' \
                  OR LOWER(COALESCE(window_title, '')) LIKE ? ESCAPE '\\')"
                    .into(),
            );
            let pattern = Value::Text(format!("%{}%", escape_like(&search.to_ascii_lowercase())));
            values.extend(std::iter::repeat_n(pattern, 5));
        }
        let predicate = clauses.join(" AND ");
        let count_sql = format!("SELECT COUNT(*) FROM activity_blocks WHERE {predicate}");
        let total = self
            .connection
            .query_row(&count_sql, params_from_iter(values.iter()), |row| {
                row.get::<_, u64>(0)
            })
            .map_err(|error| format!("Could not count Tracker blocks: {error}"))?;
        let offset = query.offset.unwrap_or(0).min(total);
        let limit = query.limit.unwrap_or(200).clamp(1, 500);
        let sql = format!(
            "SELECT id, start_ms, end_ms, activity, subcategory, app_name,
                    bundle_id, domain, window_title, classification_key,
                    source, off_reason
             FROM activity_blocks
             WHERE {predicate}
             ORDER BY start_ms DESC, id DESC
             LIMIT ? OFFSET ?"
        );
        let mut page_values = values;
        page_values.push(Value::Integer(limit as i64));
        page_values.push(Value::Integer(offset.min(i64::MAX as u64) as i64));
        let mut statement = self
            .connection
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare Tracker page query: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), block_from_row)
            .map_err(|error| format!("Could not query Tracker page: {error}"))?;
        let blocks = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read Tracker page: {error}"))?;
        Ok(ActivityPage {
            blocks,
            total,
            offset,
            limit,
        })
    }

    pub fn classification(&self, key: &str) -> Result<Option<Classification>, String> {
        self.connection
            .query_row(
                "SELECT key, activity, subcategory, classified_by, manual,
                        created_at_ms, updated_at_ms
                 FROM classifications WHERE key = ?1",
                [key],
                classification_from_row,
            )
            .optional()
            .map_err(|error| format!("Could not load Tracker classification: {error}"))
    }

    pub fn classification_with_fallback(
        &self,
        key: &str,
    ) -> Result<Option<Classification>, String> {
        if let Some(exact) = self.classification(key)? {
            return Ok(Some(exact));
        }
        let Some((app, _domain)) = key.split_once(" | ") else {
            return Ok(None);
        };
        self.classification(app)
    }

    pub fn classifications(&self) -> Result<Vec<Classification>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT key, activity, subcategory, classified_by, manual,
                        created_at_ms, updated_at_ms
                 FROM classifications
                 ORDER BY key COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("Could not prepare classification query: {error}"))?;
        let rows = statement
            .query_map([], classification_from_row)
            .map_err(|error| format!("Could not query Tracker classifications: {error}"))?;
        let mut values = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read Tracker classifications: {error}"))?;
        drop(statement);

        let mut pending_statement = self
            .connection
            .prepare(
                "SELECT jobs.key, jobs.first_seen_ms, jobs.last_seen_ms
                 FROM classification_jobs AS jobs
                 WHERE NOT EXISTS (
                   SELECT 1 FROM classifications AS rules
                   WHERE rules.key = jobs.key
                      OR instr(jobs.key, rules.key || ' | ') = 1
                 )",
            )
            .map_err(|error| format!("Could not prepare pending classification query: {error}"))?;
        let pending = pending_statement
            .query_map([], |row| {
                Ok(Classification {
                    key: row.get(0)?,
                    activity: ActivityCategory::Unknown,
                    subcategory: None,
                    classified_by: "pending".into(),
                    manual: false,
                    created_at_ms: row.get(1)?,
                    updated_at_ms: row.get(2)?,
                })
            })
            .map_err(|error| format!("Could not query pending Tracker classifications: {error}"))?;
        values.extend(
            pending.collect::<Result<Vec<_>, _>>().map_err(|error| {
                format!("Could not read pending Tracker classifications: {error}")
            })?,
        );
        values.sort_by_cached_key(|value| value.key.to_ascii_lowercase());
        Ok(values)
    }

    pub fn save_classification(
        &self,
        key: &str,
        activity: ActivityCategory,
        subcategory: Option<&str>,
        classified_by: &str,
        manual: bool,
        apply_history: bool,
    ) -> Result<Classification, String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("Classification key must not be empty.".into());
        }
        let now = now_ms();
        let existing = self.classification(key)?;
        if existing.as_ref().is_some_and(|value| value.manual) && !manual {
            self.clear_classification_jobs_for_rule(key)?;
            return existing.ok_or_else(|| "Classification disappeared.".into());
        }
        self.connection
            .execute(
                "INSERT INTO classifications(
                   key, activity, subcategory, classified_by, manual,
                   created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(key) DO UPDATE SET
                   activity = excluded.activity,
                   subcategory = excluded.subcategory,
                   classified_by = excluded.classified_by,
                   manual = excluded.manual,
                   updated_at_ms = excluded.updated_at_ms",
                params![
                    key,
                    activity.as_str(),
                    clean(subcategory),
                    classified_by,
                    manual,
                    now,
                ],
            )
            .map_err(|error| format!("Could not save Tracker classification: {error}"))?;
        if apply_history {
            let apply_app_scope = !key.contains(" | ");
            self.connection
                .execute(
                    "UPDATE activity_blocks
                     SET activity = ?2, subcategory = ?3, source = ?4, updated_at_ms = ?5
                     WHERE (
                       classification_key = ?1
                       OR (?6 = 1 AND instr(classification_key, ?1 || ' | ') = 1)
                     )
                       AND activity NOT IN ('AFK', 'OFF', 'Break')",
                    params![
                        key,
                        activity.as_str(),
                        clean(subcategory),
                        if manual { "manual" } else { classified_by },
                        now,
                        apply_app_scope
                    ],
                )
                .map_err(|error| format!("Could not reclassify Tracker history: {error}"))?;
        }
        self.clear_classification_jobs_for_rule(key)?;
        self.classification(key)?
            .ok_or_else(|| "Saved Tracker classification could not be reloaded.".into())
    }

    fn clear_classification_jobs_for_rule(&self, key: &str) -> Result<(), String> {
        let app_scope = !key.contains(" | ");
        self.connection
            .execute(
                "DELETE FROM classification_jobs
                 WHERE key = ?1
                    OR (?2 = 1 AND instr(key, ?1 || ' | ') = 1)",
                params![key, app_scope],
            )
            .map_err(|error| format!("Could not clear classification job: {error}"))?;
        Ok(())
    }

    pub fn queue_classification(
        &self,
        observation: &super::model::Observation,
    ) -> Result<(), String> {
        let key = observation.classification_key();
        self.connection
            .execute(
                "INSERT INTO classification_jobs(
                   key, app_name, domain, window_title, first_seen_ms,
                   last_seen_ms, attempts, retry_after_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?5, 0, 0)
                 ON CONFLICT(key) DO UPDATE SET
                   app_name = excluded.app_name,
                   domain = excluded.domain,
                   window_title = COALESCE(excluded.window_title, classification_jobs.window_title),
                   last_seen_ms = excluded.last_seen_ms",
                params![
                    key,
                    observation.app_name.trim(),
                    clean(observation.domain.as_deref()),
                    clean(observation.window_title.as_deref()),
                    observation.observed_at_ms,
                ],
            )
            .map_err(|error| format!("Could not queue Tracker classification: {error}"))?;
        Ok(())
    }

    pub fn due_classification_jobs(
        &self,
        now_ms: i64,
        limit: u64,
    ) -> Result<Vec<ClassificationJob>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT key, app_name, domain, window_title, first_seen_ms,
                        last_seen_ms, attempts, retry_after_ms
                 FROM classification_jobs AS jobs
                 WHERE retry_after_ms <= ?1
                   AND attempts < 5
                   AND NOT EXISTS (
                     SELECT 1 FROM classifications AS rules
                     WHERE rules.key = jobs.key
                        OR instr(jobs.key, rules.key || ' | ') = 1
                   )
                 ORDER BY first_seen_ms ASC
                 LIMIT ?2",
            )
            .map_err(|error| format!("Could not prepare classification job query: {error}"))?;
        let rows = statement
            .query_map(params![now_ms, limit.clamp(1, 100)], |row| {
                Ok(ClassificationJob {
                    key: row.get(0)?,
                    app_name: row.get(1)?,
                    domain: row.get(2)?,
                    window_title: row.get(3)?,
                    first_seen_ms: row.get(4)?,
                    last_seen_ms: row.get(5)?,
                    attempts: row.get::<_, u32>(6)?,
                    retry_after_ms: row.get(7)?,
                })
            })
            .map_err(|error| format!("Could not query classification jobs: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read classification jobs: {error}"))
    }

    pub fn defer_classification_jobs(
        &self,
        keys: &[String],
        retry_after_ms: i64,
    ) -> Result<(), String> {
        for key in keys {
            self.connection
                .execute(
                    "UPDATE classification_jobs
                     SET attempts = attempts + 1, retry_after_ms = ?2
                     WHERE key = ?1",
                    params![key, retry_after_ms],
                )
                .map_err(|error| format!("Could not defer classification job: {error}"))?;
        }
        Ok(())
    }

    pub fn queued_classification_count(&self) -> Result<u64, String> {
        self.connection
            .query_row("SELECT COUNT(*) FROM classification_jobs", [], |row| {
                row.get::<_, u64>(0)
            })
            .map_err(|error| format!("Could not count classification jobs: {error}"))
    }

    pub fn record_ai_usage(&self, usage: AiUsageRecord<'_>) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO ai_usage(
                   feature, model_id, provider, estimated_cost,
                   input_tokens, output_tokens, created_at_ms
                ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    usage.feature,
                    usage.model_id,
                    usage.provider,
                    usage.estimated_cost.max(0.0),
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.created_at_ms,
                ],
            )
            .map_err(|error| format!("Could not record Tracker AI usage: {error}"))?;
        Ok(())
    }

    pub fn ai_cost_since(&self, start_ms: i64) -> Result<f64, String> {
        self.connection
            .query_row(
                "SELECT COALESCE(SUM(estimated_cost), 0)
                 FROM ai_usage WHERE created_at_ms >= ?1",
                [start_ms],
                |row| row.get::<_, f64>(0),
            )
            .map_err(|error| format!("Could not calculate Tracker AI cost: {error}"))
    }

    pub fn record_nudge(
        &self,
        session_key: &str,
        block_id: Option<i64>,
        message: &str,
        generated_by: &str,
        created_at_ms: i64,
    ) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO nudge_events(
                   session_key, block_id, message, generated_by, created_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![session_key, block_id, message, generated_by, created_at_ms],
            )
            .map_err(|error| format!("Could not record Tracker nudge: {error}"))?;
        Ok(())
    }

    pub fn session_nudges(&self, session_key: &str) -> Result<Vec<i64>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT created_at_ms FROM nudge_events
                 WHERE session_key = ?1 ORDER BY created_at_ms ASC",
            )
            .map_err(|error| format!("Could not prepare Tracker nudge query: {error}"))?;
        let rows = statement
            .query_map([session_key], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("Could not query Tracker nudges: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read Tracker nudges: {error}"))
    }

    pub fn import_exists(&self, source_hash: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM imports WHERE source_hash = ?1)",
                [source_hash],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("Could not inspect Tracker imports: {error}"))
    }

    pub fn with_transaction<T>(
        &mut self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("Could not begin Tracker transaction: {error}"))?;
        let result = operation(&transaction)?;
        transaction
            .commit()
            .map_err(|error| format!("Could not commit Tracker transaction: {error}"))?;
        Ok(result)
    }

    pub fn checkpoint(&self) -> Result<(), String> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("Could not checkpoint Tracker database: {error}"))
    }
}

pub fn insert_block_transaction(
    transaction: &Transaction<'_>,
    block: NewActivityBlock<'_>,
) -> Result<(), String> {
    let now = now_ms();
    transaction
        .execute(
            "INSERT INTO activity_blocks(
               start_ms, end_ms, activity, subcategory, app_name, bundle_id,
               domain, window_title, classification_key, source, off_reason,
               created_at_ms, updated_at_ms
            ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                block.start_ms,
                block.end_ms,
                block.activity.as_str(),
                clean(block.subcategory),
                clean(block.app_name),
                clean(block.bundle_id),
                clean(block.domain),
                clean(block.window_title),
                clean(block.classification_key),
                block.source,
                clean(block.off_reason),
                now,
            ],
        )
        .map_err(|error| format!("Could not import Tracker block: {error}"))?;
    Ok(())
}

pub fn save_classification_transaction(
    transaction: &Transaction<'_>,
    classification: &Classification,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO classifications(
               key, activity, subcategory, classified_by, manual,
               created_at_ms, updated_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(key) DO UPDATE SET
               activity = CASE WHEN classifications.manual = 1
                               THEN classifications.activity ELSE excluded.activity END,
               subcategory = CASE WHEN classifications.manual = 1
                                  THEN classifications.subcategory ELSE excluded.subcategory END,
               classified_by = CASE WHEN classifications.manual = 1
                                    THEN classifications.classified_by ELSE excluded.classified_by END,
               manual = MAX(classifications.manual, excluded.manual),
               updated_at_ms = MAX(classifications.updated_at_ms, excluded.updated_at_ms)",
            params![
                classification.key,
                classification.activity.as_str(),
                clean(classification.subcategory.as_deref()),
                classification.classified_by,
                classification.manual,
                classification.created_at_ms,
                classification.updated_at_ms,
            ],
        )
        .map_err(|error| format!("Could not import Tracker classification: {error}"))?;
    Ok(())
}

fn block_from_row(row: &Row<'_>) -> rusqlite::Result<ActivityBlock> {
    let start_ms = row.get::<_, i64>(1)?;
    let end_ms = row.get::<_, i64>(2)?;
    let activity = ActivityCategory::from_str(&row.get::<_, String>(3)?).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    })?;
    Ok(ActivityBlock {
        id: row.get(0)?,
        start_ms,
        end_ms,
        duration_seconds: (end_ms - start_ms).max(0) / 1000,
        activity,
        subcategory: row.get(4)?,
        app_name: row.get(5)?,
        bundle_id: row.get(6)?,
        domain: row.get(7)?,
        window_title: row.get(8)?,
        classification_key: row.get(9)?,
        source: row.get(10)?,
        off_reason: row.get(11)?,
    })
}

fn classification_from_row(row: &Row<'_>) -> rusqlite::Result<Classification> {
    let activity = ActivityCategory::from_str(&row.get::<_, String>(1)?).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    })?;
    Ok(Classification {
        key: row.get(0)?,
        activity,
        subcategory: row.get(2)?,
        classified_by: row.get(3)?,
        manual: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn quarantine_database(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("tracker");
    let quarantined = parent.join(format!("{stem}.corrupt-{}.sqlite", now_ms()));
    std::fs::rename(path, &quarantined).map_err(|error| {
        format!(
            "Could not move {} to {}: {error}",
            path.display(),
            quarantined.display()
        )
    })?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.exists() {
            let target = PathBuf::from(format!("{}{suffix}", quarantined.display()));
            if let Err(error) = std::fs::rename(&sidecar, &target) {
                log::warn!(
                    "Could not quarantine Tracker sidecar {}: {error}",
                    sidecar.display()
                );
            }
        }
    }
    Ok(quarantined)
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, TrackerStore) {
        let directory = TempDir::new().unwrap();
        let store = TrackerStore::open(&directory.path().join("tracker.sqlite")).unwrap();
        (directory, store)
    }

    #[test]
    fn initializes_and_round_trips_configuration() {
        let (_directory, store) = store();
        assert!(!store.config().unwrap().enabled);
        let config = TrackerConfig {
            enabled: true,
            poll_interval_seconds: 1,
            ..TrackerConfig::default()
        };
        let saved = store.save_config(&config).unwrap();
        assert!(saved.enabled);
        assert_eq!(saved.poll_interval_seconds, 5);
        assert_eq!(store.config().unwrap(), saved);
    }

    #[test]
    fn blocks_are_range_queried_and_paginated_without_rounded_durations() {
        let (_directory, store) = store();
        store
            .insert_block(NewActivityBlock {
                start_ms: 1_000,
                end_ms: 62_500,
                activity: ActivityCategory::Work,
                subcategory: Some("Coding"),
                app_name: Some("Mimir"),
                bundle_id: Some("com.abundanceds.mimir"),
                domain: None,
                window_title: Some("tracker.rs"),
                classification_key: Some("com.abundanceds.mimir"),
                source: "native",
                off_reason: None,
            })
            .unwrap();
        let page = store
            .query(&TrackerQuery {
                start_ms: 0,
                end_ms: 100_000,
                limit: Some(25),
                ..TrackerQuery::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.blocks[0].duration_seconds, 61);
    }

    #[test]
    fn page_filters_count_and_limit_inside_sql_with_literal_search_wildcards() {
        let (_directory, store) = store();
        for (index, activity, title) in [
            (0, ActivityCategory::Work, "Write 100% coverage"),
            (1, ActivityCategory::Leisure, "Video"),
            (2, ActivityCategory::Work, "Review"),
        ] {
            store
                .insert_block(NewActivityBlock {
                    start_ms: index * 10_000,
                    end_ms: index * 10_000 + 5_000,
                    activity,
                    subcategory: None,
                    app_name: Some("Example"),
                    bundle_id: Some("com.example.App"),
                    domain: None,
                    window_title: Some(title),
                    classification_key: Some("com.example.App"),
                    source: "test",
                    off_reason: None,
                })
                .unwrap();
        }

        let work = store
            .query(&TrackerQuery {
                start_ms: 0,
                end_ms: 100_000,
                categories: vec![ActivityCategory::Work],
                offset: Some(1),
                limit: Some(1),
                ..TrackerQuery::default()
            })
            .unwrap();
        assert_eq!(work.total, 2);
        assert_eq!(work.blocks.len(), 1);
        assert_eq!(work.offset, 1);

        let literal_percent = store
            .query(&TrackerQuery {
                start_ms: 0,
                end_ms: 100_000,
                search: Some("%".into()),
                ..TrackerQuery::default()
            })
            .unwrap();
        assert_eq!(literal_percent.total, 1);
        assert_eq!(
            literal_percent.blocks[0].window_title.as_deref(),
            Some("Write 100% coverage")
        );
    }

    #[test]
    fn manual_classifications_win_and_can_reclassify_history() {
        let (_directory, store) = store();
        for (index, key) in ["com.example.App", "com.example.App | docs.example"]
            .iter()
            .enumerate()
        {
            let start_ms = (index as i64) * 10_000;
            store
                .insert_block(NewActivityBlock {
                    start_ms,
                    end_ms: start_ms + 5_000,
                    activity: ActivityCategory::Unknown,
                    subcategory: None,
                    app_name: Some("Example"),
                    bundle_id: Some("com.example.App"),
                    domain: key.split_once(" | ").map(|(_, domain)| domain),
                    window_title: None,
                    classification_key: Some(key),
                    source: "test",
                    off_reason: None,
                })
                .unwrap();
        }
        store
            .save_classification(
                "com.example.App",
                ActivityCategory::Leisure,
                Some("Video"),
                "manual",
                true,
                true,
            )
            .unwrap();
        let ignored = store
            .save_classification(
                "com.example.App",
                ActivityCategory::Work,
                Some("Research"),
                "ai",
                false,
                false,
            )
            .unwrap();
        assert_eq!(ignored.activity, ActivityCategory::Leisure);
        assert!(ignored.manual);
        let blocks = store.blocks_in_range(0, 30_000).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(blocks
            .iter()
            .all(|block| block.activity == ActivityCategory::Leisure));
        assert!(blocks.iter().all(|block| block.source == "manual"));
    }

    #[test]
    fn manual_rules_clear_stale_jobs_and_retry_exhaustion_stops_ai_work() {
        let (_directory, store) = store();
        let observation = super::super::model::Observation {
            observed_at_ms: 1_000,
            idle_seconds: 0,
            app_name: "Ghostty".into(),
            bundle_id: Some("com.example.Ghostty".into()),
            domain: None,
            window_title: None,
            mimir_context: None,
        };
        store.queue_classification(&observation).unwrap();
        for attempt in 0..5 {
            store
                .defer_classification_jobs(&["com.example.Ghostty".into()], attempt)
                .unwrap();
        }
        assert!(store
            .due_classification_jobs(10_000, 25)
            .unwrap()
            .is_empty());

        store
            .save_classification(
                "com.example.Ghostty",
                ActivityCategory::Unknown,
                None,
                "manual",
                true,
                false,
            )
            .unwrap();
        assert_eq!(store.queued_classification_count().unwrap(), 0);
    }

    #[test]
    fn database_reopens_with_durable_state() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("tracker.sqlite");
        {
            let store = TrackerStore::open(&path).unwrap();
            let state = RuntimeState {
                break_end_ms: Some(42),
                ..RuntimeState::default()
            };
            store.save_runtime_state(&state).unwrap();
            store.checkpoint().unwrap();
        }
        let reopened = TrackerStore::open(&path).unwrap();
        assert_eq!(reopened.runtime_state().unwrap().break_end_ms, Some(42));
    }

    #[test]
    fn corrupt_database_is_quarantined_without_losing_the_file() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("tracker.sqlite");
        std::fs::write(&path, b"not a sqlite database").unwrap();

        let store = TrackerStore::open(&path).unwrap();

        assert!(store.startup_diagnostic().is_some());
        assert!(path.exists());
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }
}
