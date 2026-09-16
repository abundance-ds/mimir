//! Native meeting orchestration.
//!
//! `MeetingStore` remains the durable authority. Capture, transcription,
//! settings/content projection, artifacts, time, and renderer notification are
//! injected ports so the lifecycle can be tested without pretending that a
//! browser mock exercised an audio device or provider.

use super::store::{
    MeetingListCursor as StoreMeetingListCursor, TranscriptPageCursor as StoreTranscriptPageCursor,
    MAX_TRANSCRIPT_PAGE_SEGMENTS,
};
use super::{
    AudioChannelDraft, AudioChannelKind, FollowUpJob, FollowUpJobDraft, FollowUpJobKind, JobFinish,
    JobState, MeetingDeletionMode as StoreDeletionMode, MeetingDeletionStage, MeetingDraft,
    MeetingFailure, MeetingOrigin, MeetingRecord, MeetingStatus, MeetingStore, MeetingStoreError,
    RecoveryReport, TranscriptBatch, TranscriptGapRecord, TranscriptSegmentRecord,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, Weak,
    },
};
use thiserror::Error;
use uuid::Uuid;

mod api;
mod capture_ops;
mod followups;
mod library;
mod platform_ops;
mod ports;
mod start;
mod transcription_ops;
mod views;

pub use api::*;
use api::{
    DEFAULT_JOB_ATTEMPTS, DEFAULT_MEETING_LIMIT, MAX_LIBRARY_GAPS, MAX_SUMMARY_PREVIEW_CHARS,
};
pub use ports::*;
pub use views::*;

#[derive(Debug, Clone)]
struct ActiveCapture {
    meeting_id: String,
    run_id: String,
    request_key: Option<String>,
    mic_muted: bool,
    transcription: String,
    duration_ms: u64,
    recording_started_at: String,
}

struct MeetingRuntimeInner {
    store: Arc<MeetingStore>,
    capture: Arc<dyn MeetingCapturePort>,
    transcription: Arc<dyn MeetingTranscriptionPort>,
    platform: Arc<dyn MeetingPlatformPort>,
    clock: Arc<dyn MeetingClock>,
    events: Arc<dyn MeetingEventSink>,
    operation: Mutex<()>,
    active: Mutex<Option<ActiveCapture>>,
    revision: AtomicU64,
    diagnostic: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct MeetingRuntime {
    inner: Arc<MeetingRuntimeInner>,
}

struct WeakMeetingRuntime {
    inner: Weak<MeetingRuntimeInner>,
}

impl MeetingCaptureFailureSink for MeetingRuntime {
    fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str) {
        if let Err(error) = self.handle_capture_failure(meeting_id, run_id, message) {
            log::error!(
                "Could not durably reconcile failed Scribe capture '{meeting_id}' ({run_id}): {error}"
            );
            let _ = self.set_diagnostic(format!(
                "Scribe capture failed and needs restart recovery: {}",
                bounded_error(message)
            ));
        }
    }
}

impl MeetingCaptureFailureSink for WeakMeetingRuntime {
    fn capture_failed(&self, meeting_id: &str, run_id: &str, message: &str) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        MeetingCaptureFailureSink::capture_failed(
            &MeetingRuntime { inner },
            meeting_id,
            run_id,
            message,
        );
    }
}

fn capture_channels(permissions: &MeetingPermissions) -> Vec<AudioChannelDraft> {
    let mut channels = vec![AudioChannelDraft {
        id: "microphone".into(),
        kind: AudioChannelKind::Microphone,
        sample_rate_hz: 16_000,
        channels: 1,
        sample_format: "f32le".into(),
        device_id: None,
    }];
    if !matches!(
        permissions.system_audio.as_str(),
        "denied" | "restricted" | "unavailable"
    ) {
        channels.push(AudioChannelDraft {
            id: "system".into(),
            kind: AudioChannelKind::System,
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: "f32le".into(),
            device_id: None,
        });
    }
    channels
}

