use super::*;
use crate::meetings::{TranscriptChange, TranscriptSegmentInput};
use std::collections::BTreeMap;
use std::{sync::Barrier, thread};

const NOW: &str = "2026-07-30T10:00:00.000Z";
const LEASE_END: &str = "2026-07-30T10:05:00.000Z";

#[derive(Default)]
struct FakeCapture {
    starts: Mutex<Vec<CaptureStart>>,
    stops: Mutex<Vec<CaptureStop>>,
    mute_changes: Mutex<Vec<(String, String, bool)>>,
    recoveries: Mutex<Vec<RecoveryReport>>,
    fail_start: Mutex<Option<String>>,
}

impl MeetingCapturePort for FakeCapture {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
        self.recoveries.lock().unwrap().push(report.clone());
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        if let Some(error) = self.fail_start.lock().unwrap().clone() {
            return Err(error);
        }
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        self.stops.lock().unwrap().push(request.clone());
        Ok(CaptureStopResult {
            duration_ms: 42_000,
        })
    }

    fn set_microphone_muted(
        &self,
        meeting_id: &str,
        run_id: &str,
        muted: bool,
    ) -> Result<(), String> {
        self.mute_changes
            .lock()
            .unwrap()
            .push((meeting_id.into(), run_id.into(), muted));
        Ok(())
    }
}

struct ReconnectGapOnStopCapture {
    store: Arc<MeetingStore>,
}

impl MeetingCapturePort for ReconnectGapOnStopCapture {
    fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, _request: &CaptureStart) -> Result<(), String> {
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        let meeting = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?;
        self.store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("reconnect-gap-{}", request.run_id),
                base_revision: meeting.transcript_revision,
                source: "native-capture".into(),
                observed_at: NOW.into(),
                marks_final: false,
                changes: vec![TranscriptChange::OpenGap {
                    gap: crate::meetings::TranscriptGapInput {
                        id: "microphone-reconnect-gap".into(),
                        start_ms: 40_000,
                        end_ms: 42_000,
                        reason: crate::meetings::TranscriptGapReason::DeviceChanged,
                        channel_id: Some("microphone".into()),
                        detail: Some(
                            "capture stopped while audio devices were reconnecting".into(),
                        ),
                    },
                }],
            })
            .map_err(|error| error.to_string())?;
        Ok(CaptureStopResult {
            duration_ms: 42_000,
        })
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

struct PromotingRecoveryCapture {
    store: Arc<MeetingStore>,
}

impl MeetingCapturePort for PromotingRecoveryCapture {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
        for chunk in &report.staged_audio_chunks {
            self.store
                .commit_audio_chunk(&chunk.definition.id, NOW)
                .map_err(|error| error.to_string())?;
        }
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

#[derive(Default)]
struct EndedWorkerCapture {
    starts: Mutex<Vec<CaptureStart>>,
    stops: Mutex<Vec<CaptureStop>>,
}

impl MeetingCapturePort for EndedWorkerCapture {
    fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        self.stops.lock().unwrap().push(request.clone());
        Err("capture worker already ended after a durable chunk failure".into())
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

#[derive(Default)]
struct FakeTranscription {
    starts: Mutex<Vec<TranscriptionStart>>,
    finalizes: Mutex<Vec<TranscriptionFinalize>>,
}

impl MeetingTranscriptionPort for FakeTranscription {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        self.finalizes.lock().unwrap().push(request.clone());
        let first_sequence = self
            .starts
            .lock()
            .unwrap()
            .iter()
            .find(|start| start.run_id == request.run_id)
            .map(|start| start.first_sequence)
            .unwrap_or(0);
        let start_ms = first_sequence.saturating_mul(1_000) as i64;
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("final-{}", request.run_id),
            base_revision: request.base_revision,
            source: "fake-stt".into(),
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: format!("segment-{}", request.run_id),
                    start_ms,
                    end_ms: start_ms.saturating_add(4_000),
                    text: "Production readiness is a release requirement.".into(),
                    channel_id: Some("microphone".into()),
                    speaker: Some("Speaker 1".into()),
                    confidence: Some(0.98),
                    is_final: true,
                    metadata: json!({}),
                },
            }],
        })
    }
}

struct EmptyTranscription;

impl MeetingTranscriptionPort for EmptyTranscription {
    fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("empty-final-{}", request.run_id),
            base_revision: request.base_revision,
            source: "silent-stt".into(),
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: Vec::new(),
        })
    }
}

struct FailureOrderingTranscription {
    store: Arc<MeetingStore>,
    events: Arc<FakeEvents>,
    observed_interrupted_before_finalize: Mutex<bool>,
}

impl MeetingTranscriptionPort for FailureOrderingTranscription {
    fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        let durable = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?;
        let event_was_published = self
            .events
            .published
            .lock()
            .map_err(|_| "test event mutex was poisoned".to_string())?
            .iter()
            .any(|event| event.kind == "capture-runtime-failed");
        *self
            .observed_interrupted_before_finalize
            .lock()
            .map_err(|_| "test observation mutex was poisoned".to_string())? =
            durable.status == MeetingStatus::Interrupted && event_was_published;
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("failure-terminal-{}", request.run_id),
            base_revision: request.base_revision,
            source: "failure-ordering-stt".into(),
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: Vec::new(),
        })
    }
}

#[derive(Default)]
struct AlwaysFailTranscription {
    starts: Mutex<Vec<TranscriptionStart>>,
    finalizes: Mutex<Vec<TranscriptionFinalize>>,
}

#[derive(Default)]
struct SessionOwningFailTranscription {
    active: Mutex<bool>,
    starts: Mutex<Vec<TranscriptionStart>>,
    finalizes: Mutex<Vec<TranscriptionFinalize>>,
}

impl MeetingTranscriptionPort for SessionOwningFailTranscription {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        if *active {
            return Err("meeting already owns a transcription worker".into());
        }
        *active = true;
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        self.finalizes.lock().unwrap().push(request.clone());
        *self.active.lock().unwrap() = false;
        Err("provider worker ended before its terminal batch".into())
    }
}

impl MeetingTranscriptionPort for AlwaysFailTranscription {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        self.finalizes.lock().unwrap().push(request.clone());
        Err("provider worker ended before its terminal batch".into())
    }
}

struct DrainingTranscription {
    store: Arc<MeetingStore>,
}

impl MeetingTranscriptionPort for DrainingTranscription {
    fn start(&self, _request: &TranscriptionStart) -> Result<(), String> {
        Ok(())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        let tail = TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("tail-{}", request.run_id),
            base_revision: request.base_revision,
            source: "draining-stt".into(),
            observed_at: request.observed_at.clone(),
            marks_final: false,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "drained-segment".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "The acknowledged provider tail is durable.".into(),
                    channel_id: Some("system".into()),
                    speaker: Some("Them".into()),
                    confidence: Some(0.95),
                    is_final: true,
                    metadata: json!({}),
                },
            }],
        };
        let applied = self
            .store
            .apply_transcript_batch(&tail)
            .map_err(|error| error.to_string())?;
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("terminal-{}", request.run_id),
            base_revision: applied.revision,
            source: "draining-stt".into(),
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: Vec::new(),
        })
    }
}

struct ScriptedRetranscription {
    store: Arc<MeetingStore>,
    fail_finalize: bool,
}

impl MeetingTranscriptionPort for ScriptedRetranscription {
    fn start(&self, request: &TranscriptionStart) -> Result<(), String> {
        let generation = request
            .repair_generation
            .as_deref()
            .ok_or_else(|| "test retranscription requires a generation".to_string())?;
        assert_eq!(
            request.repair_intent,
            Some(TranscriptionRepairIntent::UserRequestedRetranscription)
        );
        let meeting = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?;
        if meeting.status == MeetingStatus::Interrupted {
            self.store.begin_transcript_repair(
                &request.meeting_id,
                generation,
                &request.run_id,
                NOW,
            )
        } else {
            self.store.begin_transcript_retranscription(
                &request.meeting_id,
                generation,
                &request.run_id,
                NOW,
            )
        }
        .map_err(|error| error.to_string())?;
        let base_revision = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?
            .transcript_revision;
        self.store
            .stage_transcript_repair_batch(
                generation,
                &request.run_id,
                &TranscriptBatch {
                    meeting_id: request.meeting_id.clone(),
                    batch_id: format!("staged-{}", request.run_id),
                    base_revision,
                    source: "current-provider".into(),
                    observed_at: NOW.into(),
                    marks_final: false,
                    changes: vec![TranscriptChange::UpsertSegment {
                        segment: TranscriptSegmentInput {
                            id: "replacement-segment".into(),
                            start_ms: 0,
                            end_ms: 2_000,
                            text: "Replacement produced by the current provider.".into(),
                            channel_id: Some("microphone".into()),
                            speaker: Some("Speaker 1".into()),
                            confidence: Some(0.97),
                            is_final: true,
                            metadata: json!({}),
                        },
                    }],
                },
            )
            .map_err(|error| error.to_string())
    }

