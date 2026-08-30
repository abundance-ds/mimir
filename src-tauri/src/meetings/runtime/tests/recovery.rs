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

