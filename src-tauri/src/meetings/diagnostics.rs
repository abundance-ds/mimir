//! Privacy-bounded, per-meeting diagnostics for the realtime Scribe pipeline.
//!
//! These JSONL records intentionally omit transcript text, audio samples,
//! credentials, and provider URLs. They exist so a bundled application can be
//! diagnosed without relying on an attached terminal.

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const MAX_DIAGNOSTIC_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct ScribeDiagnostics {
    path: Option<PathBuf>,
    meeting_id: String,
}

impl ScribeDiagnostics {
    pub(crate) fn new(data_dir: &Path, meeting_id: &str) -> Self {
        Self {
            path: Some(data_dir.join(meeting_id).join("scribe-debug.jsonl")),
            meeting_id: meeting_id.to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self {
            path: None,
            meeting_id: "test-meeting".into(),
        }
    }

    pub(crate) fn record(&self, event: &str, fields: Value) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let Ok(_guard) = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= MAX_DIAGNOSTIC_BYTES) {
            let _ = fs::remove_file(path.with_extension("jsonl.previous"));
            let _ = fs::rename(path, path.with_extension("jsonl.previous"));
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options.mode(0o600);
        let Ok(mut file) = options.open(path) else {
            return;
        };
        let line = json!({
            "at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "meetingId": self.meeting_id.as_str(),
            "event": event,
            "fields": fields,
        });
        let _ = writeln!(file, "{line}");
    }
}