    fn finalize(&self, request: &TranscriptionFinalize) -> Result<TranscriptBatch, String> {
        if self.fail_finalize {
            return Err("current provider failed before terminal commit".into());
        }
        Ok(TranscriptBatch {
            meeting_id: request.meeting_id.clone(),
            batch_id: format!("terminal-{}", request.run_id),
            base_revision: request.base_revision,
            source: "current-provider".into(),
            observed_at: request.observed_at.clone(),
            marks_final: true,
            changes: Vec::new(),
        })
    }
}

struct AuthorityCheckingCapture {
    store: Arc<MeetingStore>,
    observed_status: Mutex<Option<MeetingStatus>>,
}

impl MeetingCapturePort for AuthorityCheckingCapture {
    fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        let status = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?
            .status;
        *self.observed_status.lock().unwrap() = Some(status);
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

struct FakePlatformState {
    projection: MeetingPlatformProjection,
    contents: BTreeMap<String, MeetingContentProjection>,
    exports: Vec<(String, MeetingExportFormat)>,
    deleted: Vec<(String, MeetingDeleteMode)>,
    fail_export: Option<String>,
    fail_model_install: Option<String>,
    dismissed_candidates: Vec<String>,
}

struct FakePlatform {
    state: Mutex<FakePlatformState>,
}

impl Default for FakePlatform {
    fn default() -> Self {
        Self {
            state: Mutex::new(FakePlatformState {
                projection: MeetingPlatformProjection {
                    config: MeetingConfig::default(),
                    permissions: MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "granted".into(),
                    },
                    candidates: Vec::new(),
                    models: Vec::new(),
                    diagnostic: None,
                },
                contents: BTreeMap::new(),
                exports: Vec::new(),
                deleted: Vec::new(),
                fail_export: None,
                fail_model_install: None,
                dismissed_candidates: Vec::new(),
            }),
        }
    }
}

impl MeetingPlatformPort for FakePlatform {
    fn projection(&self) -> Result<MeetingPlatformProjection, String> {
        Ok(self.state.lock().unwrap().projection.clone())
    }

    fn dismiss_candidate(&self, candidate_id: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .dismissed_candidates
            .push(candidate_id.into());
        Ok(())
    }

    fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .contents
            .get(meeting_id)
            .cloned()
            .unwrap_or_default())
    }

    fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let config = &mut state.projection.config;
        if let Some(value) = patch.detection_enabled {
            config.detection_enabled = value;
        }
        if let Some(value) = patch.auto_record {
            config.auto_record = value;
        }
        if let Some(value) = &patch.transcription_mode {
            config.transcription_mode = value.clone();
        }
        if let Some(value) = &patch.custom_url {
            config.custom_url = value.clone();
        }
        if let Some(value) = &patch.custom_model {
            config.custom_model = value.clone();
        }
        if let Some(value) = &patch.local_model {
            config.local_model = value.clone();
        }
        if let Some(value) = patch.summary_enabled {
            config.summary_enabled = value;
        }
        if let Some(value) = &patch.summary_template {
            config.summary_template = value.clone();
        }
        if let Some(value) = &patch.summary_prompt {
            config.summary_prompt = value.clone();
        }
        if let Some(value) = &patch.summary_preset {
            config.summary_preset = value.clone();
        }
        if let Some(value) = &patch.kg_prompt {
            config.kg_prompt = value.clone();
        }
        if let Some(value) = &patch.kg_preset {
            config.kg_preset = value.clone();
        }
        if let Some(value) = patch.retention_days {
            config.retention_days = value;
        }
        Ok(())
    }

    fn set_api_key(&self, _api_key: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .config
            .api_key_configured = true;
        Ok(())
    }

    fn clear_api_key(&self) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .config
            .api_key_configured = false;
        Ok(())
    }

    fn install_model(&self, model_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.fail_model_install.clone() {
            return Err(error);
        }
        state.projection.models.push(MeetingModel {
            id: model_id.into(),
            title: model_id.into(),
            status: "installed".into(),
            bytes: 1,
            downloaded_bytes: 1,
            checksum: Some("verified".into()),
            error: None,
        });
        Ok(())
    }

    fn delete_model(&self, model_id: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .models
            .retain(|model| model.id != model_id);
        Ok(())
    }

    fn update_content(&self, meeting_id: &str, patch: &MeetingUpdatePatch) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let content = state.contents.entry(meeting_id.into()).or_default();
        if let Some(value) = &patch.title {
            content.title = Some(value.clone());
        }
        if let Some(value) = &patch.summary {
            content.summary = Some(value.clone());
        }
        if let Some(value) = &patch.tags {
            content.tags = value.clone();
        }
        Ok(())
    }

    fn set_kg_decision(&self, meeting_id: &str, decision: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .contents
            .entry(meeting_id.into())
            .or_default()
            .kg_decision = Some(decision.into());
        Ok(())
    }

    fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        state.deleted.push((meeting_id.into(), mode));
        if mode == MeetingDeleteMode::All {
            state.contents.entry(meeting_id.into()).or_default().deleted = true;
        }
        Ok(())
    }

    fn export_meeting(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, String> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.fail_export.clone() {
            return Err(error);
        }
        state.exports.push((meeting_id.into(), format));
        Ok(MeetingExport {
            format: match format {
                MeetingExportFormat::Markdown => "markdown",
                MeetingExportFormat::Json => "json",
                MeetingExportFormat::Audio => "audio",
                MeetingExportFormat::Files => "files",
            }
            .into(),
            path: format!("/tmp/{meeting_id}.export"),
        })
    }
}

#[derive(Default)]
struct FakeEvents {
    published: Mutex<Vec<MeetingEvent>>,
}

impl MeetingEventSink for FakeEvents {
    fn publish(&self, event: &MeetingEvent) -> Result<(), String> {
        self.published.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct FakeClock;

impl MeetingClock for FakeClock {
    fn now(&self) -> String {
        NOW.into()
    }
}

struct Fixture {
    runtime: MeetingRuntime,
    store: Arc<MeetingStore>,
    capture: Arc<FakeCapture>,
    transcription: Arc<FakeTranscription>,
    platform: Arc<FakePlatform>,
    events: Arc<FakeEvents>,
}

fn make_fixture() -> Fixture {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(FakeCapture::default());
    let transcription = Arc::new(FakeTranscription::default());
    let platform = Arc::new(FakePlatform::default());
    let events = Arc::new(FakeEvents::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone(),
        transcription.clone(),
        platform.clone(),
        Arc::new(FakeClock),
        events.clone(),
    )
    .unwrap();
    Fixture {
        runtime,
        store,
        capture,
        transcription,
        platform,
        events,
    }
}

fn start_request(runtime: &MeetingRuntime, request_id: &str) -> StartMeetingRequest {
    start_request_for_candidate(runtime, request_id, None)
}

fn start_request_for_candidate(
    runtime: &MeetingRuntime,
    request_id: &str,
    candidate_id: Option<&str>,
) -> StartMeetingRequest {
    StartMeetingRequest {
        request_id: Some(request_id.into()),
        title: Some("Release review".into()),
        workspace_path: Some("/workspace".into()),
        candidate_id: candidate_id.map(str::to_string),
        continue_meeting_id: None,
        consent_token: None,
        authorized_consent: Some(runtime.start_consent_context(candidate_id).unwrap()),
    }
}

#[test]
fn explicit_consent_single_active_and_idempotent_controls() {
    let fixture = make_fixture();
    let forged: StartMeetingRequest = serde_json::from_value(json!({
        "requestId": "forged",
        "consentToken": "renderer-controlled",
        "authorizedConsent": {
            "transcriptionMode": "local",
            "model": "whisper-small"
        }
    }))
    .unwrap();
    assert!(forged.authorized_consent.is_none());
    assert!(matches!(
        fixture.runtime.start(forged).unwrap_err(),
        MeetingRuntimeError::ConsentRequired
    ));

    let error = fixture
        .runtime
        .start(StartMeetingRequest {
            authorized_consent: None,
            ..start_request(&fixture.runtime, "without-consent")
        })
        .unwrap_err();
    assert!(matches!(error, MeetingRuntimeError::ConsentRequired));
    assert!(fixture.capture.starts.lock().unwrap().is_empty());

    let context_fixture = make_fixture();
    let authorized = start_request(&context_fixture.runtime, "changed-context");
    context_fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .config
        .local_model = "whisper-medium".into();
    assert!(matches!(
        context_fixture.runtime.start(authorized).unwrap_err(),
        MeetingRuntimeError::ConsentContextChanged
    ));
    assert!(context_fixture.capture.starts.lock().unwrap().is_empty());

    fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .config
        .microphone_device_id = Some("CoreAudio:stable-selected-mic".into());
    let first = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-1"))
        .unwrap();
    let meeting_id = first.active_meeting_id.clone().unwrap();
    let durable = fixture.store.get_meeting(&meeting_id).unwrap();
    assert_eq!(durable.metadata["transcriptionRoute"], "local");
    assert_eq!(durable.metadata["transcriptionModel"], "whisper-small");
    assert_eq!(
        durable.metadata["microphoneDeviceId"],
        "CoreAudio:stable-selected-mic"
    );
    assert_eq!(
        fixture.capture.starts.lock().unwrap()[0]
            .microphone_device_id
            .as_deref(),
        Some("CoreAudio:stable-selected-mic")
    );
    assert_eq!(
        fixture.transcription.starts.lock().unwrap()[0].route,
        "local"
    );
    let duplicate = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-1"))
        .unwrap();
    assert_eq!(
        duplicate.active_meeting_id.as_deref(),
        Some(meeting_id.as_str())
    );
    assert_eq!(fixture.capture.starts.lock().unwrap().len(), 1);

    let error = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-2"))
        .unwrap_err();
    assert!(matches!(error, MeetingRuntimeError::ActiveMeeting { .. }));

    let muted = fixture
        .runtime
        .set_microphone_muted(&meeting_id, true)
        .unwrap();
    let duplicate_mute = fixture
        .runtime
        .set_microphone_muted(&meeting_id, true)
        .unwrap();
    assert!(muted.meetings[0].mic_muted);
    assert_eq!(duplicate_mute.revision, muted.revision);
    assert_eq!(fixture.capture.mute_changes.lock().unwrap().len(), 1);

    // The current renderer does not supply requestId, so an identical
    // service request still has to be idempotent.
    let service_fixture = make_fixture();
    let service_request = StartMeetingRequest {
        request_id: None,
        ..start_request(&service_fixture.runtime, "ignored")
    };
    let first = service_fixture
        .runtime
        .start(service_request.clone())
        .unwrap();
    let duplicate = service_fixture.runtime.start(service_request).unwrap();
    assert_eq!(duplicate.active_meeting_id, first.active_meeting_id);
    assert_eq!(service_fixture.capture.starts.lock().unwrap().len(), 1);
}

#[test]
fn detected_start_rejects_stale_candidates_and_suppresses_the_accepted_prompt() {
    let fixture = make_fixture();
    fixture.platform.state.lock().unwrap().projection.candidates = vec![MeetingCandidate {
        id: "candidate-zoom".into(),
        app_id: "us.zoom.xos".into(),
        app_name: "Zoom".into(),
        detected_at: None,
        confidence: 0.95,
    }];

    let stale = fixture
        .runtime
        .start(StartMeetingRequest {
            candidate_id: Some("missing".into()),
            ..start_request(&fixture.runtime, "stale-candidate")
        })
        .unwrap_err();
    assert!(stale.to_string().contains("no longer available"));

    let started = fixture
        .runtime
        .start(start_request_for_candidate(
            &fixture.runtime,
            "accepted-candidate",
            Some("candidate-zoom"),
        ))
        .unwrap();
    assert!(started.candidates.is_empty());
    assert_eq!(
        fixture
            .platform
            .state
            .lock()
            .unwrap()
            .dismissed_candidates
            .clone(),
        vec!["candidate-zoom"]
    );
}

#[test]
fn listener_is_installed_before_snapshot_and_event_revisions_are_monotonic() {
    let fixture = make_fixture();
    let base = fixture.runtime.snapshot().unwrap();
    assert_eq!(base.revision, 0);

    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "ordered"))
        .unwrap();
    let events = fixture.events.published.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].revision > base.revision);
    assert_eq!(events[0].revision, started.revision);
    assert!(events[0].snapshot.is_none());
    assert!(
        serde_json::to_vec(&events[0]).unwrap().len() < 512,
        "meeting invalidation event exceeded its 512-byte payload budget"
    );
    drop(events);

    let reconciled = fixture.runtime.snapshot().unwrap();
    assert_eq!(reconciled.revision, started.revision);
    assert_eq!(reconciled.active_meeting_id, started.active_meeting_id);
}

