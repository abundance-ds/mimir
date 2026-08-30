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

