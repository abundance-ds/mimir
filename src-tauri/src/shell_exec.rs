use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_OUTPUT_BYTES: usize = 100_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Serialize)]
pub struct ShellExecResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_uppercase();
    if upper.starts_with("TAURI_") {
        return true;
    }
    for pattern in &["API_KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL"] {
        if upper.contains(pattern) {
            return true;
        }
    }
    false
}

fn collect_safe_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| !is_sensitive_env_key(k))
        .collect()
}

fn truncate_output(bytes: Vec<u8>, max: usize) -> String {
    let s = String::from_utf8_lossy(&bytes);
    if s.len() <= max {
        s.into_owned()
    } else {
        let mut truncated = s[..max].to_string();
        truncated.push_str("\n[truncated]");
        truncated
    }
}

#[tauri::command]
pub async fn shell_exec(
    command: String,
    working_dir: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ShellExecResult, String> {
    let timeout =
        Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
    let safe_env = collect_safe_env();

    tokio::task::spawn_blocking(move || {
        let cwd = working_dir.unwrap_or_else(|| ".".to_string());

        #[cfg(not(target_os = "windows"))]
        let mut child = {
            Command::new("/bin/bash")
                .args(["-lc", &command])
                .current_dir(&cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear()
                .envs(safe_env)
                .spawn()
                .map_err(|e| format!("Failed to spawn command: {}", e))?
        };

        #[cfg(target_os = "windows")]
        let mut child = {
            Command::new("cmd.exe")
                .args(["/C", &command])
                .current_dir(&cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear()
                .envs(safe_env)
                .spawn()
                .map_err(|e| format!("Failed to spawn command: {}", e))?
        };

        let start = Instant::now();

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let duration_ms = start.elapsed().as_millis() as u64;

                    let mut stdout_bytes = Vec::new();
                    let mut stderr_bytes = Vec::new();
                    if let Some(mut out) = child.stdout.take() {
                        let _ = out.read_to_end(&mut stdout_bytes);
                    }
                    if let Some(mut err) = child.stderr.take() {
                        let _ = err.read_to_end(&mut stderr_bytes);
                    }

                    return Ok(ShellExecResult {
                        exit_code: status.code(),
                        stdout: truncate_output(stdout_bytes, MAX_OUTPUT_BYTES),
                        stderr: truncate_output(stderr_bytes, MAX_OUTPUT_BYTES),
                        timed_out: false,
                        duration_ms,
                    });
                }
                Ok(None) => {
                    if start.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();

                        let mut stdout_bytes = Vec::new();
                        let mut stderr_bytes = Vec::new();
                        if let Some(mut out) = child.stdout.take() {
                            let _ = out.read_to_end(&mut stdout_bytes);
                        }
                        if let Some(mut err) = child.stderr.take() {
                            let _ = err.read_to_end(&mut stderr_bytes);
                        }

                        return Ok(ShellExecResult {
                            exit_code: None,
                            stdout: truncate_output(stdout_bytes, MAX_OUTPUT_BYTES),
                            stderr: truncate_output(stderr_bytes, MAX_OUTPUT_BYTES),
                            timed_out: true,
                            duration_ms: start.elapsed().as_millis() as u64,
                        });
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(format!("Failed to wait for command: {}", e));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