fn prepared_channels() -> Vec<AudioChannelDraft> {
    vec![
        AudioChannelDraft {
            id: "microphone".into(),
            kind: AudioChannelKind::Microphone,
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: "f32le".into(),
            device_id: None,
        },
        AudioChannelDraft {
            id: "system".into(),
            kind: AudioChannelKind::System,
            sample_rate_hz: 16_000,
            channels: 1,
            sample_format: "f32le".into(),
            device_id: None,
        },
    ]
}

fn transcription_route(config: &MeetingConfig) -> (String, String) {
    if config.transcription_mode == "custom" {
        (config.custom_url.clone(), config.custom_model.clone())
    } else {
        ("local".into(), config.local_model.clone())
    }
}

fn consent_context_for_projection(
    projection: &MeetingPlatformProjection,
    candidate_id: Option<&str>,
    continue_meeting_id: Option<&str>,
) -> Result<MeetingStartConsentContext, MeetingRuntimeError> {
    if candidate_id.is_some() && continue_meeting_id.is_some() {
        return Err(MeetingRuntimeError::Validation(
            "a detected meeting and a completed meeting cannot be recorded in one start request"
                .into(),
        ));
    }
    let candidate = match candidate_id {
        Some(candidate_id) => Some(
            projection
                .candidates
                .iter()
                .find(|candidate| candidate.id == candidate_id)
                .ok_or_else(|| {
                    MeetingRuntimeError::Validation(
                        "the selected meeting candidate is no longer available".into(),
                    )
                })?,
        ),
        None => None,
    };
    let (destination, model) = if projection.config.transcription_mode == "custom" {
        (
            Some(projection.config.custom_url.clone()),
            projection.config.custom_model.clone(),
        )
    } else {
        (None, projection.config.local_model.clone())
    };
    Ok(MeetingStartConsentContext {
        candidate_id: candidate.map(|value| value.id.clone()),
        candidate_app_id: candidate.map(|value| value.app_id.clone()),
        candidate_app_name: candidate.map(|value| value.app_name.clone()),
        continue_meeting_id: continue_meeting_id.map(str::to_string),
        transcription_mode: projection.config.transcription_mode.clone(),
        destination,
        model,
    })
}

fn validate_config(config: &MeetingConfig) -> Result<(), MeetingRuntimeError> {
    require_summary_template(&config.summary_template)?;
    require_summary_prompt(&config.summary_prompt)?;
    match config.transcription_mode.as_str() {
        "local" => require_nonempty(&config.local_model, "local transcription model"),
        "custom" => {
            require_nonempty(&config.custom_url, "custom transcription URL")?;
            require_nonempty(&config.custom_model, "custom transcription model")?;
            if !config.custom_url.starts_with("https://") {
                return Err(MeetingRuntimeError::Validation(
                    "custom transcription URL must use HTTPS".into(),
                ));
            }
            if !config.api_key_configured {
                return Err(MeetingRuntimeError::Validation(
                    "custom hosted transcription requires a configured native credential".into(),
                ));
            }
            Ok(())
        }
        _ => Err(MeetingRuntimeError::Validation(
            "transcription mode must be local or custom".into(),
        )),
    }
}

fn validate_config_patch(patch: &MeetingConfigPatch) -> Result<(), MeetingRuntimeError> {
    if let Some(Some(device_id)) = &patch.microphone_device_id {
        validate_microphone_device_id(device_id).map_err(MeetingRuntimeError::Validation)?;
    }
    if let Some(template) = &patch.summary_template {
        require_summary_template(template)?;
    }
    if let Some(prompt) = &patch.summary_prompt {
        require_summary_prompt(prompt)?;
    }
    if let Some(mode) = &patch.transcription_mode {
        if !matches!(mode.as_str(), "local" | "custom") {
            return Err(MeetingRuntimeError::Validation(
                "transcription mode must be local or custom".into(),
            ));
        }
    }
    if let Some(behavior) = &patch.kg_prompt {
        if !matches!(behavior.as_str(), "ask" | "always-draft" | "never") {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up must be ask, always-draft, or never".into(),
            ));
        }
    }
    if let Some(model) = &patch.local_model {
        require_nonempty(model, "local transcription model")?;
    }
    Ok(())
}

