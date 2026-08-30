#[test]
fn gherkin_job_idempotency_rejects_same_key_with_different_intent() {
    let store = store();
    start_recording(&store);
    let draft = job("job-1", "summary:on-stop", 3);
    assert!(!store.enqueue_job(&draft, T1).unwrap().1);
    let mut replay = draft.clone();
    replay.id = "job-retry-request".into();
    let (original, duplicate) = store.enqueue_job(&replay, T2).unwrap();
    assert!(duplicate);
    assert_eq!(original.definition.id, "job-1");
    let mut conflicting = draft.clone();
    conflicting.id = "job-conflicting-request".into();
    conflicting.payload = json!({"prompt": "Do something else"});
    assert!(matches!(
        store.enqueue_job(&conflicting, T2),
        Err(MeetingStoreError::IdempotencyConflict { .. })
    ));
    assert_eq!(store.list_jobs("meeting-1").unwrap().len(), 1);
}

#[test]
fn gherkin_job_lease_blocks_stale_worker_completion_and_retries_with_budget() {
    let store = store();
    start_recording(&store);
    store
        .enqueue_job(&job("job-1", "summary:on-stop", 2), T1)
        .unwrap();
    let first = store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();
    assert_eq!(first.attempts, 1);
    let token = first.lease_token.clone().unwrap();
    let retry = store
        .finish_job(
            "job-1",
            &token,
            &JobFinish::Failed {
                error: "temporary provider failure".into(),
                retryable: true,
                retry_at: Some(T2.into()),
            },
            T1,
        )
        .unwrap();
    assert_eq!(retry.state, JobState::Pending);

    let second = store.claim_next_job("worker-2", T2, T3).unwrap().unwrap();
    assert_eq!(second.attempts, 2);
    assert!(matches!(
        store.finish_job(
            "job-1",
            &token,
            &JobFinish::Succeeded { result: json!({}) },
            T2
        ),
        Err(MeetingStoreError::LeaseLost { .. })
    ));
    let exhausted = store
        .finish_job(
            "job-1",
            second.lease_token.as_deref().unwrap(),
            &JobFinish::Failed {
                error: "still failing".into(),
                retryable: true,
                retry_at: Some(T3.into()),
            },
            T2,
        )
        .unwrap();
    assert_eq!(exhausted.state, JobState::Failed);
}

#[test]
fn gherkin_an_expired_live_lease_is_reclaimed_without_an_app_restart() {
    let store = store();
    start_recording(&store);
    store
        .enqueue_job(&job("job-1", "summary:on-stop", 2), T1)
        .unwrap();
    let abandoned = store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();
    let reclaimed = store.claim_next_job("worker-2", T2, T3).unwrap().unwrap();
    assert_eq!(reclaimed.definition.id, "job-1");
    assert_eq!(reclaimed.attempts, 2);
    assert_ne!(reclaimed.lease_token, abandoned.lease_token);
    assert!(matches!(
        store.finish_job(
            "job-1",
            abandoned.lease_token.as_deref().unwrap(),
            &JobFinish::Succeeded { result: json!({}) },
            T2
        ),
        Err(MeetingStoreError::LeaseLost { .. })
    ));
}

#[test]
fn gherkin_recovery_reports_staged_audio_until_integrity_is_decided() {
    let store = store();
    start_recording(&store);
    let chunk = AudioChunkDraft {
        id: "chunk-1".into(),
        meeting_id: "meeting-1".into(),
        channel_id: "system".into(),
        sequence: 0,
        start_ms: 0,
        end_ms: 1_000,
        sample_count: 48_000,
        byte_len: 192_000,
        sha256: "a".repeat(64),
        relative_path: "meeting-1/system/000000.flac".into(),
    };
    store.stage_audio_chunk(&chunk, T1).unwrap();
    assert_eq!(
        store
            .recover_after_restart(T2)
            .unwrap()
            .staged_audio_chunks
            .len(),
        1
    );
    let corrupt = store
        .mark_audio_chunk_corrupt("chunk-1", "sha256 mismatch", T2)
        .unwrap();
    assert_eq!(corrupt.status, AudioChunkStatus::Corrupt);
    assert_eq!(corrupt.integrity_error.as_deref(), Some("sha256 mismatch"));
    assert!(store
        .recover_after_restart(T3)
        .unwrap()
        .staged_audio_chunks
        .is_empty());
}

#[test]
fn gherkin_restart_recovery_is_durable_conservative_and_idempotent() {
    let store = store();
    start_recording(&store);
    let chunk = AudioChunkDraft {
        id: "chunk-1".into(),
        meeting_id: "meeting-1".into(),
        channel_id: "system".into(),
        sequence: 0,
        start_ms: 0,
        end_ms: 1_000,
        sample_count: 48_000,
        byte_len: 192_000,
        sha256: "a".repeat(64),
        relative_path: "meeting-1/system/000000.flac".into(),
    };
    store.stage_audio_chunk(&chunk, T1).unwrap();
    let committed_chunk = AudioChunkDraft {
        id: "chunk-committed".into(),
        meeting_id: "meeting-1".into(),
        channel_id: "mic".into(),
        sequence: 0,
        start_ms: 0,
        end_ms: 42_000,
        sample_count: 2_016_000,
        byte_len: 8_064_000,
        sha256: "b".repeat(64),
        relative_path: "meeting-1/mic/000000.f32le".into(),
    };
    store.stage_audio_chunk(&committed_chunk, T1).unwrap();
    store.commit_audio_chunk(&committed_chunk.id, T1).unwrap();
    store
        .enqueue_job(&job("job-1", "summary:on-stop", 3), T1)
        .unwrap();
    store.claim_next_job("worker-1", T1, T2).unwrap().unwrap();

    let first = store.recover_after_restart(T2).unwrap();
    assert_eq!(first.interrupted_meeting_ids, ["meeting-1"]);
    assert_eq!(first.requeued_job_ids, ["job-1"]);
    assert_eq!(first.staged_audio_chunks.len(), 1);
    let recovered = store.get_meeting("meeting-1").unwrap();
    assert_eq!(recovered.status, MeetingStatus::Interrupted);
    assert_eq!(recovered.recovery_count, 1);
    assert_eq!(
        recovered.stopped_at.as_deref(),
        Some("2026-07-30T10:01:42.000Z")
    );
    assert_eq!(
        store.list_jobs("meeting-1").unwrap()[0].state,
        JobState::Pending
    );

    let second = store.recover_after_restart(T3).unwrap();
    assert!(second.interrupted_meeting_ids.is_empty());
    assert!(second.requeued_job_ids.is_empty());
    assert_eq!(second.staged_audio_chunks.len(), 1);
    assert_eq!(store.get_meeting("meeting-1").unwrap().recovery_count, 1);
}