#[test]
fn library_and_summary_projections_have_explicit_payload_budgets() {
    let fixture = make_fixture();
    for index in 0..=DEFAULT_MEETING_LIMIT {
        fixture
            .store
            .create_meeting(
                &MeetingDraft {
                    id: format!("scale-{index:03}"),
                    title: format!("Meeting {index}"),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                NOW,
            )
            .unwrap();
    }
    fixture
        .platform
        .state
        .lock()
        .unwrap()
        .contents
        .entry("scale-200".into())
        .or_default()
        .summary = Some("s".repeat(100_000));

    let snapshot = fixture.runtime.snapshot().unwrap();
    assert_eq!(snapshot.meetings.len(), DEFAULT_MEETING_LIMIT as usize);
    assert!(snapshot.meetings_truncated);
    let meeting = snapshot
        .meetings
        .iter()
        .find(|meeting| meeting.id == "scale-200")
        .unwrap();
    assert_eq!(
        meeting.summary.as_deref().unwrap().chars().count(),
        MAX_SUMMARY_PREVIEW_CHARS
    );
    assert!(meeting.summary_truncated);
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len() < 256 * 1024,
        "200-row meeting library exceeded its 256 KiB payload budget"
    );

    let detail = fixture
        .runtime
        .transcript_page("scale-200", None, None)
        .unwrap();
    assert_eq!(detail.summary.unwrap().len(), 100_000);
}

#[test]
fn real_time_batches_reject_stale_runs_and_are_idempotent() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "live-batch"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();
    let batch = TranscriptBatch {
        meeting_id: meeting_id.clone(),
        batch_id: "live-1".into(),
        base_revision: 0,
        source: "fake-live-stt".into(),
        observed_at: NOW.into(),
        marks_final: false,
        changes: vec![TranscriptChange::UpsertSegment {
            segment: TranscriptSegmentInput {
                id: "live-segment".into(),
                start_ms: 0,
                end_ms: 1_000,
                text: "partial".into(),
                channel_id: Some("microphone".into()),
                speaker: None,
                confidence: Some(0.8),
                is_final: false,
                metadata: json!({
                    "transcriptionRoute": "local",
                    "transcriptionModel": "whisper-small"
                }),
            },
        }],
    };

    let error = fixture
        .runtime
        .ingest_transcript_batch("stale-run", batch.clone())
        .unwrap_err();
    assert!(error.to_string().contains("stale"));

    let applied = fixture
        .runtime
        .ingest_transcript_batch(&run_id, batch.clone())
        .unwrap();
    let duplicate = fixture
        .runtime
        .ingest_transcript_batch(&run_id, batch)
        .unwrap();
    let meeting = applied
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.transcript_revision, 1);
    assert!(meeting.segments.is_empty());
    let page = fixture
        .runtime
        .transcript_page(&meeting_id, None, None)
        .unwrap();
    assert_eq!(page.segments[0].text, "partial");
    assert!(!page.segments[0].is_final);
    assert_eq!(duplicate.revision, applied.revision);
    assert_eq!(fixture.events.published.lock().unwrap().len(), 2);
}

#[test]
fn stop_finalizes_transcript_then_summary_then_offers_and_queues_kg() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "complete-flow"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();

    let stopped = fixture.runtime.stop(&meeting_id).unwrap();
    let meeting = stopped
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.lifecycle, "ready");
    assert_eq!(meeting.transcription, "final");
    assert!(meeting.transcript_final);
    assert!(meeting.segments.is_empty());
    assert_eq!(
        fixture
            .runtime
            .transcript_page(&meeting_id, None, None)
            .unwrap()
            .segments
            .len(),
        1
    );
    assert_eq!(meeting.summary_state, "queued");
    assert_eq!(meeting.kg_state, "not-offered");
    assert_eq!(meeting.jobs[0].kind, "title-summary");

    let duplicate_stop = fixture.runtime.stop(&meeting_id).unwrap();
    assert_eq!(duplicate_stop.revision, stopped.revision);
    assert_eq!(fixture.capture.stops.lock().unwrap().len(), 1);
    assert_eq!(fixture.store.list_jobs(&meeting_id).unwrap().len(), 1);

    let summary_job = fixture
        .runtime
        .claim_next_job("summary-worker", LEASE_END)
        .unwrap()
        .unwrap();
    let lease_token = summary_job.lease_token.clone().unwrap();
    let summarized = fixture
        .runtime
        .finish_job(
            &summary_job.definition.id,
            &lease_token,
            JobFinish::Succeeded {
                result: json!({
                    "title": "Release readiness",
                    "summary": "The team made production readiness a release gate."
                }),
            },
        )
        .unwrap();
    let meeting = summarized
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.title, "Release review");
    assert_eq!(
        meeting.summary.as_deref(),
        Some("The team made production readiness a release gate.")
    );
    assert_eq!(meeting.summary_state, "succeeded");
    assert_eq!(meeting.kg_state, "awaiting-decision");

    let proposed = fixture
        .runtime
        .decide_kg(&meeting_id, "create-draft")
        .unwrap();
    let meeting = proposed
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.kg_state, "draft-queued");
    assert_eq!(meeting.jobs.len(), 2);
    assert!(meeting.jobs.iter().any(|job| job.kind == "kg-proposal"));

    let duplicate = fixture
        .runtime
        .decide_kg(&meeting_id, "create-draft")
        .unwrap();
    let meeting = duplicate
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.jobs.len(), 2);
}

