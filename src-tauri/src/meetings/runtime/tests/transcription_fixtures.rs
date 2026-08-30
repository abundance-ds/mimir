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