pub(crate) fn validate_microphone_device_id(value: &str) -> Result<(), String> {
    if value.trim() != value || value.is_empty() {
        return Err("microphone device identity cannot be empty or padded".into());
    }
    if value.len() > 1_024 {
        return Err("microphone device identity is too long".into());
    }
    if value.chars().any(char::is_control) {
        return Err("microphone device identity contains control characters".into());
    }
    Ok(())
}

fn require_summary_template(value: &str) -> Result<(), MeetingRuntimeError> {
    summary_template_instructions(value).ok_or_else(|| {
        MeetingRuntimeError::Validation(
            "summary format must be standard, brief, decisions-actions, or detailed".into(),
        )
    })?;
    Ok(())
}

fn require_summary_preset(value: &str) -> Result<(), MeetingRuntimeError> {
    if value.len() > 200 || value.chars().any(char::is_control) || value.trim() != value {
        return Err(MeetingRuntimeError::Validation(
            "summary CLI agent preset is invalid".into(),
        ));
    }
    Ok(())
}

pub(crate) fn summary_template_instructions(value: &str) -> Option<&'static str> {
    static PROMPTS: OnceLock<HashMap<String, String>> = OnceLock::new();
    PROMPTS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../resources/meeting-summary-prompts.json"))
                .expect("bundled meeting summary prompts must be valid")
        })
        .get(value)
        .map(String::as_str)
}

pub(crate) fn default_summary_prompt() -> String {
    summary_template_instructions("standard")
        .expect("standard summary instructions must exist")
        .into()
}

pub(crate) fn require_summary_prompt(value: &str) -> Result<(), MeetingRuntimeError> {
    if value.trim().is_empty() {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions cannot be empty".into(),
        ));
    }
    if value.chars().count() > 16_000 {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions exceed 16000 characters".into(),
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(MeetingRuntimeError::Validation(
            "summary instructions contain unsupported control characters".into(),
        ));
    }
    Ok(())
}

