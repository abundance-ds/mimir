//! Read-mostly public projection of meetings recorded by Mimir Scribe.
//!
//! Recording controls intentionally do not exist here. Mimir's loopback MCP
//! endpoint is trusted-local but unauthenticated, so exporting start/stop would
//! let every local process exercise Mimir's microphone grant.

#[cfg(test)]
use super::runtime::MeetingSnapshot;
use super::runtime::{
    MeetingDeleteMode, MeetingLibraryCursor, MeetingLibrarySearchHit, MeetingRuntime,
    MeetingUpdatePatch, MeetingView,
};
use crate::tool_registry::{
    ToolCallContext, ToolDescriptor, ToolError, ToolErrorCode, ToolOwner, ToolRegistration,
    ToolRegistry, ToolResult, ToolSource,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use tauri::Manager;

const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 100;
const DEFAULT_TRANSCRIPT_LIMIT: usize = 100;
const MAX_TRANSCRIPT_LIMIT: usize = 250;
const MAX_QUERY_BYTES: usize = 512;
const MAX_TAGS: usize = 64;
const MAX_TAG_CHARS: usize = 80;
const MAX_TAG_BYTES: usize = 160;

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
            let limit = bounded_limit(
                input.get("limit").and_then(Value::as_u64),
                DEFAULT_LIST_LIMIT,
                MAX_LIST_LIMIT,
            )?;
            let hits = runtime
                .search_library(query, limit as u32)
                .map_err(runtime_error)?;
            search_projection(&hits, query, runtime.revision())
        }
        "meetings.update" => {
            let meeting_id = required_string(&input, "meeting_id")?;
            let meeting = runtime.meeting(meeting_id).map_err(runtime_error)?;
            require_public_meeting(&meeting)?;
            let patch = MeetingUpdatePatch {
                title: optional_string(&input, "title")?,
                summary: optional_string(&input, "summary")?,
                tags: optional_tags(&input, "tags")?,
            };
            runtime
                .update_meeting(meeting_id, patch)
                .map_err(runtime_error)
                .and_then(|_| runtime.meeting(meeting_id).map_err(runtime_error))
                .and_then(|meeting| get_projection(runtime, &meeting, meeting_id, 0, Some(0)))
        }
        "meetings.delete" => {
            let meeting_id = required_string(&input, "meeting_id")?;
            let expected_title = required_string(&input, "expected_title")?;
            let meeting = runtime.meeting(meeting_id).map_err(runtime_error)?;
            require_public_meeting(&meeting)?;
            if meeting.title != expected_title {
                return Err(invalid_input(
                    "meeting title changed; call meetings_get again before deleting",
                ));
            }
            let (mode, deleted) = match required_string(&input, "scope")? {
                "audio" => (MeetingDeleteMode::Audio, "audio"),
                "meeting" => (MeetingDeleteMode::All, "meeting"),
                _ => return Err(invalid_input("scope must be audio or meeting")),
            };
            runtime.delete(meeting_id, mode).map_err(runtime_error)?;
            Ok(json!({
                "meetingId": meeting_id,
                "title": meeting.title,
                "deleted": deleted,
                "permanent": true
            }))
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
    search_hits: &[MeetingLibrarySearchHit],
    query: &str,
    revision: u64,
) -> Result<Value, ToolError> {
    if query.trim().is_empty() {
        return Err(invalid_input("query cannot be empty"));
    }
    let hits = search_hits
        .iter()
        .map(|hit| {
            let transcript_matches = hit
                .matched
                .transcript
                .iter()
                .map(|segment| {
                    json!({
                        "segmentId": segment.segment_id,
                        "startMs": segment.start_ms,
                        "text": bounded_excerpt(&segment.text, 240)
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "meeting": meeting_metadata(&hit.meeting)?,
                "matched": {
                    "title": hit.matched.title,
                    "summary": hit.matched.summary,
                    "tags": hit.matched.tags,
                    "transcript": transcript_matches
                }
            }))
        })
        .collect::<Result<Vec<_>, ToolError>>()?;
    Ok(json!({
        "query": query.trim(),
        "hits": hits,
        "returned": hits.len(),
        "revision": revision
    }))
}

fn validate_search_query(query: &str) -> Result<(), ToolError> {
    if query.trim().is_empty() {
        return Err(invalid_input("query cannot be empty"));
    }
    if query.trim().chars().count() < 3 {
        return Err(invalid_input(
            "query must contain at least 3 characters for indexed substring search",
        ));
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
        "sourceApp",
        "channels",
        "tags",
        "transcriptRevision",
        "transcriptFinal",
        "summary",
        "summaryState",
        "kgState",
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

fn optional_tags(input: &Value, field: &str) -> Result<Option<Vec<String>>, ToolError> {
    let Some(value) = input.get(field) else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid_input(format!("{field} must be an array of strings")))?;
    if values.len() > MAX_TAGS {
        return Err(invalid_input(format!(
            "{field} cannot contain more than {MAX_TAGS} values"
        )));
    }
    let mut tags = Vec::with_capacity(values.len());
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        let tag = value
            .as_str()
            .ok_or_else(|| invalid_input(format!("{field} must contain only strings")))?
            .trim();
        if tag.is_empty() {
            return Err(invalid_input(format!(
                "{field} cannot contain empty values"
            )));
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(invalid_input(format!(
                "{field} values cannot exceed {MAX_TAG_CHARS} characters"
            )));
        }
        if tag.len() > MAX_TAG_BYTES {
            return Err(invalid_input(format!(
                "{field} values cannot exceed {MAX_TAG_BYTES} UTF-8 bytes"
            )));
        }
        if tag.chars().any(char::is_control) {
            return Err(invalid_input(format!(
                "{field} cannot contain control characters"
            )));
        }
        if seen.insert(tag.to_string()) {
            tags.push(tag.to_string());
        }
    }
    Ok(Some(tags))
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
            "Search reviewed titles, full summaries, tags, and finalized transcript text across the complete Mimir Scribe library.",
            object_schema(
                json!({
                    "query": { "type": "string", "minLength": 3, "maxLength": MAX_QUERY_BYTES },
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
        (
            "meetings.delete",
            "meetings_delete",
            "Permanently delete source audio or an entire stopped Mimir Scribe meeting. Call only after an explicit user request and read the meeting first.",
            object_schema(
                json!({
                    "meeting_id": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "expected_title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "scope": { "type": "string", "enum": ["audio", "meeting"] }
                }),
                &["meeting_id", "expected_title", "scope"],
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
        MeetingDeletionMode, MeetingDraft, MeetingFailure, MeetingOrigin, MeetingStatus,
        MeetingStore, TranscriptBatch, TranscriptChange, TranscriptSegmentInput,
    };
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
        content_updates: AtomicUsize,
        deleted: Mutex<Vec<(String, MeetingDeleteMode)>>,
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
            self.content_updates.fetch_add(1, Ordering::SeqCst);
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
        fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String> {
            self.deleted.lock().unwrap().push((meeting_id.into(), mode));
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
        assert_eq!(definitions.len(), 5);
        assert!(definitions
            .iter()
            .any(|definition| definition.0 == "meetings.delete"));
        assert!(definitions.iter().all(|definition| {
            !definition.0.contains("start")
                && !definition.0.contains("stop")
                && !definition.0.contains("record")
        }));
    }

    #[test]
    fn agent_delete_requires_the_exact_current_title_and_explicit_scope() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let platform = Arc::new(TestPlatform::default());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "delete-explicit-meeting".into(),
                    title: "Original title".into(),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                "2026-07-31T00:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
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
        platform.contents.lock().unwrap().insert(
            created.id.clone(),
            MeetingContentProjection {
                title: Some("Reviewed current title".into()),
                ..MeetingContentProjection::default()
            },
        );
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(TestCapture),
            Arc::new(TestTranscription),
            platform.clone(),
            Arc::new(TestClock),
            Arc::new(TestEvents),
        )
        .unwrap();

        let stale = execute(
            &runtime,
            "meetings.delete",
            json!({
                "meeting_id": created.id,
                "expected_title": "Original title",
                "scope": "meeting",
            }),
        )
        .unwrap_err();
        assert_eq!(stale.code, ToolErrorCode::InvalidInput);
        assert!(platform.deleted.lock().unwrap().is_empty());

        let unknown_scope = execute(
            &runtime,
            "meetings.delete",
            json!({
                "meeting_id": created.id,
                "expected_title": "Reviewed current title",
                "scope": "files",
            }),
        )
        .unwrap_err();
        assert_eq!(unknown_scope.code, ToolErrorCode::InvalidInput);
        assert!(platform.deleted.lock().unwrap().is_empty());

        let deleted = execute(
            &runtime,
            "meetings.delete",
            json!({
                "meeting_id": created.id,
                "expected_title": "Reviewed current title",
                "scope": "meeting",
            }),
        )
        .unwrap();
        assert_eq!(deleted["meetingId"], "delete-explicit-meeting");
        assert_eq!(deleted["title"], "Reviewed current title");
        assert_eq!(deleted["deleted"], "meeting");
        assert_eq!(deleted["permanent"], true);
        assert_eq!(
            *platform.deleted.lock().unwrap(),
            vec![("delete-explicit-meeting".into(), MeetingDeleteMode::All)]
        );
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
        let short = validate_search_query("ab").unwrap_err();
        assert_eq!(short.code, ToolErrorCode::InvalidInput);
        assert!(short.message.contains("at least 3 characters"));
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
    fn update_rejects_live_meetings_before_the_platform_can_write() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        let platform = Arc::new(TestPlatform::default());
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(TestCapture),
            Arc::new(TestTranscription),
            platform.clone(),
            Arc::new(TestClock),
            Arc::new(TestEvents),
        )
        .unwrap();
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "live-private".into(),
                    title: "Live private meeting".into(),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                "2026-07-31T00:00:00Z",
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                MeetingStatus::Recording,
                "2026-07-31T00:00:01Z",
                None,
            )
            .unwrap();
        platform.contents.lock().unwrap().insert(
            created.id.clone(),
            MeetingContentProjection {
                title: Some(created.title.clone()),
                ..MeetingContentProjection::default()
            },
        );
        let error = execute(
            &runtime,
            "meetings.update",
            json!({"meeting_id": created.id, "title": "Agent-authored live title"}),
        )
        .unwrap_err();

        assert_eq!(error.code, ToolErrorCode::Unavailable);
        let delete_error = execute(
            &runtime,
            "meetings.delete",
            json!({
                "meeting_id": created.id,
                "expected_title": "Live private meeting",
                "scope": "meeting",
            }),
        )
        .unwrap_err();
        assert_eq!(delete_error.code, ToolErrorCode::Unavailable);
        assert!(platform.deleted.lock().unwrap().is_empty());
        assert_eq!(platform.content_updates.load(Ordering::SeqCst), 0);
        assert_eq!(
            platform
                .contents
                .lock()
                .unwrap()
                .get("live-private")
                .and_then(|content| content.title.as_deref()),
            Some("Live private meeting")
        );
    }

    #[test]
    fn get_update_and_search_resolve_records_beyond_the_snapshot_cap() {
        let store = Arc::new(MeetingStore::open_in_memory().unwrap());
        for index in 0..=200 {
            let id = format!("meeting-{index:03}");
            store
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
            if index == 0 {
                store
                    .apply_transcript_batch(&TranscriptBatch {
                        meeting_id: id.clone(),
                        batch_id: "oldest-search-transcript".into(),
                        base_revision: 0,
                        source: "test".into(),
                        observed_at: "2026-07-31T00:00:00.500Z".into(),
                        marks_final: true,
                        changes: vec![TranscriptChange::UpsertSegment {
                            segment: TranscriptSegmentInput {
                                id: "oldest-segment".into(),
                                start_ms: 1_000,
                                end_ms: 2_000,
                                text: "Transcript authority sentinel appears here.".into(),
                                channel_id: None,
                                speaker: None,
                                confidence: Some(1.0),
                                is_final: true,
                                metadata: json!({}),
                            },
                        }],
                    })
                    .unwrap();
            }
            store
                .transition_meeting(
                    &id,
                    store.get_meeting(&id).unwrap().revision,
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
        let full_summary = format!("{} oldest-summary-sentinel", "summary context ".repeat(180));
        platform.contents.lock().unwrap().insert(
            "meeting-000".into(),
            MeetingContentProjection {
                title: Some("Reviewed oldest title sentinel".into()),
                summary: Some(full_summary.clone()),
                tags: vec!["release-roadmap-sentinel".into()],
                ..MeetingContentProjection::default()
            },
        );
        store
            .sync_content_search(
                "meeting-000",
                "Reviewed oldest title sentinel",
                Some(&full_summary),
                &["release-roadmap-sentinel".into()],
                false,
                "test-content-v1",
            )
            .unwrap();
        let runtime = MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(TestCapture),
            Arc::new(TestTranscription),
            platform.clone(),
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
            json!({
                "meeting_id": "meeting-000",
                "title": "Reviewed oldest meeting",
                "tags": ["release", "customer"]
            }),
        )
        .unwrap();
        assert_eq!(updated["title"], "Reviewed oldest meeting");
        assert_eq!(updated["tags"], json!(["release", "customer"]));

        // Keep the durable index aligned with this fake platform's update;
        // the production NativeMeetingPlatform performs this in one owned
        // operation.
        store
            .sync_content_search(
                "meeting-000",
                "Reviewed oldest meeting",
                Some(&full_summary),
                &["release-roadmap-sentinel".into()],
                false,
                "test-content-v2",
            )
            .unwrap();
        for (query, field) in [
            ("oldest meeting", "title"),
            ("oldest-summary-sentinel", "summary"),
            ("roadmap-sentinel", "tags"),
            ("authority sentinel", "transcript"),
        ] {
            let result = execute(
                &runtime,
                "meetings.search",
                json!({"query": query, "limit": 10}),
            )
            .unwrap();
            assert_eq!(result["returned"], 1, "query '{query}'");
            assert_eq!(result["hits"][0]["meeting"]["id"], "meeting-000");
            if field == "transcript" {
                assert_eq!(
                    result["hits"][0]["matched"]["transcript"][0]["segmentId"],
                    "oldest-segment"
                );
            } else {
                assert_eq!(result["hits"][0]["matched"][field], true);
            }
            assert!(
                serde_json::to_vec(&result).unwrap().len() < 32 * 1024,
                "bounded search result exceeded its payload budget"
            );
        }

        let detected = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-in-progress".into(),
                    title: "In progress exclusion sentinel".into(),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                "2026-07-31T00:00:03Z",
            )
            .unwrap();
        store
            .transition_meeting(
                &detected.id,
                detected.revision,
                MeetingStatus::Recording,
                "2026-07-31T00:00:04Z",
                None,
            )
            .unwrap();
        store
            .sync_content_search(
                &detected.id,
                &detected.title,
                Some("in-progress-private-sentinel"),
                &[],
                false,
                "test-content-in-progress",
            )
            .unwrap();
        platform.contents.lock().unwrap().insert(
            detected.id.clone(),
            MeetingContentProjection {
                title: Some(detected.title),
                summary: Some("in-progress-private-sentinel".into()),
                ..MeetingContentProjection::default()
            },
        );

        let deleted = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-deleted".into(),
                    title: "Deleted exclusion sentinel".into(),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                "2026-07-31T00:00:05Z",
            )
            .unwrap();
        store
            .transition_meeting(
                &deleted.id,
                deleted.revision,
                MeetingStatus::Failed,
                "2026-07-31T00:00:06Z",
                Some(&MeetingFailure {
                    code: "fixture".into(),
                    message: "terminal fixture".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        store
            .sync_content_search(
                &deleted.id,
                &deleted.title,
                Some("deleted-private-sentinel"),
                &[],
                false,
                "test-content-deleted",
            )
            .unwrap();
        platform.contents.lock().unwrap().insert(
            deleted.id.clone(),
            MeetingContentProjection {
                title: Some(deleted.title),
                summary: Some("deleted-private-sentinel".into()),
                ..MeetingContentProjection::default()
            },
        );
        store
            .begin_deletion(
                "meeting-deleted",
                MeetingDeletionMode::All,
                "2026-07-31T00:00:07Z",
            )
            .unwrap();

        for query in ["in-progress-private-sentinel", "deleted-private-sentinel"] {
            let result = execute(
                &runtime,
                "meetings.search",
                json!({"query": query, "limit": 10}),
            )
            .unwrap();
            assert_eq!(result["returned"], 0, "query '{query}' leaked a record");
        }
    }

    #[test]
    fn reviewed_tags_are_normalized_and_rejected_at_public_payload_bounds() {
        assert_eq!(
            optional_tags(
                &json!({"tags": [" release ", "customer", "release"]}),
                "tags"
            )
            .unwrap(),
            Some(vec!["release".into(), "customer".into()])
        );

        for input in [
            json!({"tags": (0..=MAX_TAGS).map(|index| format!("tag-{index}")).collect::<Vec<_>>()}),
            json!({"tags": ["x".repeat(MAX_TAG_CHARS + 1)]}),
            json!({"tags": ["🦀".repeat((MAX_TAG_BYTES / 4) + 1)]}),
            json!({"tags": ["line\nbreak"]}),
        ] {
            let error = optional_tags(&input, "tags").unwrap_err();
            assert_eq!(error.code, ToolErrorCode::InvalidInput);
        }
    }
}
