//! Lean meeting detection and microphone-consent primitives for Mimir.
//!
//! The crate observes process-level Core Audio state; it never captures or
//! retains audio. Detection only creates a local suggestion and can never
//! start recording.
//!
//! Portions of the behavior were adapted from Fastrepl Anarlog at commit
//! `08aad83f0c5cef1317d74a31519ae3190d726504` (MIT):
//! <https://github.com/fastrepl/anarlog>. The audited source paths and rejected
//! lifetime patterns are recorded in Mimir's Anarlog import manifest.

mod state;
mod worker;

#[cfg(target_os = "macos")]
mod macos;

pub use state::DetectionPolicy;
pub use worker::DetectionMonitor;

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_SELF_BUNDLE_ID: &str = "com.abundanceds.mimir";
const DEFAULT_SELF_APP_NAME: &str = "mimir";
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

const APP_FAMILIES: &[(&str, &str)] = &[
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.microsoft.teams", "Microsoft Teams"),
    ("com.google.chrome", "Google Chrome"),
    ("us.zoom.xos", "Zoom"),
];

#[derive(Debug, thiserror::Error)]
pub enum DetectError {
    #[error("meeting detection is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("invalid meeting detection configuration: {0}")]
    InvalidConfig(String),
    #[error("native meeting detection failed: {0}")]
    Native(String),
    #[error("meeting detection worker could not start: {0}")]
    WorkerStart(String),
    #[error("meeting detection worker did not initialize")]
    WorkerInitializationTimeout,
    #[error("meeting detection worker panicked during shutdown")]
    WorkerPanicked,
    #[error("meeting detection must use a non-decreasing monotonic clock")]
    MonotonicTimeRegression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    NotDetermined,
    Restricted,
    Denied,
    Granted,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub state: PermissionState,
    pub can_request: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl PermissionSnapshot {
    pub fn unsupported() -> Self {
        Self {
            state: PermissionState::Unavailable,
            can_request: false,
            remediation: Some(
                "Application-aware meeting detection is available only in the supported macOS build"
                    .into(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvidence {
    pub process_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub app_name: String,
}

impl AppEvidence {
    fn identity(&self) -> String {
        self.bundle_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            .unwrap_or_else(|| format!("pid:{}", self.process_id))
    }

    fn canonicalized(mut self) -> Self {
        let Some(bundle_id) = self.bundle_id.as_deref().map(str::trim) else {
            return self;
        };
        let normalized = bundle_id.to_ascii_lowercase();
        let helper_name = self.app_name.to_ascii_lowercase().contains("helper");
        for (family, display_name) in APP_FAMILIES {
            if normalized == *family {
                return self;
            }
            if helper_name && normalized.starts_with(&format!("{family}.")) {
                self.bundle_id = Some((*family).to_owned());
                self.app_name = (*display_name).to_owned();
                return self;
            }
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionCandidate {
    pub id: String,
    pub app_id: String,
    pub app_name: String,
    pub detected_at_millis: u64,
    pub confidence: f64,
    pub process_ids: Vec<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateEndReason {
    Inactive,
    Dismissed,
    DetectionDisabled,
    PermissionLost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DetectionEvent {
    CandidateSuggested(DetectionCandidate),
    CandidateEnded {
        candidate_id: String,
        reason: CandidateEndReason,
    },
}

#[derive(Debug, Clone)]
pub struct DetectionConfig {
    pub enabled: bool,
    pub sustained_use: Duration,
    pub absence_grace: Duration,
    pub cooldown: Duration,
    pub poll_interval: Duration,
    pub ignored_bundle_ids: BTreeSet<String>,
    pub self_bundle_ids: BTreeSet<String>,
    pub self_app_names: BTreeSet<String>,
}

impl Default for DetectionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sustained_use: Duration::from_secs(3),
            absence_grace: Duration::from_secs(1),
            cooldown: Duration::from_secs(30),
            poll_interval: Duration::from_secs(1),
            ignored_bundle_ids: BTreeSet::new(),
            self_bundle_ids: BTreeSet::from([DEFAULT_SELF_BUNDLE_ID.into()]),
            self_app_names: BTreeSet::from([DEFAULT_SELF_APP_NAME.into()]),
        }
    }
}

impl DetectionConfig {
    fn validate(&self) -> Result<(), DetectError> {
        if !(MIN_POLL_INTERVAL..=MAX_POLL_INTERVAL).contains(&self.poll_interval) {
            return Err(DetectError::InvalidConfig(format!(
                "poll interval must be between {} ms and {} ms",
                MIN_POLL_INTERVAL.as_millis(),
                MAX_POLL_INTERVAL.as_millis()
            )));
        }
        Ok(())
    }

    fn excludes(&self, app: &AppEvidence) -> bool {
        if app.process_id == std::process::id() as i32 {
            return true;
        }
        let bundle_id = app
            .bundle_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let app_name = app.app_name.trim().to_ascii_lowercase();

        contains_case_insensitive(&self.self_bundle_ids, &bundle_id)
            || contains_case_insensitive(&self.ignored_bundle_ids, &bundle_id)
            || contains_case_insensitive(&self.self_app_names, &app_name)
    }
}

fn contains_case_insensitive(values: &BTreeSet<String>, candidate: &str) -> bool {
    !candidate.is_empty()
        && values
            .iter()
            .any(|value| value.trim().eq_ignore_ascii_case(candidate))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetectorStatus {
    Healthy,
    Degraded,
    PermissionRequired,
    PermissionDenied,
    Disabled,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorSnapshot {
    pub permission: PermissionSnapshot,
    pub status: DetectorStatus,
    pub active_apps: Vec<AppEvidence>,
    pub candidates: Vec<DetectionCandidate>,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at_unix_millis: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

impl DetectorSnapshot {
    pub fn unsupported() -> Self {
        Self {
            permission: PermissionSnapshot::unsupported(),
            status: DetectorStatus::Unsupported,
            active_apps: Vec::new(),
            candidates: Vec::new(),
            generation: 0,
            observed_at_unix_millis: Some(unix_millis()),
            diagnostic: Some(
                "Core Audio application-aware microphone detection is unavailable on this platform"
                    .into(),
            ),
        }
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

/// Reads the current microphone authorization without prompting.
pub fn microphone_permission() -> PermissionSnapshot {
    #[cfg(target_os = "macos")]
    {
        macos::microphone_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionSnapshot::unsupported()
    }
}

/// Requests microphone authorization after a deliberate user action.
///
/// Callers must never invoke this from background detection or startup. If the
/// OS decision already exists, the callback is invoked immediately without
/// presenting another prompt.
pub fn request_microphone_permission(
    callback: impl FnOnce(PermissionSnapshot) + Send + 'static,
) -> Result<(), DetectError> {
    #[cfg(target_os = "macos")]
    {
        macos::request_microphone_permission(callback)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = callback;
        Err(DetectError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_projection_is_explicit_and_actionable() {
        let snapshot = DetectorSnapshot::unsupported();
        assert_eq!(snapshot.status, DetectorStatus::Unsupported);
        assert_eq!(snapshot.permission.state, PermissionState::Unavailable);
        assert!(snapshot.candidates.is_empty());
        assert!(snapshot.diagnostic.unwrap().contains("unavailable"));
    }
}
