use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, str::FromStr};

pub const TRACKER_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ActivityCategory {
    Work,
    Leisure,
    Break,
    #[serde(rename = "AFK")]
    Afk,
    #[serde(rename = "OFF")]
    Off,
    #[serde(rename = "UNKNOWN")]
    Unknown,
    Other,
}

impl ActivityCategory {
    pub const ALL: [Self; 7] = [
        Self::Work,
        Self::Leisure,
        Self::Break,
        Self::Afk,
        Self::Off,
        Self::Unknown,
        Self::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Work => "Work",
            Self::Leisure => "Leisure",
            Self::Break => "Break",
            Self::Afk => "AFK",
            Self::Off => "OFF",
            Self::Unknown => "UNKNOWN",
            Self::Other => "Other",
        }
    }
}

impl std::fmt::Display for ActivityCategory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ActivityCategory {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim() {
            "Work" => Ok(Self::Work),
            "Leisure" => Ok(Self::Leisure),
            "Break" => Ok(Self::Break),
            "AFK" | "Away" => Ok(Self::Afk),
            "OFF" | "Off" => Ok(Self::Off),
            "UNKNOWN" | "Unknown" => Ok(Self::Unknown),
            "Other" => Ok(Self::Other),
            other => Err(format!("Unknown tracker category '{other}'.")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrackerMode {
    Disabled,
    NeedsAccess,
    Paused,
    Armed,
    Break,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackerConfig {
    pub enabled: bool,
    pub armed: bool,
    pub launch_at_login: bool,
    pub collect_window_titles: bool,
    pub collect_browser_domains: bool,
    pub classification_enabled: bool,
    pub include_window_titles_in_ai: bool,
    pub nudges_enabled: bool,
    pub nudge_other: bool,
    pub poll_interval_seconds: u64,
    pub change_confirmation_seconds: u64,
    pub afk_threshold_seconds: u64,
    pub classification_batch_seconds: u64,
    pub classification_retry_seconds: u64,
    pub classification_model: String,
    pub nudge_model: String,
    pub daily_cost_cap_usd: f64,
    pub nudge_grace_minutes: u64,
    pub nudge_interval_minutes: u64,
    pub nudge_max_per_session: u32,
    pub lunch_start_minutes: u16,
    pub lunch_end_minutes: u16,
    pub deep_work_minutes: u64,
    pub earned_break_minutes: u64,
    pub end_of_day_minutes: u16,
    pub end_of_day_work_minutes: u64,
    pub timezone: String,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            armed: true,
            launch_at_login: true,
            collect_window_titles: true,
            collect_browser_domains: false,
            classification_enabled: true,
            include_window_titles_in_ai: false,
            nudges_enabled: true,
            nudge_other: false,
            poll_interval_seconds: 15,
            change_confirmation_seconds: 20,
            afk_threshold_seconds: 300,
            classification_batch_seconds: 300,
            classification_retry_seconds: 3600,
            classification_model: "auto".into(),
            nudge_model: "auto".into(),
            daily_cost_cap_usd: 1.0,
            nudge_grace_minutes: 5,
            nudge_interval_minutes: 5,
            nudge_max_per_session: 3,
            lunch_start_minutes: 12 * 60,
            lunch_end_minutes: 13 * 60 + 30,
            deep_work_minutes: 60,
            earned_break_minutes: 20,
            end_of_day_minutes: 17 * 60,
            end_of_day_work_minutes: 300,
            timezone: "Europe/Berlin".into(),
        }
    }
}

impl TrackerConfig {
    pub fn normalized(mut self) -> Self {
        self.poll_interval_seconds = self.poll_interval_seconds.clamp(5, 300);
        self.change_confirmation_seconds = self.change_confirmation_seconds.clamp(0, 300);
        self.afk_threshold_seconds = self.afk_threshold_seconds.clamp(60, 86_400);
        self.classification_batch_seconds = self.classification_batch_seconds.clamp(60, 86_400);
        self.classification_retry_seconds = self.classification_retry_seconds.clamp(60, 604_800);
        self.daily_cost_cap_usd = self.daily_cost_cap_usd.clamp(0.0, 100.0);
        self.nudge_grace_minutes = self.nudge_grace_minutes.clamp(0, 240);
        self.nudge_interval_minutes = self.nudge_interval_minutes.clamp(1, 240);
        self.nudge_max_per_session = self.nudge_max_per_session.min(20);
        self.lunch_start_minutes = self.lunch_start_minutes.min(24 * 60 - 1);
        self.lunch_end_minutes = self.lunch_end_minutes.min(24 * 60);
        self.deep_work_minutes = self.deep_work_minutes.clamp(1, 24 * 60);
        self.earned_break_minutes = self.earned_break_minutes.clamp(0, 240);
        self.end_of_day_minutes = self.end_of_day_minutes.min(24 * 60 - 1);
        self.end_of_day_work_minutes = self.end_of_day_work_minutes.clamp(0, 24 * 60);
        if self.classification_model.trim().is_empty() {
            self.classification_model = "auto".into();
        }
        if self.nudge_model.trim().is_empty() {
            self.nudge_model = "auto".into();
        }
        if self.timezone.trim().is_empty() || self.timezone.parse::<chrono_tz::Tz>().is_err() {
            self.timezone = "UTC".into();
        }
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub platform_supported: bool,
    pub accessibility: bool,
    pub accessibility_required: bool,
    pub browser_automation_enabled: bool,
    pub notifications: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub mode: TrackerMode,
    pub config: TrackerConfig,
    pub permissions: PermissionStatus,
    pub current: Option<ActivityBlock>,
    pub break_remaining_seconds: Option<i64>,
    pub queued_classifications: u64,
    pub today_cost_usd: f64,
    pub launch_at_login_active: bool,
    pub autostart_diagnostic: Option<String>,
    pub diagnostic: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub observed_at_ms: i64,
    pub idle_seconds: u64,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub domain: Option<String>,
    pub window_title: Option<String>,
    pub mimir_context: Option<String>,
}

impl Observation {
    pub fn classification_key(&self) -> String {
        let app = self
            .bundle_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.app_name.as_str())
            .trim();
        match self
            .domain
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(domain) => format!("{} | {}", app, domain.to_ascii_lowercase()),
            None => app.to_string(),
        }
    }