#[test]
fn stop_refreshes_revision_after_capture_records_reconnect_gap() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(ReconnectGapOnStopCapture {
        store: Arc::clone(&store),
    });
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture,
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "stop-during-reconnect"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();

    let stopped = runtime
        .stop(&meeting_id)
        .expect("Stop must refresh revisions committed while capture joins");

    let meeting = store.get_meeting(&meeting_id).unwrap();
    assert_eq!(meeting.status, MeetingStatus::Completed);
    assert_eq!(stopped.active_meeting_id, None);
    let overview = store.transcript_overview(&meeting_id, 10).unwrap();
    assert!(overview.is_final);
    assert_eq!(overview.unresolved_gap_count, 1);
    assert_eq!(overview.gaps[0].gap.id, "microphone-reconnect-gap");
}

#[test]
fn completed_meeting_continues_under_the_same_id_with_a_fresh_run() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "continuation-first-run"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let first_run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();
    fixture
        .store
        .stage_audio_chunk(
            &crate::meetings::AudioChunkDraft {
                id: format!("{meeting_id}-microphone-00000004"),
                meeting_id: meeting_id.clone(),
                channel_id: "microphone".into(),
                sequence: 4,
                start_ms: 4_000,
                end_ms: 5_000,
                sample_count: 16_000,
                byte_len: 64_000,
                sha256: "a".repeat(64),
                relative_path: format!("{meeting_id}/audio/microphone/00000004.f32le"),
            },
            NOW,
        )
        .unwrap();
    fixture
        .store
        .commit_audio_chunk(&format!("{meeting_id}-microphone-00000004"), NOW)
        .unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let final_before = fixture.store.get_meeting(&meeting_id).unwrap();
    assert_eq!(final_before.status, MeetingStatus::Completed);

    let mut request = start_request(&fixture.runtime, "continuation-second-run");
    request.title = None;
    request.continue_meeting_id = Some(meeting_id.clone());
    request.authorized_consent = Some(
        fixture
            .runtime
            .start_consent_context_for(None, Some(&meeting_id))
            .unwrap(),
    );
    let continued = fixture.runtime.start(request).unwrap();
    assert_eq!(
        continued.active_meeting_id.as_deref(),
        Some(meeting_id.as_str())
    );
    let continued_view = continued
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(continued_view.duration_ms, 5_000);
    assert!(continued_view.recording_started_at.is_some());
    let starts = fixture.capture.starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[1].meeting_id, meeting_id);
    assert_ne!(starts[1].run_id, first_run_id);
    assert_eq!(starts[1].first_sequence, 5);
    drop(starts);

    let reopened = fixture.store.get_meeting(&meeting_id).unwrap();
    assert_eq!(reopened.status, MeetingStatus::Recording);
    assert!(reopened.transcript_revision > final_before.transcript_revision);
    assert!(
        !fixture
            .store
            .transcript_overview(&meeting_id, 10)
            .unwrap()
            .is_final
    );

    fixture
        .runtime
        .handle_capture_failure(&meeting_id, &first_run_id, "late old-run failure")
        .unwrap();
    assert_eq!(
        fixture.store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Recording
    );

    let finalized = fixture.runtime.stop(&meeting_id).unwrap();
    assert!(finalized.active_meeting_id.is_none());
    assert_eq!(
        fixture.store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Completed
    );
    let completed_after_continuation = fixture.store.get_meeting(&meeting_id).unwrap();
    assert!(completed_after_continuation
        .metadata
        .get("continuationPreviousMetadata")
        .is_none());
    assert!(completed_after_continuation
        .metadata
        .get("continuationPreviousStoppedAt")
        .is_none());
    assert!(completed_after_continuation
        .metadata
        .get("continuationPreviousFinalizedAt")
        .is_none());
    assert!(
        fixture
            .store
            .transcript_overview(&meeting_id, 10)
            .unwrap()
            .is_final
    );
}

#[test]
fn failed_continuation_open_restores_the_exact_completed_transcript_and_pending_summary() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(
            &fixture.runtime,
            "continuation-rollback-first",
        ))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let completed = fixture.store.get_meeting(&meeting_id).unwrap();
    let pending_job = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.kind == FollowUpJobKind::Summary)
        .unwrap();
    assert_eq!(pending_job.state, JobState::Pending);
    *fixture.capture.fail_start.lock().unwrap() = Some("device open refused".into());

    let mut request = start_request(&fixture.runtime, "continuation-rollback-second");
    request.continue_meeting_id = Some(meeting_id.clone());
    request.authorized_consent = Some(
        fixture
            .runtime
            .start_consent_context_for(None, Some(&meeting_id))
            .unwrap(),
    );
    assert!(fixture.runtime.start(request).is_err());

    let restored = fixture.store.get_meeting(&meeting_id).unwrap();
    assert_eq!(restored.status, MeetingStatus::Completed);
    assert_eq!(restored.transcript_revision, completed.transcript_revision);
    assert_eq!(restored.stopped_at, completed.stopped_at);
    assert_eq!(restored.finalized_at, completed.finalized_at);
    assert_eq!(restored.metadata, completed.metadata);
    assert!(
        fixture
            .store
            .transcript_overview(&meeting_id, 10)
            .unwrap()
            .is_final
    );
    assert_eq!(
        fixture
            .store
            .list_jobs(&meeting_id)
            .unwrap()
            .into_iter()
            .find(|job| job.definition.id == pending_job.definition.id)
            .unwrap()
            .state,
        JobState::Pending
    );
    assert!(fixture
        .runtime
        .snapshot()
        .unwrap()
        .active_meeting_id
        .is_none());
}

#[test]
fn repeated_manual_job_retries_receive_monotonic_idempotency_generations() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "manual-retry-generations"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();

    for expected_generation in 1..=2 {
        let claimed = fixture
            .store
            .claim_next_job("retry-worker", NOW, LEASE_END)
            .unwrap()
            .unwrap();
        fixture
            .store
            .finish_job(
                &claimed.definition.id,
                claimed.lease_token.as_deref().unwrap(),
                &JobFinish::Failed {
                    error: "agent unavailable".into(),
                    retryable: false,
                    retry_at: None,
                },
                NOW,
            )
            .unwrap();
        fixture
            .runtime
            .retry_job(&meeting_id, "title-summary")
            .unwrap();
        let retry_key = format!("{meeting_id}:title-summary:retry:{expected_generation}");
        assert!(fixture
            .store
            .list_jobs(&meeting_id)
            .unwrap()
            .iter()
            .any(|job| job.definition.idempotency_key == retry_key));
    }
}

#[test]
fn completed_summary_can_run_again_with_the_current_template_and_agent_preset() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "regenerate-summary"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let claimed = fixture
        .store
        .claim_next_job("summary-worker", NOW, LEASE_END)
        .unwrap()
        .unwrap();
    fixture
        .store
        .finish_job(
            &claimed.definition.id,
            claimed.lease_token.as_deref().unwrap(),
            &JobFinish::Succeeded {
                result: json!({"title": "Original", "summary": "Original summary"}),
            },
            NOW,
        )
        .unwrap();
    fixture
        .runtime
        .update_config(MeetingConfigPatch {
            summary_template: Some("decisions-actions".into()),
            summary_prompt: Some(
                "Start with the decision. Name every owner and preserve explicit dates.".into(),
            ),
            summary_preset: Some("codex-review".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();

    fixture
        .runtime
        .retry_job(&meeting_id, "title-summary")
        .unwrap();

    let jobs = fixture.store.list_jobs(&meeting_id).unwrap();
    let rerun = jobs
        .iter()
        .find(|job| {
            job.definition
                .idempotency_key
                .ends_with("title-summary:retry:1")
        })
        .unwrap();
    assert_eq!(rerun.definition.payload["template"], "decisions-actions");
    assert_eq!(
        rerun.definition.payload["instructions"],
        "Start with the decision. Name every owner and preserve explicit dates."
    );
    assert_eq!(rerun.definition.payload["preset"], "codex-review");
    assert!(rerun
        .definition
        .idempotency_key
        .ends_with("title-summary:retry:1"));
}

#[test]
fn per_run_summary_uses_exact_recipe_without_mutating_global_defaults() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "fine-tuned-summary"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let claimed = fixture
        .store
        .claim_next_job("summary-worker", NOW, LEASE_END)
        .unwrap()
        .unwrap();
    fixture
        .store
        .finish_job(
            &claimed.definition.id,
            claimed.lease_token.as_deref().unwrap(),
            &JobFinish::Succeeded {
                result: json!({"title": "Original", "summary": "Original summary"}),
            },
            NOW,
        )
        .unwrap();
    let defaults = fixture.runtime.snapshot().unwrap().config;

    fixture
        .runtime
        .run_summary(
            &meeting_id,
            MeetingSummaryRunRequest {
                template: "brief".into(),
                prompt: "Lead with the decision, then list owners.".into(),
                preset: "codex-review".into(),
            },
        )
        .unwrap();

    let rerun = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| {
            job.definition
                .idempotency_key
                .ends_with("title-summary:retry:1")
        })
        .unwrap();
    assert_eq!(rerun.definition.payload["template"], "brief");
    assert_eq!(
        rerun.definition.payload["instructions"],
        "Lead with the decision, then list owners."
    );
    assert_eq!(rerun.definition.payload["preset"], "codex-review");
    assert_eq!(fixture.runtime.snapshot().unwrap().config, defaults);
}

