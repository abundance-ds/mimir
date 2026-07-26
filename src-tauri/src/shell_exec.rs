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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tauri_prefix_is_sensitive_regardless_of_case() {
        assert!(is_sensitive_env_key("TAURI_PLATFORM"));
        assert!(is_sensitive_env_key("tauri_platform"));
        assert!(is_sensitive_env_key("Tauri_Env"));
    }

    #[test]
    fn tauri_is_a_prefix_match_not_a_substring_match() {
        // Only keys STARTING with TAURI_ are filtered by the prefix rule.
        assert!(!is_sensitive_env_key("XTAURI_SOMETHING"));
        assert!(!is_sensitive_env_key("MY_TAURI_VAR"));
        // Without the underscore the prefix rule does not apply.
        assert!(!is_sensitive_env_key("TAURI"));
        assert!(!is_sensitive_env_key("TAURIX"));
    }

    #[test]
    fn documented_patterns_are_sensitive_anywhere_in_the_key() {
        for key in [
            "API_KEY",
            "OPENAI_API_KEY",
            "MY_API_KEY_2",
            "SECRET",
            "APP_SECRET_VALUE",
            "TOKEN",
            "GITHUB_TOKEN",
            "PASSWORD",
            "DB_PASSWORD_FILE",
            "CREDENTIAL",
            "AWS_CREDENTIALS",
        ] {
            assert!(is_sensitive_env_key(key), "{key} should be filtered");
        }
    }

    #[test]
    fn pattern_matching_is_case_insensitive() {
        assert!(is_sensitive_env_key("my_api_key"));
        assert!(is_sensitive_env_key("Secret_Sauce"));
        assert!(is_sensitive_env_key("npm_token"));
        assert!(is_sensitive_env_key("password"));
        assert!(is_sensitive_env_key("gcloud_credential"));
    }

    #[test]
    fn substring_matching_filters_keys_that_merely_contain_a_pattern() {
        // Not secrets, but the substring rule filters them anyway; this
        // documents what the code does.
        assert!(is_sensitive_env_key("TOKENIZER_PATH"));
        assert!(is_sensitive_env_key("PASSWORDLESS_MODE"));
    }

    #[test]
    fn benign_keys_pass_through() {
        for key in ["PATH", "HOME", "LANG", "USER", "SHELL", "TMPDIR", "EDITOR"] {
            assert!(!is_sensitive_env_key(key), "{key} should pass");
        }
        // Pattern variants without the exact substring are NOT filtered;
        // documents the current gap (e.g. APIKEY without an underscore).
        assert!(!is_sensitive_env_key("APIKEY"));
        assert!(!is_sensitive_env_key("API-KEY"));
    }

    #[test]
    fn collect_safe_env_drops_sensitive_keys_and_keeps_benign_ones() {
        std::env::set_var("MIM_SHELL_EXEC_TEST_SECRET_PROBE", "must-not-leak");
        std::env::set_var("MIM_SHELL_EXEC_TEST_BENIGN_PROBE", "fine-to-pass");

        let env = collect_safe_env();
        assert!(
            !env.iter()
                .any(|(k, _)| k == "MIM_SHELL_EXEC_TEST_SECRET_PROBE"),
            "sensitive key leaked into safe env"
        );
        assert!(
            env.iter().any(|(k, v)| k == "MIM_SHELL_EXEC_TEST_BENIGN_PROBE"
                && v == "fine-to-pass"),
            "benign key missing from safe env"
        );
    }

    #[test]
    fn output_at_the_cap_is_untouched() {
        let out = truncate_output(vec![b'a'; 10], 10);
        assert_eq!(out, "a".repeat(10));
        assert!(!out.contains("[truncated]"));
    }

    #[test]
    fn output_over_the_cap_is_cut_and_marked() {
        let out = truncate_output(vec![b'a'; 11], 10);
        assert_eq!(out, format!("{}\n[truncated]", "a".repeat(10)));
    }

    #[test]
    fn invalid_utf8_under_the_cap_is_replaced_lossily() {
        let out = truncate_output(vec![0xFF, b'a'], 100);
        assert_eq!(out, "\u{FFFD}a");
    }

    // Documents a real bug: truncate_output slices the string at a raw byte
    // offset (`s[..max]`) without checking char boundaries, so output whose
    // multi-byte UTF-8 character straddles the cap panics the exec task.
    #[test]
    #[should_panic(expected = "char boundary")]
    fn truncation_panics_when_cap_splits_a_multibyte_char() {
        // "éé" is 4 bytes; byte 3 falls inside the second 'é'.
        truncate_output("éé".as_bytes().to_vec(), 3);
    }
}

