use rusqlite::{params, Connection};
use std::sync::Mutex;

pub struct UsageDbState {
    pub conn: Mutex<Option<Connection>>,
}

impl Default for UsageDbState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

fn get_db_path() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Cannot find home directory")?;
    let dir = std::path::PathBuf::from(home).join(".shoulders-v3");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    Ok(dir.join("usage.db").to_string_lossy().to_string())
}

fn ensure_connection(state: &UsageDbState) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let path = get_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open usage DB: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            feature TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read INTEGER DEFAULT 0,
            cache_write INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            session_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON usage_calls(timestamp);
        CREATE TABLE IF NOT EXISTS tool_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            category TEXT,
            mutating INTEGER DEFAULT 0,
            risk TEXT,
            session_id TEXT,
            duration_ms INTEGER DEFAULT 0,
            success INTEGER DEFAULT 1,
            error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_timestamp ON tool_executions(timestamp);
        CREATE TABLE IF NOT EXISTS usage_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );",
    )
    .map_err(|e| format!("Failed to create schema: {}", e))?;

    *guard = Some(conn);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct BreakdownEntry {
    pub name: String,
    pub cost: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub calls: i64,
}

#[derive(serde::Serialize)]
pub struct MonthData {
    pub total_cost: f64,
    pub calls: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub by_feature: Vec<BreakdownEntry>,
    pub by_model: Vec<BreakdownEntry>,
}

#[tauri::command]
pub fn usage_record(
    state: tauri::State<'_, UsageDbState>,
    feature: String,
    provider: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    cost: f64,
    session_id: Option<String>,
) -> Result<(), String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let timestamp = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO usage_calls (timestamp, feature, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![timestamp, feature, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost, session_id],
    ).map_err(|e| format!("Failed to insert usage record: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn usage_query_month(
    state: tauri::State<'_, UsageDbState>,
    month: String,
) -> Result<MonthData, String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let month_prefix = format!("{}%", month);

    let (total_cost, calls, total_input_tokens, total_output_tokens) = conn
        .query_row(
            "SELECT
            COALESCE(SUM(cost), 0),
            COUNT(*),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0)
         FROM usage_calls WHERE timestamp LIKE ?1",
            params![month_prefix],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(|e| format!("Query failed: {}", e))?;

    let by_feature = query_breakdown(conn, &month_prefix, "feature")?;
    let by_model = query_breakdown(conn, &month_prefix, "model")?;

    Ok(MonthData {
        total_cost,
        calls,
        total_input_tokens,
        total_output_tokens,
        by_feature,
        by_model,
    })
}

#[derive(serde::Serialize)]
pub struct DailyEntry {
    pub date: String,
    pub cost: f64,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[tauri::command]
pub fn usage_query_daily(
    state: tauri::State<'_, UsageDbState>,
    month: String,
) -> Result<Vec<DailyEntry>, String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let month_prefix = format!("{}%", month);

    let mut stmt = conn
        .prepare(
            "SELECT DATE(timestamp), COALESCE(SUM(cost), 0), COUNT(*),
                COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
         FROM usage_calls WHERE timestamp LIKE ?1
         GROUP BY DATE(timestamp) ORDER BY DATE(timestamp) ASC",
        )
        .map_err(|e| format!("Prepare failed: {}", e))?;

    let mut rows = stmt
        .query(params![month_prefix])
        .map_err(|e| format!("Query failed: {}", e))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        result.push(DailyEntry {
            date: row.get(0).map_err(|e| format!("Column error: {}", e))?,
            cost: row.get(1).map_err(|e| format!("Column error: {}", e))?,
            calls: row.get(2).map_err(|e| format!("Column error: {}", e))?,
            input_tokens: row.get(3).map_err(|e| format!("Column error: {}", e))?,
            output_tokens: row.get(4).map_err(|e| format!("Column error: {}", e))?,
        });
    }
    Ok(result)
}

