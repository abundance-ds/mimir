//! Read-mostly public projection of meetings recorded by Mimir Scribe.
//!
//! Recording controls intentionally do not exist here. Mimir's loopback MCP
//! endpoint is trusted-local but unauthenticated, so exporting start/stop would
//! let every local process exercise Mimir's microphone grant.

use super::runtime::{
    MeetingLibraryCursor, MeetingRuntime, MeetingSnapshot, MeetingUpdatePatch, MeetingView,
};
use crate::tool_registry::{
    ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner, ToolRegistration,
    ToolRegistry, ToolResult, ToolSource,
};
use serde_json::{json, Map, Value};
use tauri::Manager;

const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 100;
const DEFAULT_TRANSCRIPT_LIMIT: usize = 100;
const MAX_TRANSCRIPT_LIMIT: usize = 250;
const MAX_QUERY_BYTES: usize = 512;

pub(crate) fn register_native_tools(
    registry: &ToolRegistry,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    for (canonical, alias, description, schema) in definitions() {
        let app = app.clone();
        let dispatch = canonical.to_string();
        let registration = ToolRegistration::new(
            ToolDescriptor::new(
                canonical,
                alias,
                description,
                schema,
                ToolOwner::Core,
                ToolSource::Native,
            ),
            move |_context: ToolCallContext, input: Value| {
                let app = app.clone();
                let dispatch = dispatch.clone();
                async move {
                    let runtime = app.state::<MeetingRuntime>();
                    execute(&runtime, &dispatch, input).map(ToolResult::new)
                }
            },
        );
        registry
            .register(registration)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn execute(runtime: &MeetingRuntime, action: &str, input: Value) -> Result<Value, ToolError> {
    match action {
        "meetings.list" => {
            let before = optional_library_cursor(&input)?;
            let limit = bounded_limit(
                input.get("limit").and_then(Value::as_u64),
                DEFAULT_LIST_LIMIT,
                MAX_LIST_LIMIT,
            )?;
            let page = runtime
                .library_page(before, Some(limit as u32))
                .map_err(runtime_error)?;
            list_page_projection(
                &page.meetings,
                page.has_more,
                page.next_before,
                runtime.revision(),
            )
        }
        "meetings.get" => {
            let meeting_id = required_string(&input, "meeting_id")?;
            let meeting = runtime.meeting(meeting_id).map_err(runtime_error)?;
            get_projection(
                runtime,
                &meeting,
                meeting_id,
                input
                    .get("transcript_offset")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                input.get("transcript_limit").and_then(Value::as_u64),
            )
        }
        "meetings.search" => {
            let query = required_string(&input, "query")?;
            validate_search_query(query)?;
            let snapshot = runtime.snapshot().map_err(runtime_error)?;
            search_projection(
                runtime,
                &snapshot,
                query,
                input.get("limit").and_then(Value::as_u64),
            )
        }
        "meetings.update" => {
            let meeting_id = required_string(&input, "meeting_id")?;
            let patch = MeetingUpdatePatch {
                title: optional_string(&input, "title")?,
                summary: optional_string(&input, "summary")?,
                tags: optional_strings(&input, "tags")?,
            };
            runtime
                .update_meeting(meeting_id, patch)
                .map_err(runtime_error)
                .and_then(|_| runtime.meeting(meeting_id).map_err(runtime_error))
                .and_then(|meeting| get_projection(runtime, &meeting, meeting_id, 0, Some(0)))
        }
        _ => Err(ToolError::new(
            ToolErrorCode::NotFound,
            format!("unknown native meeting tool: {action}"),
        )),
    }
}

#[cfg(test)]
fn list_projection(snapshot: &MeetingSnapshot, limit: Option<u64>) -> Result<Value, ToolError> {
    let limit = bounded_limit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)?;
    let meetings = snapshot
        .meetings
        .iter()
        .filter(|meeting| is_public_meeting(meeting))
        .take(limit)
        .map(meeting_metadata)
        .collect::<Result<Vec<_>, _>>()?;
    let available = snapshot
        .meetings
        .iter()
        .filter(|meeting| is_public_meeting(meeting))
        .count();
    Ok(json!({
        "meetings": meetings,
        "returned": meetings.len(),
        "hasMore": available > meetings.len() || snapshot.meetings_truncated,
        "nextBefore": snapshot.next_meetings_before,
        "revision": snapshot.revision
    }))
}

fn list_page_projection(
    page: &[MeetingView],
    has_more: bool,
    next_before: Option<MeetingLibraryCursor>,
    revision: u64,
) -> Result<Value, ToolError> {
    let meetings = page
        .iter()
        .filter(|meeting| is_public_meeting(meeting))
        .map(meeting_metadata)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "meetings": meetings,
        "returned": meetings.len(),
        "hasMore": has_more,
        "nextBefore": next_before,
        "revision": revision
    }))
}

