use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

pub struct AuditDbState {
    pub conn: Mutex<Option<Connection>>,
}

impl Default for AuditDbState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

fn get_audit_db_path() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Cannot find home directory")?;
    let dir = std::path::PathBuf::from(home).join(".shoulders-v3");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    Ok(dir.join("audit.db").to_string_lossy().to_string())
}

fn ensure_audit_connection(state: &AuditDbState) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let path = get_audit_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open audit DB: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            project_id TEXT,
            session_id TEXT,
            actor TEXT,
            payload TEXT DEFAULT '{}',
            content_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id);",
    )
    .map_err(|e| format!("Failed to create schema: {}", e))?;

    *guard = Some(conn);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct AuditEvent {
    pub id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub actor: Option<String>,
    pub payload: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AuditSummary {
    pub total_events: i64,
    pub by_type: Vec<AuditTypeCount>,
}

#[derive(serde::Serialize)]
pub struct AuditTypeCount {
    pub event_type: String,
    pub count: i64,
}

pub fn audit_log_internal(
    state: &AuditDbState,
    event_type: &str,
    project_id: Option<String>,
    session_id: Option<String>,
    actor: Option<String>,
    payload: Option<String>,
) -> Result<(), String> {
    ensure_audit_connection(state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let timestamp = chrono::Local::now().to_rfc3339();
    let payload_str = payload.as_deref().unwrap_or("{}");
    let hash_input = format!("{}{}{}", timestamp, event_type, payload_str);
    let content_hash = format!("{:x}", Sha256::digest(hash_input.as_bytes()));

    conn.execute(
        "INSERT INTO audit_events (timestamp, event_type, project_id, session_id, actor, payload, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![timestamp, event_type, project_id, session_id, actor, payload_str, content_hash],
    ).map_err(|e| format!("Failed to insert audit event: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn audit_log(
    state: tauri::State<'_, AuditDbState>,
    event_type: String,
    project_id: Option<String>,
    session_id: Option<String>,
    actor: Option<String>,
    payload: Option<String>,
) -> Result<(), String> {
    audit_log_internal(&state, &event_type, project_id, session_id, actor, payload)
}

#[tauri::command]
pub fn audit_query(
    state: tauri::State<'_, AuditDbState>,
    project_id: Option<String>,
    event_types: Option<Vec<String>>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<AuditEvent>, String> {
    ensure_audit_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref pid) = project_id {
        conditions.push(format!("project_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(pid.clone()));
    }

    if let Some(ref types) = event_types {
        if !types.is_empty() {
            let placeholders: Vec<String> = types
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", param_values.len() + i + 1))
                .collect();
            conditions.push(format!("event_type IN ({})", placeholders.join(", ")));
            for t in types {
                param_values.push(Box::new(t.clone()));
            }
        }
    }

    if let Some(ref from_ts) = from {
        conditions.push(format!("timestamp >= ?{}", param_values.len() + 1));
        param_values.push(Box::new(from_ts.clone()));
    }

    if let Some(ref to_ts) = to {
        conditions.push(format!("timestamp <= ?{}", param_values.len() + 1));
        param_values.push(Box::new(to_ts.clone()));
    }

    let max = limit.unwrap_or(200);
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, timestamp, event_type, project_id, session_id, actor, payload, content_hash
         FROM audit_events {} ORDER BY id DESC LIMIT ?{}",
        where_clause,
        param_values.len() + 1
    );
    param_values.push(Box::new(max));

    let params_ref: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params_ref.as_slice())
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        result.push(AuditEvent {
            id: row.get(0).map_err(|e| format!("Column error: {}", e))?,
            timestamp: row.get(1).map_err(|e| format!("Column error: {}", e))?,
            event_type: row.get(2).map_err(|e| format!("Column error: {}", e))?,
            project_id: row.get(3).map_err(|e| format!("Column error: {}", e))?,
            session_id: row.get(4).map_err(|e| format!("Column error: {}", e))?,
            actor: row.get(5).map_err(|e| format!("Column error: {}", e))?,
            payload: row.get(6).map_err(|e| format!("Column error: {}", e))?,
            content_hash: row.get(7).map_err(|e| format!("Column error: {}", e))?,
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn audit_query_summary(
    state: tauri::State<'_, AuditDbState>,
    project_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<AuditSummary, String> {
    ensure_audit_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref pid) = project_id {
        conditions.push(format!("project_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(pid.clone()));
    }

    if let Some(ref from_ts) = from {
        conditions.push(format!("timestamp >= ?{}", param_values.len() + 1));
        param_values.push(Box::new(from_ts.clone()));
    }

    if let Some(ref to_ts) = to {
        conditions.push(format!("timestamp <= ?{}", param_values.len() + 1));
        param_values.push(Box::new(to_ts.clone()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    // Total count
    let count_sql = format!("SELECT COUNT(*) FROM audit_events {}", where_clause);
    let params_ref: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let total_events: i64 = conn
        .query_row(&count_sql, params_ref.as_slice(), |row| row.get(0))
        .map_err(|e| format!("Query failed: {}", e))?;

    // By type
    let group_sql = format!(
        "SELECT event_type, COUNT(*) as cnt FROM audit_events {} GROUP BY event_type ORDER BY cnt DESC",
        where_clause
    );
    let params_ref2: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn
        .prepare(&group_sql)
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params_ref2.as_slice())
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut by_type = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        by_type.push(AuditTypeCount {
            event_type: row.get(0).map_err(|e| format!("Column error: {}", e))?,
            count: row.get(1).map_err(|e| format!("Column error: {}", e))?,
        });
    }

    Ok(AuditSummary {
        total_events,
        by_type,
    })
}

#[tauri::command]
pub fn audit_export_csv(
    state: tauri::State<'_, AuditDbState>,
    project_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<String, String> {
    ensure_audit_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref pid) = project_id {
        conditions.push(format!("project_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(pid.clone()));
    }

    if let Some(ref from_ts) = from {
        conditions.push(format!("timestamp >= ?{}", param_values.len() + 1));
        param_values.push(Box::new(from_ts.clone()));
    }

    if let Some(ref to_ts) = to {
        conditions.push(format!("timestamp <= ?{}", param_values.len() + 1));
        param_values.push(Box::new(to_ts.clone()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT timestamp, event_type, project_id, session_id, actor, payload
         FROM audit_events {} ORDER BY timestamp ASC",
        where_clause
    );

    let params_ref: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params_ref.as_slice())
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut csv = String::from("timestamp,event_type,project_id,session_id,actor,payload\n");
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        let timestamp: String = row.get(0).map_err(|e| format!("Column error: {}", e))?;
        let event_type: String = row.get(1).map_err(|e| format!("Column error: {}", e))?;
        let project_id: Option<String> = row.get(2).map_err(|e| format!("Column error: {}", e))?;
        let session_id: Option<String> = row.get(3).map_err(|e| format!("Column error: {}", e))?;
        let actor: Option<String> = row.get(4).map_err(|e| format!("Column error: {}", e))?;
        let payload: Option<String> = row.get(5).map_err(|e| format!("Column error: {}", e))?;
        csv.push_str(&format!(
            "{},{},{},{},{},{}\n",
            timestamp,
            event_type,
            project_id.as_deref().unwrap_or(""),
            session_id.as_deref().unwrap_or(""),
            actor.as_deref().unwrap_or(""),
            payload.as_deref().unwrap_or(""),
        ));
    }

    Ok(csv)
}