    pub fn activity_key(&self) -> String {
        if let Some(context) = self
            .mimir_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("{} | mimir:{}", self.classification_key(), context);
        }
        self.classification_key()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBlock {
    pub id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_seconds: i64,
    pub activity: ActivityCategory,
    pub subcategory: Option<String>,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub domain: Option<String>,
    pub window_title: Option<String>,
    pub classification_key: Option<String>,
    pub source: String,
    pub off_reason: Option<String>,
}

impl ActivityBlock {
    pub fn start(&self) -> Option<DateTime<Utc>> {
        DateTime::<Utc>::from_timestamp_millis(self.start_ms)
    }

    pub fn end(&self) -> Option<DateTime<Utc>> {
        DateTime::<Utc>::from_timestamp_millis(self.end_ms)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub key: String,
    pub activity: ActivityCategory,
    pub subcategory: Option<String>,
    pub classified_by: String,
    pub manual: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationUpdate {
    pub key: String,
    pub activity: ActivityCategory,
    pub subcategory: Option<String>,
    #[serde(default = "default_true")]
    pub apply_history: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgusImportRequest {
    pub source_directory: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationJob {
    pub key: String,
    pub app_name: String,
    pub domain: Option<String>,
    pub window_title: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub attempts: u32,
    pub retry_after_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerQuery {
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub categories: Vec<ActivityCategory>,
    pub search: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub blocks: Vec<ActivityBlock>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationBucket {
    pub key: String,
    pub label: String,
    pub seconds: i64,
    pub activity: Option<ActivityCategory>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    pub date: String,
    pub totals: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell {
    pub weekday: u32,
    pub hour: u32,
    pub seconds: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerReport {
    pub start_ms: i64,
    pub end_ms: i64,
    pub totals: BTreeMap<String, i64>,
    pub total_tracked_seconds: i64,
    pub work_leisure_ratio: Option<f64>,
    pub longest_work_streak_seconds: i64,
    pub top_apps: Vec<DurationBucket>,
    pub subcategories: Vec<DurationBucket>,
    pub days: Vec<DailyBucket>,
    pub heatmap: Vec<HeatCell>,
    pub total_blocks: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub source_directory: String,
    pub source_hash: String,
    pub imported_blocks: u64,
    pub skipped_zero_blocks: u64,
    pub skipped_invalid_blocks: u64,
    pub imported_classifications: u64,
    pub already_imported: bool,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub source_directory: String,
    pub activities_found: bool,
    pub classifications_found: bool,
    pub total_blocks: u64,
    pub total_classifications: u64,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub source_hash: String,
    pub already_imported: bool,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub break_started_ms: Option<i64>,
    pub break_end_ms: Option<i64>,
    pub break_duration_minutes: Option<u64>,
    pub last_shutdown_ms: Option<i64>,
}

fn default_true() -> bool {
    true
}
