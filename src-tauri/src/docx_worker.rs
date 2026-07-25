use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn find_docx_worker() -> Option<PathBuf> {
    // 1. Check next to the current executable (production bundle)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("docx-worker-aarch64-apple-darwin");
            if candidate.exists() {
                return Some(candidate);
            }
            let candidate = dir.join("docx-worker");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. Check src-tauri/binaries/ (development)
    let dev_candidates = [
        "src-tauri/binaries/docx-worker-aarch64-apple-darwin",
        "binaries/docx-worker-aarch64-apple-darwin",
    ];
    for path in &dev_candidates {
        if Path::new(path).exists() {
            return Some(PathBuf::from(path));
        }
    }

    // 3. Check relative to Cargo manifest dir (set at compile time)
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("docx-worker-aarch64-apple-darwin");
    if manifest_path.exists() {
        return Some(manifest_path);
    }

    None
}

fn execute_sidecar_sync(request_json: &str) -> Result<String, String> {
    let binary = find_docx_worker()
        .ok_or_else(|| "docx-worker binary not found. Check src-tauri/binaries/".to_string())?;

    // Write request to temp file
    let temp_path = std::env::temp_dir().join(format!(
        "docx-req-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));

    std::fs::write(&temp_path, request_json)
        .map_err(|e| format!("Failed to write request file: {}", e))?;

    let mut child = Command::new(&binary)
        .args(["--json", &temp_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn docx-worker at {}: {}", binary.display(), e))?;

    let timeout = std::time::Duration::from_secs(120);
    let start = std::time::Instant::now();
    let output = loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                break child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read docx-worker output: {}", e))?
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = std::fs::remove_file(&temp_path);
                    return Err("docx-worker timed out after 120 seconds".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!("Failed to wait for docx-worker: {}", e));
            }
        }
    };

    let _ = std::fs::remove_file(&temp_path);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if stdout.trim().is_empty() {
        return Err(format!(
            "docx-worker produced no output (exit code {:?}): {}",
            output.status.code(),
            if stderr.is_empty() {
                "no error"
            } else {
                stderr.trim()
            }
        ));
    }

    Ok(stdout)
}

#[tauri::command]
pub async fn docx_annotate(_app: tauri::AppHandle, request_json: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || execute_sidecar_sync(&request_json))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn docx_read_comments(_app: tauri::AppHandle, path: String) -> Result<String, String> {
    let request = serde_json::json!({
        "command": "read_comments",
        "inputPath": path
    })
    .to_string();
    tokio::task::spawn_blocking(move || execute_sidecar_sync(&request))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn docx_validate(_app: tauri::AppHandle, path: String) -> Result<String, String> {
    let request = serde_json::json!({
        "command": "validate",
        "inputPath": path
    })
    .to_string();
    tokio::task::spawn_blocking(move || execute_sidecar_sync(&request))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}