#[test]
fn silent_terminal_meeting_completes_without_summary_job() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        Arc::new(EmptyTranscription),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "silent-meeting"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();

    runtime.stop(&meeting_id).unwrap();

    let meeting = runtime.meeting(&meeting_id).unwrap();
    assert_eq!(meeting.lifecycle, "ready");
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Completed
    );
    assert!(meeting.transcript_final);
    assert!(meeting.transcript_all_final);
    assert_eq!(meeting.segment_count, 0);
    assert!(!store
        .list_jobs(&meeting_id)
        .unwrap()
        .iter()
        .any(|job| job.definition.kind == FollowUpJobKind::Summary));
}

#[test]
fn stop_accepts_a_terminal_marker_after_the_provider_durably_drains_its_tail() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        Arc::new(DrainingTranscription {
            store: Arc::clone(&store),
        }),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "provider-tail"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();

    let stopped = runtime.stop(&meeting_id).unwrap();
    let meeting = stopped
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert!(meeting.transcript_final);
    assert!(meeting.segments.is_empty());
    let page = runtime.transcript_page(&meeting_id, None, None).unwrap();
    assert_eq!(page.segments.len(), 1);
    assert_eq!(
        page.segments[0].text,
        "The acknowledged provider tail is durable."
    );
}

#[test]
fn recovery_interrupts_capture_and_requeues_running_work() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-recovery".into(),
                title: "Recovery".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "denied".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "local",
                    "transcriptionModel": "whisper-small",
                    "runId": "run-recovery"
                }),
            },
            NOW,
        )
        .unwrap();
    store
        .transition_meeting(
            "meeting-recovery",
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    store
        .enqueue_job(
            &FollowUpJobDraft {
                id: "job-recovery".into(),
                meeting_id: "meeting-recovery".into(),
                kind: FollowUpJobKind::Custom("fixture-work".into()),
                idempotency_key: "recovery-fixture-work".into(),
                payload: json!({}),
                max_attempts: 3,
                not_before: NOW.into(),
            },
            NOW,
        )
        .unwrap();
    store
        .claim_next_job("worker", NOW, LEASE_END)
        .unwrap()
        .unwrap();

    let capture = Arc::new(FakeCapture::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone(),
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    let snapshot = runtime.snapshot().unwrap();
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.meetings[0].lifecycle, "interrupted");
    let jobs = store.list_jobs("meeting-recovery").unwrap();
    assert_eq!(
        jobs.iter()
            .find(|job| job.definition.id == "job-recovery")
            .unwrap()
            .state,
        JobState::Pending
    );
    assert!(jobs.iter().any(|job| {
        job.definition.kind == FollowUpJobKind::Custom("transcription".into())
            && job.state == JobState::Pending
    }));
    let transcription_job = jobs
        .iter()
        .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .unwrap();
    assert_eq!(
        transcription_job.definition.payload["transcriptionRoute"],
        "local"
    );
    assert_eq!(
        transcription_job.definition.payload["transcriptionModel"],
        "whisper-small"
    );
    let reports = capture.recoveries.lock().unwrap();
    assert_eq!(reports[0].interrupted_meeting_ids, vec!["meeting-recovery"]);
    assert_eq!(reports[0].requeued_job_ids, vec!["job-recovery"]);
    drop(reports);

    store
        .begin_transcript_repair(
            "meeting-recovery",
            "run-recovery",
            "repair-run-recovery",
            NOW,
        )
        .unwrap();
    store
        .stage_transcript_repair_batch(
            "run-recovery",
            "repair-run-recovery",
            &TranscriptBatch {
                meeting_id: "meeting-recovery".into(),
                batch_id: "recovery-segments".into(),
                base_revision: 0,
                source: "recovery-stt".into(),
                observed_at: NOW.into(),
                marks_final: false,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "recovered-segment".into(),
                        start_ms: 0,
                        end_ms: 2_000,
                        text: "Recovered audio was finalized.".into(),
                        channel_id: Some("microphone".into()),
                        speaker: None,
                        confidence: Some(0.9),
                        is_final: true,
                        metadata: json!({}),
                    },
                }],
            },
        )
        .unwrap();
    let recovered = runtime
        .complete_transcription_retry(
            "meeting-recovery",
            "run-recovery",
            "repair-run-recovery",
            TranscriptBatch {
                meeting_id: "meeting-recovery".into(),
                batch_id: "recovery-final".into(),
                base_revision: 0,
                source: "recovery-stt".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: Vec::new(),
            },
        )
        .unwrap();
    let meeting = recovered
        .meetings
        .iter()
        .find(|meeting| meeting.id == "meeting-recovery")
        .unwrap();
    assert_eq!(meeting.lifecycle, "ready");
    assert!(meeting.transcript_final);
    assert_eq!(meeting.summary_state, "queued");

    let duplicate = runtime
        .complete_transcription_retry(
            "meeting-recovery",
            "run-recovery",
            "repair-run-recovery",
            TranscriptBatch {
                meeting_id: "meeting-recovery".into(),
                batch_id: "ignored-redelivery".into(),
                base_revision: 1,
                source: "recovery-stt".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: Vec::new(),
            },
        )
        .unwrap();
    assert_eq!(duplicate.revision, recovered.revision);
}

#[test]
fn recovery_keeps_the_original_consented_route_after_global_provider_changes() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-consented-endpoint-a".into(),
                title: "Endpoint-bound recovery".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "granted".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "https://endpoint-a.example/v1/listen",
                    "transcriptionModel": "consented-model-a",
                    "runId": "run-consented-a"
                }),
            },
            NOW,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();

    let platform = Arc::new(FakePlatform::default());
    {
        let mut state = platform.state.lock().unwrap();
        state.projection.config.transcription_mode = "custom".into();
        state.projection.config.custom_url = "https://endpoint-b.example/v1/listen".into();
        state.projection.config.custom_model = "current-model-b".into();
        state.projection.config.api_key_configured = true;
    }
    MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        Arc::new(FakeTranscription::default()),
        platform,
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    let repair = store
        .list_jobs(&created.id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .expect("interrupted capture must receive one repair job");
    assert_eq!(
        repair.definition.payload["transcriptionRoute"],
        "https://endpoint-a.example/v1/listen"
    );
    assert_eq!(
        repair.definition.payload["transcriptionModel"],
        "consented-model-a"
    );
    assert_ne!(
        repair.definition.payload["transcriptionRoute"],
        "https://endpoint-b.example/v1/listen"
    );
}

#[test]
fn explicit_retranscription_replaces_pending_recovery_for_interrupted_audio() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-interrupted-retranscription".into(),
                title: "Interrupted retranscription".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "granted".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "local",
                    "transcriptionModel": "whisper-small",
                    "runId": "run-interrupted-retranscription"
                }),
            },
            NOW,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    store
        .stage_audio_chunk(
            &crate::meetings::AudioChunkDraft {
                id: "interrupted-source-chunk".into(),
                meeting_id: created.id.clone(),
                channel_id: "microphone".into(),
                sequence: 0,
                start_ms: 0,
                end_ms: 1_000,
                sample_count: 16_000,
                byte_len: 64_000,
                sha256: "c".repeat(64),
                relative_path: format!("{}/audio/microphone/00000000.f32le", created.id),
            },
            NOW,
        )
        .unwrap();
    store
        .commit_audio_chunk("interrupted-source-chunk", NOW)
        .unwrap();

    let platform = Arc::new(FakePlatform::default());
    {
        let mut state = platform.state.lock().unwrap();
        state.projection.config.transcription_mode = "custom".into();
        state.projection.config.custom_url = "https://current-provider.example/v1/listen".into();
        state.projection.config.custom_model = "current-model".into();
        state.projection.config.api_key_configured = true;
    }
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        Arc::new(FakeTranscription::default()),
        platform,
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    assert_eq!(
        store.get_meeting(&created.id).unwrap().status,
        MeetingStatus::Interrupted
    );
    runtime.retranscribe(&created.id).unwrap();

    let jobs = store.list_jobs(&created.id).unwrap();
    let automatic = jobs
        .iter()
        .find(|job| {
            job.definition.kind == FollowUpJobKind::Custom("transcription".into())
                && job.definition.payload["transcriptionIntent"] != "user-retranscription"
        })
        .expect("startup must have queued automatic recovery");
    assert_eq!(automatic.state, JobState::Cancelled);
    let requested = jobs
        .iter()
        .find(|job| job.definition.payload["transcriptionIntent"] == "user-retranscription")
        .expect("the human request must replace pending automatic recovery");
    assert_eq!(
        requested.definition.payload["transcriptionRoute"],
        "https://current-provider.example/v1/listen"
    );

    crate::meetings::jobs::execute_transcription_repair_with(
        &runtime,
        &ScriptedRetranscription {
            store: Arc::clone(&store),
            fail_finalize: false,
        },
        requested,
    )
    .unwrap();
    let recovered = store.get_meeting(&created.id).unwrap();
    assert_eq!(recovered.status, MeetingStatus::Completed);
    assert_eq!(recovered.transcript_revision, 1);
}