fn get_projection(
    runtime: &MeetingRuntime,
    meeting: &MeetingView,
    meeting_id: &str,
    offset: u64,
    limit: Option<u64>,
) -> Result<Value, ToolError> {
    require_public_meeting(meeting)?;
    let limit = bounded_limit(limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT)?;
    let page = if limit == 0 {
        None
    } else {
        Some(
            runtime
                .transcript_slice(meeting_id, offset, limit as u32)
                .map_err(runtime_error)?,
        )
    };
    let mut value = serde_json::to_value(meeting).map_err(serialization_error)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| serialization_error("meeting projection was not an object"))?;
    object.insert(
        "segments".into(),
        serde_json::to_value(
            page.as_ref()
                .map(|page| page.segments.as_slice())
                .unwrap_or_default(),
        )
        .map_err(serialization_error)?,
    );
    if let Some(summary) = page.as_ref().and_then(|page| page.summary.as_ref()) {
        object.insert("summary".into(), Value::String(summary.clone()));
    }
    let returned = page.as_ref().map_or(0, |page| page.segments.len());
    let total = page
        .as_ref()
        .map_or(meeting.segment_count, |page| page.total_segments);
    let has_more = offset.saturating_add(returned as u64) < total;
    object.insert(
        "transcriptPage".into(),
        json!({
            "offset": offset,
            "returned": returned,
            "total": total,
            "hasMore": has_more,
            "nextOffset": has_more.then_some(offset.saturating_add(returned as u64))
        }),
    );
    Ok(value)
}

fn search_projection(
    runtime: &MeetingRuntime,
    snapshot: &MeetingSnapshot,
    query: &str,
    limit: Option<u64>,
) -> Result<Value, ToolError> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Err(invalid_input("query cannot be empty"));
    }
    let limit = bounded_limit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)?;
    let transcript_hits = runtime
        .search_transcript(&normalized, (MAX_LIST_LIMIT * 3) as u32)
        .map_err(runtime_error)?;
    let mut candidates = snapshot
        .meetings
        .iter()
        .cloned()
        .map(|meeting| (meeting.id.clone(), meeting))
        .collect::<std::collections::BTreeMap<_, _>>();
    for transcript_hit in &transcript_hits {
        if !candidates.contains_key(&transcript_hit.meeting_id) {
            if let Ok(meeting) = runtime.meeting(&transcript_hit.meeting_id) {
                candidates.insert(meeting.id.clone(), meeting);
            }
        }
    }
    let mut hits = Vec::new();
    for meeting in candidates.values() {
        if !is_public_meeting(meeting) {
            continue;
        }
        let title_match = meeting.title.to_lowercase().contains(&normalized);
        let full_summary = if meeting.summary_truncated {
            runtime
                .transcript_slice(&meeting.id, 0, 1)
                .map_err(runtime_error)?
                .summary
        } else {
            meeting.summary.clone()
        };
        let summary_match = full_summary
            .as_deref()
            .is_some_and(|summary| summary.to_lowercase().contains(&normalized));
        let transcript_matches = transcript_hits
            .iter()
            .filter(|segment| segment.meeting_id == meeting.id)
            .map(|segment| {
                json!({
                    "segmentId": segment.segment_id,
                    "startMs": segment.start_ms,
                    "text": bounded_excerpt(&segment.text, 240)
                })
            })
            .collect::<Vec<_>>();
        if !title_match && !summary_match && transcript_matches.is_empty() {
            continue;
        }
        hits.push(json!({
            "meeting": meeting_metadata(meeting)?,
            "matched": {
                "title": title_match,
                "summary": summary_match,
                "transcript": transcript_matches
            }
        }));
        if hits.len() == limit {
            break;
        }
    }
    Ok(json!({
        "query": query.trim(),
        "hits": hits,
        "returned": hits.len(),
        "revision": snapshot.revision
    }))
}