fn validate_update_patch(patch: &MeetingUpdatePatch) -> Result<(), MeetingRuntimeError> {
    if let Some(title) = patch.title.as_ref().or(patch.generated_title.as_ref()) {
        require_nonempty(title, "meeting title")?;
        if title.chars().count() > 512 {
            return Err(MeetingRuntimeError::Validation(
                "meeting title exceeds 512 characters".into(),
            ));
        }
    }
    if patch
        .notes
        .as_ref()
        .is_some_and(|notes| notes.len() > 4 * 1024 * 1024 || notes.contains('\0'))
    {
        return Err(MeetingRuntimeError::Validation(
            "meeting notes exceed the 4 MiB safety limit or contain invalid text".into(),
        ));
    }
    if patch.graph_node_id.as_ref().is_some_and(|id| {
        id.trim().is_empty() || id.len() > 120 || id.chars().any(|character| character.is_control())
    }) {
        return Err(MeetingRuntimeError::Validation(
            "linked Graph meeting id is invalid".into(),
        ));
    }
    if let Some(graph_draft) = &patch.graph_draft {
        validate_graph_draft(graph_draft)?;
    }
    if let Some(tags) = &patch.tags {
        if tags.len() > 64
            || tags.iter().any(|tag| {
                tag.trim().is_empty()
                    || tag.chars().count() > 80
                    || tag.len() > 160
                    || tag.chars().any(char::is_control)
            })
        {
            return Err(MeetingRuntimeError::Validation(
                "meeting tags must contain at most 64 values of 1 to 80 characters and 160 UTF-8 bytes"
                    .into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_graph_draft(
    graph_draft: &MeetingGraphDraft,
) -> Result<(), MeetingRuntimeError> {
    if !graph_draft.project_resolved && graph_draft.project_id.is_some() {
        return Err(MeetingRuntimeError::Validation(
            "an unresolved meeting project cannot have a Project id".into(),
        ));
    }
    let mut ids = Vec::new();
    if let Some(id) = &graph_draft.project_id {
        ids.push(("meeting Project id", id));
    }
    if let Some(id) = &graph_draft.scope_id {
        ids.push(("meeting scope id", id));
    }
    ids.extend(
        graph_draft
            .people_ids
            .iter()
            .map(|id| ("meeting Person id", id)),
    );
    if graph_draft.people_ids.len() > 100
        || ids.iter().any(|(_, id)| {
            id.trim().is_empty()
                || id.len() > 200
                || id.chars().any(|character| character.is_control())
        })
    {
        return Err(MeetingRuntimeError::Validation(
            "meeting Graph context contains an invalid id".into(),
        ));
    }
    let mut unique = std::collections::BTreeSet::new();
    if graph_draft
        .people_ids
        .iter()
        .any(|id| !unique.insert(id.trim()))
    {
        return Err(MeetingRuntimeError::Validation(
            "meeting People must be unique".into(),
        ));
    }
    Ok(())
}

fn stable_start_key(request: &StartMeetingRequest) -> Option<String> {
    request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("request:{value}"))
        .or_else(|| {
            request
                .candidate_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("candidate:{value}"))
        })
        .or_else(|| {
            request
                .continue_meeting_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("continue:{value}"))
        })
        .or_else(|| {
            Some(format!(
                "request-shape:{}\u{1f}{}",
                request.title.as_deref().unwrap_or("").trim(),
                request.workspace_path.as_deref().unwrap_or("").trim(),
            ))
        })
}

fn lifecycle(status: MeetingStatus) -> &'static str {
    match status {
        MeetingStatus::Detected => "arming",
        MeetingStatus::Recording => "capturing",
        MeetingStatus::Stopping => "stopping",
        MeetingStatus::Finalizing => "finalizing",
        MeetingStatus::Completed => "ready",
        MeetingStatus::Interrupted => "interrupted",
        MeetingStatus::Failed => "failed",
        MeetingStatus::Discarded => "discarded",
    }
}

fn duration_ms(meeting: &MeetingRecord) -> u64 {
    let Some(started_at) = meeting.started_at.as_deref().and_then(parse_timestamp) else {
        return 0;
    };
    let ended_at = meeting
        .stopped_at
        .as_deref()
        .and_then(parse_timestamp)
        .or_else(|| meeting.finalized_at.as_deref().and_then(parse_timestamp))
        .unwrap_or(started_at);
    ended_at
        .signed_duration_since(started_at)
        .num_milliseconds()
        .max(0) as u64
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn segment_view(
    record: &TranscriptSegmentRecord,
    channel_names: &HashMap<&str, String>,
) -> MeetingSegmentView {
    MeetingSegmentView {
        id: record.segment.id.clone(),
        text: record.segment.text.clone(),
        start_ms: record.segment.start_ms.max(0) as u64,
        end_ms: record.segment.end_ms.max(0) as u64,
        channel: record
            .segment
            .channel_id
            .as_deref()
            .and_then(|id| channel_names.get(id))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        speaker: record.segment.speaker.clone(),
        is_final: record.segment.is_final,
        revision: record.updated_revision,
    }
}

fn gap_view(record: &TranscriptGapRecord, channel_names: &HashMap<&str, String>) -> MeetingGapView {
    MeetingGapView {
        channel: record
            .gap
            .channel_id
            .as_deref()
            .and_then(|id| channel_names.get(id))
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        start_ms: record.gap.start_ms.max(0) as u64,
        end_ms: record.gap.end_ms.max(0) as u64,
        reason: record.gap.reason.to_string(),
    }
}

fn job_view(job: &FollowUpJob) -> MeetingJobView {
    MeetingJobView {
        id: job.definition.id.clone(),
        kind: renderer_job_kind(&job.definition.kind),
        status: job.state.to_string(),
        activity_id: job
            .result
            .as_ref()
            .and_then(|result| result.get("activityId"))
            .or_else(|| job.definition.payload.get("activityId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        attempt: job.attempts,
        error: job.last_error.clone(),
    }
}

fn renderer_job_kind(kind: &FollowUpJobKind) -> String {
    match kind {
        FollowUpJobKind::Summary => "title-summary".into(),
        FollowUpJobKind::KnowledgeGraph => "kg-proposal".into(),
        FollowUpJobKind::Custom(name) => name.clone(),
    }
}

fn parse_renderer_job_kind(value: &str) -> Result<FollowUpJobKind, MeetingRuntimeError> {
    match value {
        "title-summary" => Ok(FollowUpJobKind::Summary),
        "kg-proposal" => Ok(FollowUpJobKind::KnowledgeGraph),
        "transcription" => Ok(FollowUpJobKind::Custom("transcription".into())),
        _ => Err(MeetingRuntimeError::Validation(
            "job kind must be title-summary, kg-proposal, or transcription".into(),
        )),
    }
}

fn summary_state(jobs: &[FollowUpJob]) -> String {
    jobs.iter()
        .rev()
        .find(|job| job.definition.kind == FollowUpJobKind::Summary)
        .map(|job| match job.state {
            JobState::Pending => "queued",
            JobState::Running => "running",
            JobState::Succeeded => "succeeded",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        })
        .unwrap_or("not-started")
        .into()
}

fn successful_summary(jobs: &[FollowUpJob], field: &str) -> Option<String> {
    jobs.iter()
        .rev()
        .find(|job| {
            job.definition.kind == FollowUpJobKind::Summary && job.state == JobState::Succeeded
        })
        .and_then(|job| job.result.as_ref())
        .and_then(|result| result.get(field))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn summary_preview(summary: Option<&str>) -> (Option<String>, bool) {
    let Some(summary) = summary else {
        return (None, false);
    };
    let mut characters = summary.chars();
    let preview = characters
        .by_ref()
        .take(MAX_SUMMARY_PREVIEW_CHARS)
        .collect::<String>();
    let truncated = characters.next().is_some();
    (Some(preview), truncated)
}

fn kg_state(
    jobs: &[FollowUpJob],
    summary_state: &str,
    decision: Option<&str>,
    config_behavior: &str,
) -> String {
    if let Some(job) = jobs
        .iter()
        .rev()
        .find(|job| job.definition.kind == FollowUpJobKind::KnowledgeGraph)
    {
        return match job.state {
            JobState::Pending => "draft-queued",
            JobState::Running => "draft-running",
            JobState::Succeeded => "draft-ready",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
        .into();
    }
    match decision {
        Some("not-now") => "not-now".into(),
        Some("never") => "never".into(),
        Some("create-draft") => "draft-queued".into(),
        _ if summary_state == "succeeded" && config_behavior == "ask" => "awaiting-decision".into(),
        _ => "not-offered".into(),
    }
}

fn require_nonempty(value: &str, label: &str) -> Result<(), MeetingRuntimeError> {
    if value.trim().is_empty() {
        return Err(MeetingRuntimeError::Validation(format!(
            "{label} cannot be empty"
        )));
    }
    Ok(())
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn port_error(operation: &'static str, message: String) -> MeetingRuntimeError {
    MeetingRuntimeError::Port {
        operation,
        message: bounded_error(&message),
    }
}

fn bounded_error(value: &str) -> String {
    value.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests;