#[test]
fn explicit_retranscription_freezes_the_current_route_and_preserves_the_old_transcript() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(
            &fixture.runtime,
            "current-route-retranscription",
        ))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture
        .store
        .stage_audio_chunk(
            &crate::meetings::AudioChunkDraft {
                id: "retained-source-chunk".into(),
                meeting_id: meeting_id.clone(),
                channel_id: "microphone".into(),
                sequence: 0,
                start_ms: 0,
                end_ms: 1_000,
                sample_count: 16_000,
                byte_len: 64_000,
                sha256: "a".repeat(64),
                relative_path: format!("{meeting_id}/audio/microphone/00000000.f32le"),
            },
            NOW,
        )
        .unwrap();
    fixture
        .store
        .commit_audio_chunk("retained-source-chunk", NOW)
        .unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let original = fixture
        .runtime
        .transcript_page(&meeting_id, None, None)
        .unwrap();
    assert_eq!(original.revision, 1);
    assert_eq!(
        original.segments[0].text,
        "Production readiness is a release requirement."
    );

    {
        let mut state = fixture.platform.state.lock().unwrap();
        state.projection.config.transcription_mode = "custom".into();
        state.projection.config.custom_url = "https://current-provider.example/v1/listen".into();
        state.projection.config.custom_model = "current-model".into();
        state.projection.config.api_key_configured = true;
    }
    let queued = fixture.runtime.retranscribe(&meeting_id).unwrap();
    let view = queued
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(view.transcription, "batch");
    assert_eq!(view.transcript_revision, original.revision);
    let job = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.payload["transcriptionIntent"] == "user-retranscription")
        .unwrap();
    assert_eq!(
        job.definition.payload["transcriptionRoute"],
        "https://current-provider.example/v1/listen"
    );
    assert_eq!(
        job.definition.payload["transcriptionModel"],
        "current-model"
    );
    assert_ne!(
        job.definition.payload["transcriptionRoute"],
        fixture.store.get_meeting(&meeting_id).unwrap().metadata["transcriptionRoute"]
    );
    assert_eq!(
        fixture
            .runtime
            .transcript_page(&meeting_id, None, None)
            .unwrap(),
        original
    );
}

#[test]
fn retranscription_failure_keeps_the_old_revision_until_one_terminal_pass_commits() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "atomic-retranscription"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture
        .store
        .stage_audio_chunk(
            &crate::meetings::AudioChunkDraft {
                id: "atomic-source-chunk".into(),
                meeting_id: meeting_id.clone(),
                channel_id: "microphone".into(),
                sequence: 0,
                start_ms: 0,
                end_ms: 1_000,
                sample_count: 16_000,
                byte_len: 64_000,
                sha256: "b".repeat(64),
                relative_path: format!("{meeting_id}/audio/microphone/00000000.f32le"),
            },
            NOW,
        )
        .unwrap();
    fixture
        .store
        .commit_audio_chunk("atomic-source-chunk", NOW)
        .unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let original = fixture
        .runtime
        .transcript_page(&meeting_id, None, None)
        .unwrap();
    fixture.runtime.retranscribe(&meeting_id).unwrap();
    let job = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.payload["transcriptionIntent"] == "user-retranscription")
        .unwrap();

    let failure = crate::meetings::jobs::execute_transcription_repair_with(
        &fixture.runtime,
        &ScriptedRetranscription {
            store: Arc::clone(&fixture.store),
            fail_finalize: true,
        },
        &job,
    )
    .unwrap_err();
    assert!(failure.contains("failed before terminal commit"));
    assert_eq!(
        fixture
            .runtime
            .transcript_page(&meeting_id, None, None)
            .unwrap(),
        original
    );

    crate::meetings::jobs::execute_transcription_repair_with(
        &fixture.runtime,
        &ScriptedRetranscription {
            store: Arc::clone(&fixture.store),
            fail_finalize: false,
        },
        &job,
    )
    .unwrap();
    let replaced = fixture
        .runtime
        .transcript_page(&meeting_id, None, None)
        .unwrap();
    assert_eq!(replaced.revision, original.revision + 1);
    assert_eq!(replaced.segments.len(), 1);
    assert_eq!(
        replaced.segments[0].text,
        "Replacement produced by the current provider."
    );
    assert_eq!(
        fixture.store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Completed
    );

    let must_not_recontact = AlwaysFailTranscription::default();
    crate::meetings::jobs::execute_transcription_repair_with(
        &fixture.runtime,
        &must_not_recontact,
        &job,
    )
    .unwrap();
    assert!(must_not_recontact.starts.lock().unwrap().is_empty());
    assert!(must_not_recontact.finalizes.lock().unwrap().is_empty());
}

#[test]
fn explicit_retranscription_requires_committed_source_audio() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "no-source-retranscription"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();

    let error = fixture.runtime.retranscribe(&meeting_id).unwrap_err();
    assert!(error.to_string().contains("retained source audio"));
    assert!(!fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .iter()
        .any(|job| job.definition.payload["transcriptionIntent"] == "user-retranscription"));
}

#[test]
fn repeated_restarts_reuse_one_capture_generation_repair_owner() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-stable-repair".into(),
                title: "Stable repair".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "granted".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "local",
                    "transcriptionModel": "whisper-small",
                    "runId": "run-stable-generation"
                }),
            },
            NOW,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();

    let make_runtime = || {
        MeetingRuntime::new(
            Arc::clone(&store),
            Arc::new(FakeCapture::default()),
            Arc::new(FakeTranscription::default()),
            Arc::new(FakePlatform::default()),
            Arc::new(FakeClock),
            Arc::new(FakeEvents::default()),
        )
        .unwrap()
    };
    let first_runtime = make_runtime();
    let first = store.list_jobs(&created.id).unwrap();
    assert_eq!(first.len(), 1);
    let stable_id = first[0].definition.id.clone();
    let stable_key = first[0].definition.idempotency_key.clone();
    assert_eq!(
        first[0].definition.payload["captureGeneration"],
        "run-stable-generation"
    );
    store
        .claim_next_job("restart-worker-1", NOW, LEASE_END)
        .unwrap()
        .unwrap();
    drop(first_runtime);

    let second_runtime = make_runtime();
    let second = store.list_jobs(&created.id).unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].definition.id, stable_id);
    assert_eq!(second[0].definition.idempotency_key, stable_key);
    assert_eq!(second[0].state, JobState::Pending);
    store
        .claim_next_job("restart-worker-2", NOW, LEASE_END)
        .unwrap()
        .unwrap();
    drop(second_runtime);

    let _third_runtime = make_runtime();
    let third = store.list_jobs(&created.id).unwrap();
    assert_eq!(third.len(), 1);
    assert_eq!(third[0].definition.id, stable_id);
    assert_eq!(third[0].definition.idempotency_key, stable_key);
    assert_eq!(third[0].state, JobState::Pending);
    assert_eq!(third[0].attempts, 2);
}

#[test]
fn startup_completes_terminal_batch_before_lifecycle_without_stt_disclosure() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-terminal-before-lifecycle".into(),
                title: "Terminal crash window".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "denied".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "https://never-contact.example/listen",
                    "transcriptionModel": "never-disclose",
                    "runId": "run-terminal-crash"
                }),
            },
            NOW,
        )
        .unwrap();
    let recording = store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    let stopping = store
        .transition_meeting(
            &created.id,
            recording.revision,
            MeetingStatus::Stopping,
            NOW,
            None,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            stopping.revision,
            MeetingStatus::Finalizing,
            NOW,
            None,
        )
        .unwrap();
    store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: created.id.clone(),
            batch_id: "terminal-before-lifecycle".into(),
            base_revision: 0,
            source: "live-custom".into(),
            observed_at: NOW.into(),
            marks_final: true,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "terminal-segment".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "The provider terminal batch was already durable.".into(),
                    channel_id: Some("microphone".into()),
                    speaker: None,
                    confidence: Some(0.99),
                    is_final: true,
                    metadata: json!({
                        "owner": "stt",
                        "providerRunId": "run-terminal-crash"
                    }),
                },
            }],
        })
        .unwrap();
    let transcription = Arc::new(FakeTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    let meeting = runtime.meeting(&created.id).unwrap();
    assert_eq!(meeting.lifecycle, "ready");
    assert!(meeting.transcript_final);
    assert!(meeting.transcript_all_final);
    assert!(transcription.starts.lock().unwrap().is_empty());
    let jobs = store.list_jobs(&created.id).unwrap();
    assert_eq!(
        jobs.iter()
            .filter(|job| job.definition.kind == FollowUpJobKind::Summary)
            .count(),
        1
    );
    assert!(!jobs
        .iter()
        .any(|job| { job.definition.kind == FollowUpJobKind::Custom("transcription".into()) }));
}