fn query_breakdown(
    conn: &Connection,
    month_prefix: &str,
    group_col: &str,
) -> Result<Vec<BreakdownEntry>, String> {
    let sql = format!(
        "SELECT {col}, COALESCE(SUM(cost), 0), COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0), COUNT(*)
         FROM usage_calls WHERE timestamp LIKE ?1
         GROUP BY {col} ORDER BY SUM(cost) DESC",
        col = group_col
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params![month_prefix])
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        result.push(BreakdownEntry {
            name: row.get(0).map_err(|e| format!("Column error: {}", e))?,
            cost: row.get(1).map_err(|e| format!("Column error: {}", e))?,
            input_tokens: row.get(2).map_err(|e| format!("Column error: {}", e))?,
            output_tokens: row.get(3).map_err(|e| format!("Column error: {}", e))?,
            calls: row.get(4).map_err(|e| format!("Column error: {}", e))?,
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn tool_execution_record(
    state: tauri::State<'_, UsageDbState>,
    tool_name: String,
    category: Option<String>,
    mutating: bool,
    risk: Option<String>,
    session_id: Option<String>,
    duration_ms: i64,
    success: bool,
    error_message: Option<String>,
) -> Result<(), String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let timestamp = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tool_executions (timestamp, tool_name, category, mutating, risk, session_id, duration_ms, success, error_message)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![timestamp, tool_name, category, mutating as i32, risk, session_id, duration_ms, success as i32, error_message],
    ).map_err(|e| format!("Failed to insert tool execution: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn usage_get_setting(
    state: tauri::State<'_, UsageDbState>,
    key: String,
) -> Result<Option<String>, String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let result = conn.query_row(
        "SELECT value FROM usage_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to get setting: {}", e)),
    }
}

#[tauri::command]
pub fn usage_set_setting(
    state: tauri::State<'_, UsageDbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    conn.execute(
        "INSERT OR REPLACE INTO usage_settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| format!("Failed to set setting: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize)]
pub struct ToolExecutionEntry {
    pub tool_name: String,
    pub timestamp: String,
    pub duration_ms: i64,
    pub success: bool,
    pub error_message: Option<String>,
}

#[tauri::command]
pub fn tool_execution_query(
    state: tauri::State<'_, UsageDbState>,
    limit: Option<i64>,
) -> Result<Vec<ToolExecutionEntry>, String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let max = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT tool_name, timestamp, duration_ms, success, error_message
         FROM tool_executions ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params![max])
        .map_err(|e| format!("Query failed: {}", e))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        result.push(ToolExecutionEntry {
            tool_name: row.get(0).map_err(|e| format!("Column error: {}", e))?,
            timestamp: row.get(1).map_err(|e| format!("Column error: {}", e))?,
            duration_ms: row.get(2).map_err(|e| format!("Column error: {}", e))?,
            success: row
                .get::<_, i32>(3)
                .map_err(|e| format!("Column error: {}", e))?
                != 0,
            error_message: row.get(4).map_err(|e| format!("Column error: {}", e))?,
        });
    }
    Ok(result)
}

#[tauri::command]
pub fn usage_query_month_csv(
    state: tauri::State<'_, UsageDbState>,
    month: String,
) -> Result<String, String> {
    ensure_connection(&state)?;
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let month_prefix = format!("{}%", month);
    let mut stmt = conn
        .prepare(
            "SELECT timestamp, feature, provider, model, input_tokens, output_tokens, cost
         FROM usage_calls WHERE timestamp LIKE ?1 ORDER BY timestamp ASC",
        )
        .map_err(|e| format!("Prepare failed: {}", e))?;
    let mut rows = stmt
        .query(params![month_prefix])
        .map_err(|e| format!("Query failed: {}", e))?;
    let mut csv = String::from("date,feature,provider,model,input_tokens,output_tokens,cost\n");
    while let Some(row) = rows.next().map_err(|e| format!("Row error: {}", e))? {
        let timestamp: String = row.get(0).map_err(|e| format!("Column error: {}", e))?;
        let feature: String = row.get(1).map_err(|e| format!("Column error: {}", e))?;
        let provider: String = row.get(2).map_err(|e| format!("Column error: {}", e))?;
        let model: String = row.get(3).map_err(|e| format!("Column error: {}", e))?;
        let input_tokens: i64 = row.get(4).map_err(|e| format!("Column error: {}", e))?;
        let output_tokens: i64 = row.get(5).map_err(|e| format!("Column error: {}", e))?;
        let cost: f64 = row.get(6).map_err(|e| format!("Column error: {}", e))?;
        let date = if timestamp.len() >= 10 {
            &timestamp[..10]
        } else {
            &timestamp
        };
        csv.push_str(&format!(
            "{},{},{},{},{},{},{:.6}\n",
            date, feature, provider, model, input_tokens, output_tokens, cost
        ));
    }
    Ok(csv)
}