fn validate_search_query(query: &str) -> Result<(), ToolError> {
    if query.trim().is_empty() {
        return Err(invalid_input("query cannot be empty"));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(invalid_input(format!(
            "query exceeds the {MAX_QUERY_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn meeting_metadata(meeting: &MeetingView) -> Result<Value, ToolError> {
    let mut object = Map::new();
    let serialized = serde_json::to_value(meeting).map_err(serialization_error)?;
    for key in [
        "id",
        "title",
        "lifecycle",
        "transcription",
        "startedAt",
        "stoppedAt",
        "durationMs",
        "workspacePath",
        "sourceApp",
        "channels",
        "transcriptRevision",
        "transcriptFinal",
        "summary",
        "summaryState",
        "kgState",
        "error",
        "updatedAt",
    ] {
        if let Some(value) = serialized.get(key) {
            object.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(object))
}

fn require_public_meeting(meeting: &MeetingView) -> Result<(), ToolError> {
    if !is_public_meeting(meeting) {
        return Err(ToolError::new(
            ToolErrorCode::Unavailable,
            "the meeting becomes available to agents after recording and finalization stop",
        ));
    }
    Ok(())
}

fn is_public_meeting(meeting: &MeetingView) -> bool {
    matches!(
        meeting.lifecycle.as_str(),
        "ready" | "interrupted" | "failed"
    )
}

fn required_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, ToolError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input(format!("{field} must be a non-empty string")))
}

fn optional_string(input: &Value, field: &str) -> Result<Option<String>, ToolError> {
    let Some(value) = input.get(field) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| invalid_input(format!("{field} must be a string")))?;
    Ok(Some(value.to_string()))
}

fn optional_strings(input: &Value, field: &str) -> Result<Option<Vec<String>>, ToolError> {
    let Some(value) = input.get(field) else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid_input(format!("{field} must be an array of strings")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid_input(format!("{field} must contain only strings")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(values))
}

fn optional_library_cursor(input: &Value) -> Result<Option<MeetingLibraryCursor>, ToolError> {
    let Some(value) = input.get("before") else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| invalid_input("before must be a meeting library cursor object"))?;
    let created_at = object
        .get("created_at")
        .or_else(|| object.get("createdAt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input("before.created_at is required"))?;
    let meeting_id = object
        .get("meeting_id")
        .or_else(|| object.get("meetingId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input("before.meeting_id is required"))?;
    Ok(Some(MeetingLibraryCursor {
        created_at: created_at.into(),
        meeting_id: meeting_id.into(),
    }))
}

fn bounded_limit(value: Option<u64>, default: usize, maximum: usize) -> Result<usize, ToolError> {
    let value = value.unwrap_or(default as u64);
    if value > maximum as u64 {
        return Err(invalid_input(format!("limit cannot exceed {maximum}")));
    }
    usize::try_from(value).map_err(|_| invalid_input("limit is too large"))
}

fn bounded_excerpt(value: &str, maximum_chars: usize) -> String {
    let mut chars = value.chars();
    let mut excerpt = chars.by_ref().take(maximum_chars).collect::<String>();
    if chars.next().is_some() {
        excerpt.push('…');
    }
    excerpt
}

fn runtime_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::new(ToolErrorCode::Handler, error.to_string())
}

fn serialization_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::new(ToolErrorCode::Internal, error.to_string())
}

fn invalid_input(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::InvalidInput, message)
}

fn definitions() -> Vec<(&'static str, &'static str, &'static str, Value)> {
    vec![
        (
            "meetings.list",
            "meetings_list",
            "List completed and interrupted meetings recorded natively by Mimir Scribe. This is distinct from meetings synced from Granola.",
            object_schema(
                json!({
                    "limit": { "type": "integer", "minimum": 0, "maximum": MAX_LIST_LIMIT, "default": DEFAULT_LIST_LIMIT },
                    "before": {
                        "type": "object",
                        "properties": {
                            "created_at": { "type": "string" },
                            "meeting_id": { "type": "string" }
                        },
                        "required": ["created_at", "meeting_id"],
                        "additionalProperties": false
                    }
                }),
                &[],
            ),
        ),
        (
            "meetings.get",
            "meetings_get",
            "Read one Mimir Scribe meeting with a bounded finalized transcript slice. This never starts or controls recording.",
            object_schema(
                json!({
                    "meeting_id": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "transcript_offset": { "type": "integer", "minimum": 0, "default": 0 },
                    "transcript_limit": { "type": "integer", "minimum": 0, "maximum": MAX_TRANSCRIPT_LIMIT, "default": DEFAULT_TRANSCRIPT_LIMIT }
                }),
                &["meeting_id"],
            ),
        ),
        (
            "meetings.search",
            "meetings_search",
            "Search titles, summaries, and finalized transcript text recorded by Mimir Scribe.",
            object_schema(
                json!({
                    "query": { "type": "string", "minLength": 1, "maxLength": MAX_QUERY_BYTES },
                    "limit": { "type": "integer", "minimum": 0, "maximum": MAX_LIST_LIMIT, "default": DEFAULT_LIST_LIMIT }
                }),
                &["query"],
            ),
        ),
        (
            "meetings.update",
            "meetings_update",
            "Update reviewed metadata for one Mimir Scribe meeting. Recording controls are deliberately not exposed to agents.",
            object_schema(
                json!({
                    "meeting_id": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "title": { "type": "string", "maxLength": 200 },
                    "summary": { "type": "string", "maxLength": 100000 },
                    "tags": {
                        "type": "array",
                        "maxItems": 64,
                        "items": { "type": "string", "minLength": 1, "maxLength": 80 }
                    }
                }),
                &["meeting_id"],
            ),
        ),
    ]
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::runtime::{
        CaptureStart, CaptureStop, CaptureStopResult, MeetingCapturePort, MeetingClock,
        MeetingConfig, MeetingContentProjection, MeetingDeleteMode, MeetingEvent, MeetingEventSink,
        MeetingExport, MeetingExportFormat, MeetingPermissions, MeetingPlatformPort,
        MeetingPlatformProjection, MeetingSnapshot, MeetingTranscriptionPort,
        TranscriptionFinalize, TranscriptionStart,
    };
    use crate::meetings::{
        MeetingDraft, MeetingFailure, MeetingOrigin, MeetingStatus, MeetingStore, TranscriptBatch,
    };
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    struct TestCapture;

    impl MeetingCapturePort for TestCapture {
        fn recover(&self, _report: &crate::meetings::RecoveryReport) -> Result<(), String> {
            Ok(())
        }
        fn start(&self, _request: &CaptureStart) -> Result<(), String> {
            Ok(())
        }
        fn stop(&self, _request: &CaptureStop) -> Result<CaptureStopResult, String> {
            Ok(CaptureStopResult::default())
        }
        fn set_microphone_muted(
            &self,
            _meeting_id: &str,
            _run_id: &str,
            _muted: bool,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct TestTranscription;

    impl MeetingTranscriptionPort for TestTranscription {
        fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
            Ok(())
        }
        fn finalize(&self, _request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
            Err("unused".into())
        }
    }

    #[derive(Default)]
    struct TestPlatform {
        contents: Mutex<BTreeMap<String, MeetingContentProjection>>,
    }

    impl MeetingPlatformPort for TestPlatform {
        fn projection(&self) -> Result<MeetingPlatformProjection, String> {
            Ok(MeetingPlatformProjection::default())
        }
        fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String> {
            Ok(self
                .contents
                .lock()
                .unwrap()
                .get(meeting_id)
                .cloned()
                .unwrap_or_default())
        }
        fn update_config(
            &self,
            _patch: &crate::meetings::runtime::MeetingConfigPatch,
        ) -> Result<(), String> {
            Ok(())
        }
        fn set_api_key(&self, _api_key: &str) -> Result<(), String> {
            Ok(())
        }
        fn clear_api_key(&self) -> Result<(), String> {
            Ok(())
        }
        fn install_model(&self, _model_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete_model(&self, _model_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn update_content(
            &self,
            meeting_id: &str,
            patch: &MeetingUpdatePatch,
        ) -> Result<(), String> {
            let mut contents = self.contents.lock().unwrap();
            let content = contents.entry(meeting_id.into()).or_default();
            if let Some(title) = &patch.title {
                content.title = Some(title.clone());
            }
            if let Some(summary) = &patch.summary {
                content.summary = Some(summary.clone());
            }
            if let Some(tags) = &patch.tags {
                content.tags = tags.clone();
            }
            Ok(())
        }
        fn set_kg_decision(&self, _meeting_id: &str, _decision: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete_meeting(
            &self,
            _meeting_id: &str,
            _mode: MeetingDeleteMode,
        ) -> Result<(), String> {
            Ok(())
        }
        fn export_meeting(
            &self,
            _meeting_id: &str,
            _format: MeetingExportFormat,
        ) -> Result<MeetingExport, String> {
            Err("unused".into())
        }
    }

    struct TestClock;

    impl MeetingClock for TestClock {
        fn now(&self) -> String {
            "2026-07-31T00:00:00Z".into()
        }
    }

    struct TestEvents;

    impl MeetingEventSink for TestEvents {
        fn publish(&self, _event: &MeetingEvent) -> Result<(), String> {
            Ok(())
        }
    }

    fn snapshot() -> MeetingSnapshot {
        MeetingSnapshot {
            revision: 7,
            meetings: vec![],
            meetings_truncated: false,
            next_meetings_before: None,
            active_meeting_id: None,
            candidates: vec![],
            config: MeetingConfig::default(),
            permissions: MeetingPermissions::default(),
            models: vec![],
            diagnostic: None,
        }
    }

    #[test]
    fn public_projection_has_no_recording_control() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 4);
        assert!(definitions.iter().all(|definition| {
            !definition.0.contains("start")
                && !definition.0.contains("stop")
                && !definition.0.contains("record")
        }));
    }

    #[test]
    fn list_projection_is_bounded_and_distinguishes_native_meetings() {
        let value = list_projection(&snapshot(), Some(100)).unwrap();
        assert_eq!(value["returned"], 0);
        assert!(definitions()[0].2.contains("recorded natively"));
        assert_eq!(
            list_projection(&snapshot(), Some(101)).unwrap_err().code,
            ToolErrorCode::InvalidInput
        );
    }

    #[test]
    fn search_rejects_blank_and_oversized_queries() {
        let empty = validate_search_query("  ").unwrap_err();
        assert_eq!(empty.code, ToolErrorCode::InvalidInput);
        let oversized = "x".repeat(MAX_QUERY_BYTES + 1);
        let error = validate_search_query(&oversized).unwrap_err();
        assert_eq!(error.code, ToolErrorCode::InvalidInput);
    }

    #[test]
    fn platform_projection_type_remains_serializable_for_tool_bootstrap() {
        let projection = MeetingPlatformProjection::default();
        assert!(serde_json::to_value(projection).is_ok());
    }

    #[test]
    fn get_and_update_resolve_records_beyond_the_snapshot_cap() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        for index in 0..=200 {
            let id = format!("meeting-{index:03}");
            let created = store
                .create_meeting(
                    &MeetingDraft {
                        id: id.clone(),
                        title: format!("Meeting {index}"),
                        origin: MeetingOrigin::default(),
                        channels: Vec::new(),
                        metadata: json!({}),
                    },
                    "2026-07-31T00:00:00Z",
                )
                .unwrap();
            store
                .transition_meeting(
                    &id,
                    created.revision,
                    MeetingStatus::Failed,
                    "2026-07-31T00:00:01Z",
                    Some(&MeetingFailure {
                        code: "fixture".into(),
                        message: "terminal fixture".into(),
                        retryable: false,
                    }),
                )
                .unwrap();
        }
        let platform = Arc::new(TestPlatform::default());
        let runtime = MeetingRuntime::new(
            store,
            Arc::new(TestCapture),
            Arc::new(TestTranscription),
            platform,
            Arc::new(TestClock),
            Arc::new(TestEvents),
        )
        .unwrap();
        let snapshot = runtime.snapshot().unwrap();
        assert!(snapshot.meetings_truncated);
        assert!(!snapshot
            .meetings
            .iter()
            .any(|meeting| meeting.id == "meeting-000"));

        let fetched = execute(
            &runtime,
            "meetings.get",
            json!({"meeting_id": "meeting-000", "transcript_limit": 0}),
        )
        .unwrap();
        assert_eq!(fetched["id"], "meeting-000");

        let updated = execute(
            &runtime,
            "meetings.update",
            json!({"meeting_id": "meeting-000", "title": "Reviewed oldest meeting"}),
        )
        .unwrap();
        assert_eq!(updated["title"], "Reviewed oldest meeting");
    }
}
