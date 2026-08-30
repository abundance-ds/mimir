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

