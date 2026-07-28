use serde::Serialize;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAX_OUTPUT_BYTES: usize = 100_000;
// Keep a little extra beyond the cap so truncate_output can distinguish
// output that merely reached the cap from output that exceeded it (and thus
// needs the marker). Drain threads keep reading to EOF past this either way.
const OUTPUT_SLACK_BYTES: usize = 4 * 1024;
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
    for pattern in &[
        "API_KEY",
        "APIKEY",
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "CREDENTIAL",
    ] {
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
        // Cut at the largest char boundary at or below the cap; a raw
        // `s[..max]` panics when a multi-byte character straddles it (lossy
        // conversion of binary output emits 3-byte U+FFFD chars, which makes
        // straddling the likely case, not a rare one).
        let cut = s.floor_char_boundary(max);
        let mut truncated = s[..cut].to_string();
        truncated.push_str("\n[truncated]");
        truncated
    }
}

/// Reads a child pipe to EOF on a dedicated thread, keeping at most
/// `MAX_OUTPUT_BYTES + OUTPUT_SLACK_BYTES`. Draining must continue past the
/// cap: if the pipe fills (~64KB), the child blocks on write and never exits,
/// which previously turned any large-output command into a false timeout.
fn drain_pipe<R: Read + Send + 'static>(pipe: Option<R>) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut collected = Vec::new();
        let Some(mut pipe) = pipe else {
            return collected;
        };
        let cap = MAX_OUTPUT_BYTES + OUTPUT_SLACK_BYTES;
        let mut buf = [0u8; 8 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => return collected,
                Ok(n) => {
                    let room = cap.saturating_sub(collected.len());
                    collected.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    })
}

/// Kills the child's entire process group (the child is spawned as group
/// leader via `process_group(0)`), so pipeline members die with it instead of
/// being orphaned holding the pipes open. `libc` is not a declared dependency
/// of this crate, so the group signal goes through the `kill` binary; "--"
/// keeps the negative (group) pid from being parsed as an option.
#[cfg(unix)]
fn kill_child(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-9", "--"])
        .arg(format!("-{}", child.id()))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    // Direct kill as a fallback so the leader is dead even if the group
    // signal failed; harmless no-op otherwise.
    let _ = child.kill();
}

#[cfg(not(unix))]
fn kill_child(child: &mut Child) {
    let _ = child.kill();
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
            use std::os::unix::process::CommandExt;
            Command::new("/bin/bash")
                .args(["-lc", &command])
                .current_dir(&cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear()
                .envs(safe_env)
                // Own process group, so a timeout can kill the whole pipeline
                // rather than just the shell.
                .process_group(0)
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

        // Drain both pipes concurrently while waiting; if they are left until
        // after exit, output beyond the OS pipe buffer blocks the child
        // forever and every large-output command becomes a false timeout.
        let stdout_drain = drain_pipe(child.stdout.take());
        let stderr_drain = drain_pipe(child.stderr.take());

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let duration_ms = start.elapsed().as_millis() as u64;
                    let stdout_bytes = stdout_drain.join().unwrap_or_default();
                    let stderr_bytes = stderr_drain.join().unwrap_or_default();

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
                        kill_child(&mut child);
                        let _ = child.wait();

                        // The group kill closed every writer, so the drains
                        // reach EOF promptly with whatever was emitted.
                        let stdout_bytes = stdout_drain.join().unwrap_or_default();
                        let stderr_bytes = stderr_drain.join().unwrap_or_default();

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
            "APIKEY",
            "MY_APIKEY",
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
        assert!(is_sensitive_env_key("my_apikey"));
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
        // APIKEY (no underscore) is covered by its own marker. API-KEY is
        // deliberately NOT matched: hyphens are invalid in portable env var
        // names, so no real environment variable can carry that name.
        assert!(is_sensitive_env_key("APIKEY"));
        assert!(!is_sensitive_env_key("API-KEY"));
    }

    #[test]
    fn collect_safe_env_drops_sensitive_keys_and_keeps_benign_ones() {
        std::env::set_var("MIMIR_SHELL_EXEC_TEST_SECRET_PROBE", "must-not-leak");
        std::env::set_var("MIMIR_SHELL_EXEC_TEST_BENIGN_PROBE", "fine-to-pass");

        let env = collect_safe_env();
        assert!(
            !env.iter()
                .any(|(k, _)| k == "MIMIR_SHELL_EXEC_TEST_SECRET_PROBE"),
            "sensitive key leaked into safe env"
        );
        assert!(
            env.iter()
                .any(|(k, v)| k == "MIMIR_SHELL_EXEC_TEST_BENIGN_PROBE" && v == "fine-to-pass"),
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

    // Regression test: truncate_output used to slice at a raw byte offset
    // (`s[..max]`), panicking whenever a multi-byte UTF-8 character straddled
    // the cap. The cut now backs up to the nearest char boundary.
    #[test]
    fn truncation_backs_up_to_a_char_boundary_when_cap_splits_a_multibyte_char() {
        // "éé" is 4 bytes; byte 3 falls inside the second 'é', so the cut
        // lands after the first one.
        let out = truncate_output("éé".as_bytes().to_vec(), 3);
        assert_eq!(out, "é\n[truncated]");
    }

    #[test]
    fn truncation_of_lossy_binary_output_is_boundary_safe() {
        // Invalid bytes become 3-byte U+FFFD chars, so a cap that is not a
        // multiple of 3 lands mid-char and must back up cleanly.
        let out = truncate_output(vec![0xFF; 8], 7);
        assert_eq!(out, format!("{}\n[truncated]", "\u{FFFD}".repeat(2)));
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
        let result = run(
            "pwd",
            Some(temp.path().to_string_lossy().into_owned()),
            None,
        );
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
        // The pipes are drained while the child runs, so output beyond the OS
        // pipe buffer no longer blocks the child: the command exits normally
        // and truncation happens on the regular exit path.
        let result = run("head -c 150000 /dev/zero | tr '\\0' a", None, None);
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(
            result.stdout.ends_with("\n[truncated]"),
            "stdout should end with the truncation marker"
        );
        assert_eq!(
            result.stdout.len(),
            MAX_OUTPUT_BYTES + "\n[truncated]".len()
        );
    }

    #[test]
    fn large_output_completes_promptly_without_a_false_timeout() {
        // ~200KB is several times the ~64KB OS pipe buffer; without the
        // concurrent drain this would block until the 30s default timeout.
        let result = run("head -c 200000 /dev/zero | tr '\\0' b", None, None);
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(
            result.duration_ms < 5_000,
            "expected prompt completion, took {}ms",
            result.duration_ms
        );
    }

    #[test]
    fn sensitive_env_vars_are_filtered_from_the_child_environment() {
        std::env::set_var("MIMIR_SHELL_EXEC_E2E_SECRET_PROBE", "must-not-leak");
        std::env::set_var("MIMIR_SHELL_EXEC_E2E_BENIGN_PROBE", "fine-to-pass");

        let result = run("env", None, None);
        assert_eq!(result.exit_code, Some(0));
        assert!(
            result
                .stdout
                .contains("MIMIR_SHELL_EXEC_E2E_BENIGN_PROBE=fine-to-pass"),
            "benign var should reach the child"
        );
        assert!(
            !result.stdout.contains("MIMIR_SHELL_EXEC_E2E_SECRET_PROBE"),
            "sensitive var name leaked to the child"
        );
        assert!(
            !result.stdout.contains("must-not-leak"),
            "sensitive var value leaked to the child"
        );
    }
}