#[cfg(all(test, unix))]
mod exec_tests {
    use super::*;

    fn run(command: &str, working_dir: Option<String>, timeout_ms: Option<u64>) -> ShellExecResult {
        tauri::async_runtime::block_on(shell_exec(command.to_string(), working_dir, timeout_ms))
            .expect("shell_exec should not error")
    }

    #[test]
    fn echo_returns_stdout_and_exit_code_zero() {
        let result = run("echo hello", None, None);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("hello"));
        assert!(!result.timed_out);
    }

    #[test]
    fn failing_commands_report_their_exit_code() {
        let result = run("exit 3", None, None);
        assert_eq!(result.exit_code, Some(3));
        assert!(!result.timed_out);
    }

    #[test]
    fn working_dir_is_respected() {
        let temp = tempfile::tempdir().unwrap();
        let expected = temp.path().canonicalize().unwrap();
        let result = run("pwd", Some(temp.path().to_string_lossy().into_owned()), None);
        assert_eq!(result.exit_code, Some(0));
        assert!(
            result.stdout.contains(expected.to_str().unwrap()),
            "stdout {:?} should contain {:?}",
            result.stdout,
            expected
        );
    }

    #[test]
    fn short_timeout_kills_a_sleeping_command() {
        let result = run("sleep 2", None, Some(100));
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
        assert!(result.duration_ms >= 100);
        // Well below the sleep itself and the default timeout.
        assert!(result.duration_ms < 10_000, "took {}ms", result.duration_ms);
    }

    #[test]
    fn zero_timeout_times_out_immediately() {
        let result = run("sleep 2", None, Some(0));
        assert!(result.timed_out);
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn timeouts_above_the_cap_are_clamped_without_breaking_execution() {
        // Requests far above MAX_TIMEOUT_MS are clamped via
        // `.min(MAX_TIMEOUT_MS)` before Duration conversion. The clamped value
        // itself is not observable without waiting 120s, so this verifies an
        // oversized request is accepted and the command still completes.
        let result = run("true", None, Some(u64::MAX));
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(result.duration_ms < MAX_TIMEOUT_MS);
    }

    #[test]
    fn oversized_output_is_truncated_to_the_cap_with_marker() {
        // NOTE (real bug, see report): shell_exec never drains the stdout pipe
        // while the child runs, so any command emitting more than the OS pipe
        // buffer (~64KB) blocks until the timeout fires; output is then
        // collected on the kill path because the orphaned pipeline writer
        // finishes once the parent starts reading. A short timeout keeps this
        // test fast; `timed_out == true` below is a symptom of that bug, not
        // desired behavior.
        let result = run("head -c 150000 /dev/zero | tr '\\0' a", None, Some(500));
        assert!(result.timed_out);
        assert!(
            result.stdout.ends_with("\n[truncated]"),
            "stdout should end with the truncation marker"
        );
        assert_eq!(result.stdout.len(), MAX_OUTPUT_BYTES + "\n[truncated]".len());
    }

    #[test]
    fn sensitive_env_vars_are_filtered_from_the_child_environment() {
        std::env::set_var("MIM_SHELL_EXEC_E2E_SECRET_PROBE", "must-not-leak");
        std::env::set_var("MIM_SHELL_EXEC_E2E_BENIGN_PROBE", "fine-to-pass");

        let result = run("env", None, None);
        assert_eq!(result.exit_code, Some(0));
        assert!(
            result
                .stdout
                .contains("MIM_SHELL_EXEC_E2E_BENIGN_PROBE=fine-to-pass"),
            "benign var should reach the child"
        );
        assert!(
            !result.stdout.contains("MIM_SHELL_EXEC_E2E_SECRET_PROBE"),
            "sensitive var name leaked to the child"
        );
        assert!(
            !result.stdout.contains("must-not-leak"),
            "sensitive var value leaked to the child"
        );
    }
}