#[test]
fn startup_preserves_capture_failure_intent_across_terminal_crash_window() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-failed-terminal-crash".into(),
                title: "Failure terminal crash".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "denied".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "local://whisper-small",
                    "transcriptionModel": "whisper-small",
                    "runId": "run-failed-terminal-crash"
                }),
            },
            NOW,
        )
        .unwrap();
    let recording = store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    let failure = MeetingFailure {
        code: "capture-runtime-failed".into(),
        message: "disk writer failed".into(),
        retryable: true,
    };
    let interrupted = store
        .transition_meeting(
            &created.id,
            recording.revision,
            MeetingStatus::Interrupted,
            NOW,
            Some(&failure),
        )
        .unwrap();
    store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: created.id.clone(),
            batch_id: "failed-terminal-before-lifecycle".into(),
            base_revision: interrupted.transcript_revision,
            source: "live-local".into(),
            observed_at: NOW.into(),
            marks_final: true,
            changes: Vec::new(),
        })
        .unwrap();
    let transcription = Arc::new(FakeTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    let recovered = store.get_meeting(&created.id).unwrap();
    assert_eq!(recovered.status, MeetingStatus::Failed);
    assert_eq!(
        recovered
            .failure
            .as_ref()
            .map(|failure| failure.code.as_str()),
        Some("capture-runtime-failed")
    );
    assert!(store.list_jobs(&created.id).unwrap().is_empty());
    assert!(transcription.starts.lock().unwrap().is_empty());
    assert_eq!(runtime.meeting(&created.id).unwrap().lifecycle, "failed");
}

#[test]
fn startup_repairs_a_terminal_transcript_after_promoting_staged_audio_tail() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-staged-tail".into(),
                title: "Staged audio tail".into(),
                origin: MeetingOrigin::default(),
                channels: capture_channels(&MeetingPermissions {
                    microphone: "granted".into(),
                    system_audio: "denied".into(),
                }),
                metadata: json!({
                    "transcriptionRoute": "local://whisper-small",
                    "transcriptionModel": "whisper-small",
                    "runId": "run-staged-tail"
                }),
            },
            NOW,
        )
        .unwrap();
    let recording = store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    let stopping = store
        .transition_meeting(
            &created.id,
            recording.revision,
            MeetingStatus::Stopping,
            NOW,
            None,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            stopping.revision,
            MeetingStatus::Finalizing,
            NOW,
            None,
        )
        .unwrap();
    store
        .stage_audio_chunk(
            &crate::meetings::AudioChunkDraft {
                id: "staged-tail-chunk".into(),
                meeting_id: created.id.clone(),
                channel_id: "microphone".into(),
                sequence: 0,
                start_ms: 0,
                end_ms: 1_000,
                sample_count: 48_000,
                byte_len: 192_000,
                sha256: "a".repeat(64),
                relative_path: format!("{}/audio/microphone/00000000.f32le", created.id),
            },
            NOW,
        )
        .unwrap();
    store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: created.id.clone(),
            batch_id: "terminal-before-staged-promotion".into(),
            base_revision: 0,
            source: "live-local".into(),
            observed_at: NOW.into(),
            marks_final: true,
            changes: Vec::new(),
        })
        .unwrap();
    let transcription = Arc::new(FakeTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(PromotingRecoveryCapture {
            store: Arc::clone(&store),
        }),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    assert_eq!(
        store.get_meeting(&created.id).unwrap().status,
        MeetingStatus::Interrupted
    );
    assert!(store.has_committed_audio(&created.id).unwrap());
    let jobs = store.list_jobs(&created.id).unwrap();
    assert_eq!(
        jobs.iter()
            .filter(|job| {
                job.definition.kind == FollowUpJobKind::Custom("transcription".into())
            })
            .count(),
        1
    );
    assert!(!jobs
        .iter()
        .any(|job| job.definition.kind == FollowUpJobKind::Summary));
    assert!(transcription.starts.lock().unwrap().is_empty());
    assert_eq!(
        runtime.meeting(&created.id).unwrap().lifecycle,
        "interrupted"
    );
}

#[test]
fn completed_repair_job_redelivery_performs_zero_provider_work() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "repair-redelivery"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let starts_before = fixture.transcription.starts.lock().unwrap().len();
    let finalizes_before = fixture.transcription.finalizes.lock().unwrap().len();
    let jobs_before = fixture.store.list_jobs(&meeting_id).unwrap();
    let job = FollowUpJob {
        definition: FollowUpJobDraft {
            id: "job-transcription-run-redelivery".into(),
            meeting_id: meeting_id.clone(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key: format!("{meeting_id}:transcription:run-redelivery"),
            payload: json!({
                "captureGeneration": "run-redelivery",
                "transcriptionRoute": "https://must-not-contact.example/listen",
                "transcriptionModel": "must-not-load"
            }),
            max_attempts: 3,
            not_before: NOW.into(),
        },
        state: JobState::Running,
        attempts: 2,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        lease_owner: Some("redelivery-worker".into()),
        lease_token: Some("redelivery-lease".into()),
        lease_expires_at: Some(LEASE_END.into()),
        last_error: None,
        result: None,
    };

    let result = crate::meetings::jobs::execute_transcription_repair_with(
        &fixture.runtime,
        fixture.transcription.as_ref(),
        &job,
    )
    .unwrap();
    assert_eq!(result["transcriptFinal"], true);
    assert_eq!(
        fixture.transcription.starts.lock().unwrap().len(),
        starts_before
    );
    assert_eq!(
        fixture.transcription.finalizes.lock().unwrap().len(),
        finalizes_before
    );
    assert_eq!(fixture.store.list_jobs(&meeting_id).unwrap(), jobs_before);
}

#[test]
fn repair_retry_refuses_to_replace_a_transcript_after_source_audio_is_gone() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let transcription = Arc::new(AlwaysFailTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "repair-without-source"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
    runtime
        .handle_capture_failure(&meeting_id, &run_id, "capture failed")
        .unwrap();
    let repair = store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .unwrap();
    let starts_before = transcription.starts.lock().unwrap().len();

    let error = crate::meetings::jobs::execute_transcription_repair_with(
        &runtime,
        transcription.as_ref(),
        &repair,
    )
    .unwrap_err();
    assert!(error.contains("no committed source audio"));
    assert_eq!(transcription.starts.lock().unwrap().len(), starts_before);
}

#[test]
fn failed_terminal_repair_redelivery_performs_zero_provider_or_audio_work() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let transcription = Arc::new(FakeTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "failed-repair-redelivery"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
    runtime
        .handle_capture_failure(&meeting_id, &run_id, "capture failed")
        .unwrap();
    let starts_before = transcription.starts.lock().unwrap().len();
    let finalizes_before = transcription.finalizes.lock().unwrap().len();
    let repair = FollowUpJob {
        definition: FollowUpJobDraft {
            id: "failed-terminal-redelivery".into(),
            meeting_id: meeting_id.clone(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key: format!("{meeting_id}:transcription:{run_id}"),
            payload: json!({
                "captureGeneration": run_id,
                "transcriptionRoute": "https://must-not-contact.example/listen",
                "transcriptionModel": "must-not-load"
            }),
            max_attempts: 3,
            not_before: NOW.into(),
        },
        state: JobState::Running,
        attempts: 2,
        created_at: NOW.into(),
        updated_at: NOW.into(),
        lease_owner: Some("redelivery-worker".into()),
        lease_token: Some("redelivery-lease".into()),
        lease_expires_at: Some(LEASE_END.into()),
        last_error: None,
        result: None,
    };

    let result = crate::meetings::jobs::execute_transcription_repair_with(
        &runtime,
        transcription.as_ref(),
        &repair,
    )
    .unwrap();
    assert_eq!(result["transcriptFinal"], true);
    assert_eq!(transcription.starts.lock().unwrap().len(), starts_before);
    assert_eq!(
        transcription.finalizes.lock().unwrap().len(),
        finalizes_before
    );
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Failed
    );
}

#[test]
fn failed_capture_worker_and_stop_race_enqueue_exactly_one_repair() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(FakeCapture::default());
    let transcription = Arc::new(AlwaysFailTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture,
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "capture-stop-race"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
    let barrier = Arc::new(Barrier::new(3));
    let stop_runtime = runtime.clone();
    let stop_meeting = meeting_id.clone();
    let stop_barrier = Arc::clone(&barrier);
    let stop = thread::spawn(move || {
        stop_barrier.wait();
        stop_runtime.stop(&stop_meeting)
    });
    let failure_runtime = runtime.clone();
    let failure_meeting = meeting_id.clone();
    let failure_run = run_id.clone();
    let failure_barrier = Arc::clone(&barrier);
    let failure = thread::spawn(move || {
        failure_barrier.wait();
        failure_runtime.handle_capture_failure(
            &failure_meeting,
            &failure_run,
            "native worker failed",
        )
    });
    barrier.wait();
    stop.join().unwrap().unwrap();
    failure.join().unwrap().unwrap();

    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Interrupted
    );
    assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
    let jobs = store.list_jobs(&meeting_id).unwrap();
    let repairs = jobs
        .iter()
        .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .collect::<Vec<_>>();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].state, JobState::Pending);
    assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
    assert_eq!(
        repairs[0].definition.idempotency_key,
        format!("{meeting_id}:transcription:{run_id}")
    );
}

#[test]
fn stop_winning_failed_worker_race_enqueues_repair_before_delayed_callback() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(EndedWorkerCapture::default());
    let transcription = Arc::new(SessionOwningFailTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone(),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "ended-worker-stop-race"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = capture.starts.lock().unwrap()[0].run_id.clone();

    let stop_error = runtime.stop(&meeting_id).unwrap_err();
    assert!(stop_error.to_string().contains("already ended"));
    // The native failure notifier was queued before Stop but arrives only
    // after Stop released the operation lock.
    runtime
        .handle_capture_failure(
            &meeting_id,
            &run_id,
            "capture worker already ended after a durable chunk failure",
        )
        .unwrap();

    let snapshot = runtime.snapshot().unwrap();
    assert!(snapshot.active_meeting_id.is_none());
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Interrupted
    );
    assert_eq!(capture.stops.lock().unwrap().len(), 1);
    let repairs = store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .collect::<Vec<_>>();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].state, JobState::Pending);
    assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
    transcription
        .start(&TranscriptionStart {
            meeting_id: meeting_id.clone(),
            run_id: format!("repair-{run_id}"),
            route: repairs[0].definition.payload["transcriptionRoute"]
                .as_str()
                .unwrap()
                .into(),
            model: repairs[0].definition.payload["transcriptionModel"]
                .as_str()
                .unwrap()
                .into(),
            first_sequence: 0,
            repair_generation: Some(run_id.clone()),
            repair_intent: None,
        })
        .expect("Stop must remove the live transcription session before repair");
    assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
    assert_eq!(transcription.starts.lock().unwrap().len(), 2);
}

#[test]
fn renderer_dto_uses_exact_final_and_projection_fields() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "serde-shape"))
        .unwrap();
    let snapshot = fixture
        .runtime
        .stop(started.active_meeting_id.as_deref().unwrap())
        .unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    let meeting = &value["meetings"][0];
    for field in [
        "lifecycle",
        "transcription",
        "segments",
        "summaryState",
        "kgState",
        "jobs",
    ] {
        assert!(
            meeting.get(field).is_some(),
            "missing renderer field {field}"
        );
    }
    assert_eq!(meeting["segments"], json!([]));
    let page = fixture
        .runtime
        .transcript_page(started.active_meeting_id.as_deref().unwrap(), None, None)
        .unwrap();
    let page = serde_json::to_value(page).unwrap();
    assert_eq!(page["segments"][0]["final"], true);
    assert!(page["segments"][0].get("final_").is_none());

    let clear_retention: MeetingConfigPatch =
        serde_json::from_value(json!({ "retentionDays": null })).unwrap();
    let omitted_retention: MeetingConfigPatch = serde_json::from_value(json!({})).unwrap();
    assert_eq!(clear_retention.retention_days, Some(None));
    assert_eq!(omitted_retention.retention_days, None);
    let clear_microphone: MeetingConfigPatch =
        serde_json::from_value(json!({ "microphoneDeviceId": null })).unwrap();
    let omitted_microphone: MeetingConfigPatch = serde_json::from_value(json!({})).unwrap();
    assert_eq!(clear_microphone.microphone_device_id, Some(None));
    assert_eq!(omitted_microphone.microphone_device_id, None);
}

#[test]
fn external_operations_propagate_real_port_failures() {
    let fixture = make_fixture();
    fixture.platform.state.lock().unwrap().fail_model_install = Some("checksum mismatch".into());
    let error = fixture.runtime.install_model("whisper-small").unwrap_err();
    assert!(error.to_string().contains("checksum mismatch"));
    assert!(fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .models
        .is_empty());

    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "export-error"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    fixture.platform.state.lock().unwrap().fail_export = Some("destination unavailable".into());
    let error = fixture
        .runtime
        .export(&meeting_id, MeetingExportFormat::Markdown)
        .unwrap_err();
    assert!(error.to_string().contains("destination unavailable"));
    assert!(fixture.platform.state.lock().unwrap().exports.is_empty());
}

#[test]
fn mtg_153_running_activity_only_releases_deletion_wait_and_cannot_recreate_content() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "deletion-authority"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let running = fixture
        .runtime
        .claim_next_job("activity-worker", LEASE_END)
        .unwrap()
        .unwrap();

    let error = fixture
        .runtime
        .delete(&meeting_id, MeetingDeleteMode::All)
        .unwrap_err();
    assert!(matches!(
        error,
        MeetingRuntimeError::Store(MeetingStoreError::DeletionBlocked {
            running_jobs: 1,
            ..
        })
    ));
    assert!(fixture
        .runtime
        .update_meeting(
            &meeting_id,
            MeetingUpdatePatch {
                title: Some("late Activity title".into()),
                summary: Some("late Activity summary".into()),
                tags: None,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("being permanently deleted"));
    assert!(!fixture
        .platform
        .state
        .lock()
        .unwrap()
        .contents
        .contains_key(&meeting_id));

    fixture
        .runtime
        .finish_job(
            &running.definition.id,
            running.lease_token.as_deref().unwrap(),
            JobFinish::Succeeded {
                result: json!({
                    "title": "must be discarded",
                    "summary": "must be discarded"
                }),
            },
        )
        .unwrap();
    let job = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.id == running.definition.id)
        .unwrap();
    assert_eq!(job.state, JobState::Cancelled);
    assert!(job.result.is_none());
    assert_eq!(
        fixture.store.deletion(&meeting_id).unwrap().unwrap().stage,
        MeetingDeletionStage::FilesPending
    );
    let state = fixture.platform.state.lock().unwrap();
    assert_eq!(
        state.deleted,
        [(meeting_id.clone(), MeetingDeleteMode::All)]
    );
    assert!(state.contents.get(&meeting_id).unwrap().deleted);
}

#[test]
fn capture_start_failure_is_durable_and_never_reported_as_success() {
    let fixture = make_fixture();
    *fixture.capture.fail_start.lock().unwrap() = Some("device busy".into());
    let error = fixture
        .runtime
        .start(start_request(&fixture.runtime, "capture-error"))
        .unwrap_err();
    assert!(error.to_string().contains("device busy"));
    let meetings = fixture.store.list_meetings(10).unwrap();
    assert_eq!(meetings.len(), 1);
    assert_eq!(meetings[0].status, MeetingStatus::Failed);
    assert_eq!(
        meetings[0].failure.as_ref().unwrap().code,
        "capture-start-failed"
    );
    assert!(fixture
        .runtime
        .snapshot()
        .unwrap()
        .active_meeting_id
        .is_none());
}

#[test]
fn capture_worker_starts_only_after_durable_runtime_ownership_exists() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(AuthorityCheckingCapture {
        store: Arc::clone(&store),
        observed_status: Mutex::new(None),
    });
    let runtime = MeetingRuntime::new(
        store,
        capture.clone(),
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    runtime
        .start(start_request(&runtime, "durable-before-worker"))
        .unwrap();
    assert_eq!(
        *capture.observed_status.lock().unwrap(),
        Some(MeetingStatus::Recording)
    );
}

#[test]
fn mtg_046_mid_session_capture_failure_is_immediately_durable_and_visible() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "mid-session-failure"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();

    fixture.runtime.capture_failed(
        &meeting_id,
        &run_id,
        "disk reserve was exhausted while committing microphone audio",
    );

    let snapshot = fixture.runtime.snapshot().unwrap();
    assert!(snapshot.active_meeting_id.is_none());
    let meeting = snapshot
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.lifecycle, "failed");
    assert!(meeting.transcript_final);
    assert!(meeting.error.as_deref().unwrap().contains("disk reserve"));
    assert_eq!(
        fixture
            .store
            .get_meeting(&meeting_id)
            .unwrap()
            .failure
            .as_ref()
            .map(|failure| failure.code.as_str()),
        Some("capture-runtime-failed")
    );
    assert_eq!(fixture.capture.stops.lock().unwrap().len(), 1);
    assert!(fixture
        .events
        .published
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == "capture-runtime-failed"));

    // A late callback from a superseded worker cannot damage the already
    // reconciled record.
    fixture
        .runtime
        .capture_failed(&meeting_id, "stale-run", "late device error");
    assert_eq!(
        fixture.store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Failed
    );
}

#[test]
fn capture_failure_is_visible_before_slow_transcription_drain() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let events = Arc::new(FakeEvents::default());
    let transcription = Arc::new(FailureOrderingTranscription {
        store: Arc::clone(&store),
        events: Arc::clone(&events),
        observed_interrupted_before_finalize: Mutex::new(false),
    });
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        events,
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "visible-before-drain"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = runtime.active().unwrap().as_ref().unwrap().run_id.clone();

    runtime.capture_failed(
        &meeting_id,
        &run_id,
        "disk reserve was exhausted while persisting audio",
    );

    assert!(*transcription
        .observed_interrupted_before_finalize
        .lock()
        .unwrap());
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Failed
    );
}

#[test]
fn native_capture_failure_sink_does_not_keep_runtime_alive() {
    let runtime = MeetingRuntime::new(
        Arc::new(MeetingStore::open_in_memory().unwrap()),
        Arc::new(FakeCapture::default()),
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let weak_inner = Arc::downgrade(&runtime.inner);
    let sink = runtime.capture_failure_sink();

    drop(runtime);

    assert!(weak_inner.upgrade().is_none());
    sink.capture_failed("ended-meeting", "ended-run", "late worker completion");
}
