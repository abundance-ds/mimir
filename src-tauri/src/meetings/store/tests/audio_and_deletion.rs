#[test]
fn gherkin_audio_chunk_staging_is_exactly_once_and_commit_is_idempotent() {
    let store = store();
    start_recording(&store);
    let chunk = AudioChunkDraft {
        id: "chunk-1".into(),
        meeting_id: "meeting-1".into(),
        channel_id: "mic".into(),
        sequence: 0,
        start_ms: 0,
        end_ms: 1_000,
        sample_count: 48_000,
        byte_len: 192_000,
        sha256: "a".repeat(64),
        relative_path: "meeting-1/mic/000000.flac".into(),
    };
    assert_eq!(
        store.stage_audio_chunk(&chunk, T1).unwrap().status,
        AudioChunkStatus::Staged
    );
    assert_eq!(
        store.stage_audio_chunk(&chunk, T2).unwrap().status,
        AudioChunkStatus::Staged
    );
    let mut conflicting = chunk.clone();
    conflicting.sha256 = "b".repeat(64);
    assert!(matches!(
        store.stage_audio_chunk(&conflicting, T2),
        Err(MeetingStoreError::IdempotencyConflict { .. })
    ));
    let committed = store.commit_audio_chunk(&chunk.id, T2).unwrap();
    assert_eq!(committed.status, AudioChunkStatus::Committed);
    assert_eq!(
        store
            .commit_audio_chunk(&chunk.id, T3)
            .unwrap()
            .committed_at,
        committed.committed_at
    );
}

#[test]
fn committed_audio_projection_is_status_filtered_keyset_ordered_and_bounded() {
    let store = store();
    start_recording(&store);
    for sequence in 0..4 {
        let chunk = AudioChunkDraft {
            id: format!("chunk-{sequence}"),
            meeting_id: "meeting-1".into(),
            channel_id: "mic".into(),
            sequence,
            start_ms: (sequence * 1_000) as i64,
            end_ms: (sequence * 1_000 + 1) as i64,
            sample_count: 1,
            byte_len: 4,
            sha256: format!("{sequence:x}").repeat(64),
            relative_path: format!("meeting-1/audio/mic/{sequence:08}.f32le"),
        };
        store.stage_audio_chunk(&chunk, T1).unwrap();
    }
    store.commit_audio_chunk("chunk-1", T2).unwrap();
    store
        .mark_audio_chunk_corrupt("chunk-2", "fixture corruption", T2)
        .unwrap();
    store.commit_audio_chunk("chunk-3", T2).unwrap();

    assert_eq!(
        store
            .committed_audio_chunks("meeting-1", "mic", 0, 10)
            .unwrap()
            .into_iter()
            .map(|chunk| chunk.definition.sequence)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_eq!(
        store
            .committed_audio_chunks("meeting-1", "mic", 2, 1)
            .unwrap()[0]
            .definition
            .sequence,
        3
    );
    assert!(store
        .committed_audio_chunks("meeting-1", "mic", 0, 0)
        .is_err());
    assert!(store
        .committed_audio_chunks("meeting-1", "mic", 0, MAX_COMMITTED_AUDIO_CHUNK_PAGE + 1,)
        .is_err());
}

#[test]
fn permanent_deletion_tombstone_cancels_pending_work_and_waits_for_running_activity() {
    let store = store();
    let recording = start_recording(&store);
    store
        .transition_meeting(
            &recording.id,
            recording.revision,
            MeetingStatus::Failed,
            T2,
            Some(&MeetingFailure {
                code: "terminal".into(),
                message: "ready for deletion".into(),
                retryable: false,
            }),
        )
        .unwrap();
    store
        .enqueue_job(&job("privacy-running", "privacy-running", 2), T2)
        .unwrap();
    let running = store
        .claim_next_job("privacy-worker", T2, T3)
        .unwrap()
        .unwrap();
    store
        .enqueue_job(&job("privacy-pending", "privacy-pending", 2), T2)
        .unwrap();

    let deletion = store
        .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
        .unwrap();
    assert_eq!(deletion.stage, MeetingDeletionStage::WaitingForJobs);
    assert_eq!(deletion.running_jobs, 1);
    assert!(matches!(
        store.get_meeting("meeting-1"),
        Err(MeetingStoreError::DeletionInProgress { .. })
    ));
    assert!(store.list_meetings(10).unwrap().is_empty());
    assert!(store
        .claim_next_job("another-worker", T2, T3)
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .list_jobs("meeting-1")
            .unwrap()
            .iter()
            .find(|job| job.definition.id == "privacy-pending")
            .unwrap()
            .state,
        JobState::Cancelled
    );
    assert!(matches!(
        store.enqueue_job(&job("late-job", "late-job", 2), T2),
        Err(MeetingStoreError::DeletionInProgress { .. })
    ));

    let finished = store
        .finish_job(
            &running.definition.id,
            running.lease_token.as_deref().unwrap(),
            &JobFinish::Succeeded {
                result: json!({"title": "must not survive"}),
            },
            T3,
        )
        .unwrap();
    assert_eq!(finished.state, JobState::Cancelled);
    assert!(finished.result.is_none());
    assert_eq!(
        store.deletion("meeting-1").unwrap().unwrap().stage,
        MeetingDeletionStage::FilesPending
    );
    store.mark_deletion_files_removed("meeting-1", T3).unwrap();
    store
        .remove_deletion_database_authority("meeting-1", T3)
        .unwrap();
    assert_eq!(
        store.deletion("meeting-1").unwrap().unwrap().stage,
        MeetingDeletionStage::MarkerCleanupPending
    );
    store.complete_deletion("meeting-1").unwrap();
    assert!(matches!(
        store.get_meeting("meeting-1"),
        Err(MeetingStoreError::NotFound { .. })
    ));
}

#[test]
fn audio_deletion_rejects_transcription_recovery_holds_and_replays_independently() {
    let store = store();
    let recording = start_recording(&store);
    let chunk = AudioChunkDraft {
        id: "privacy-chunk".into(),
        meeting_id: recording.id.clone(),
        channel_id: "mic".into(),
        sequence: 0,
        start_ms: 0,
        end_ms: 1_000,
        sample_count: 48_000,
        byte_len: 192_000,
        sha256: "a".repeat(64),
        relative_path: "meeting-1/audio/mic/00000000.f32le".into(),
    };
    store.stage_audio_chunk(&chunk, T1).unwrap();
    let failed = store
        .transition_meeting(
            "meeting-1",
            recording.revision,
            MeetingStatus::Failed,
            T2,
            Some(&MeetingFailure {
                code: "recovery".into(),
                message: "terminal with staged audio".into(),
                retryable: false,
            }),
        )
        .unwrap();
    assert_eq!(failed.status, MeetingStatus::Failed);
    assert!(store
        .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
        .unwrap_err()
        .to_string()
        .contains("transcription recovery"));

    store.commit_audio_chunk(&chunk.id, T2).unwrap();
    let mut transcription = job("repair-job", "repair", 2);
    transcription.kind = FollowUpJobKind::Custom("transcription".into());
    store.enqueue_job(&transcription, T2).unwrap();
    assert!(store
        .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
        .unwrap_err()
        .to_string()
        .contains("transcription recovery"));
    store.cancel_job("repair-job", T2).unwrap();
    store
        .enqueue_job(&job("summary-job", "summary", 2), T2)
        .unwrap();
    let deletion = store
        .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T2)
        .unwrap();
    assert_eq!(deletion.stage, MeetingDeletionStage::FilesPending);
    assert_eq!(
        store
            .claim_next_job("summary-worker", T2, T3)
            .unwrap()
            .unwrap()
            .definition
            .id,
        "summary-job"
    );
    store.mark_deletion_files_removed("meeting-1", T3).unwrap();
    store
        .remove_deletion_database_authority("meeting-1", T3)
        .unwrap();
    store.complete_deletion("meeting-1").unwrap();
    assert_eq!(
        store.get_meeting("meeting-1").unwrap().status,
        MeetingStatus::Failed
    );
    assert!(store
        .recover_after_restart(T3)
        .unwrap()
        .staged_audio_chunks
        .is_empty());
}

#[test]
fn audio_deletion_rejects_collecting_repair_after_job_attempts_are_exhausted() {
    let store = store();
    let recording = start_recording(&store);
    let interrupted = store
        .transition_meeting(
            "meeting-1",
            recording.revision,
            MeetingStatus::Interrupted,
            T2,
            None,
        )
        .unwrap();
    assert_eq!(interrupted.status, MeetingStatus::Interrupted);
    assert_eq!(
        store
            .begin_transcript_repair("meeting-1", "capture-generation", "provider-run", T2)
            .unwrap(),
        TranscriptRepairBegin::Collecting
    );
    assert!(store.has_retention_hold("meeting-1").unwrap());

    assert!(store
        .begin_deletion("meeting-1", MeetingDeletionMode::Audio, T3)
        .unwrap_err()
        .to_string()
        .contains("transcription recovery"));
}

#[test]
fn deletion_journal_survives_every_database_boundary_and_meeting_cascade() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("meetings.sqlite");
    {
        let store = MeetingStore::open(&path).unwrap();
        let recording = start_recording(&store);
        store
            .transition_meeting(
                "meeting-1",
                recording.revision,
                MeetingStatus::Failed,
                T2,
                Some(&MeetingFailure {
                    code: "terminal".into(),
                    message: "ready".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        store
            .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
            .unwrap();
    }
    {
        let store = MeetingStore::open(&path).unwrap();
        assert_eq!(
            store.pending_deletions().unwrap()[0].stage,
            MeetingDeletionStage::FilesPending
        );
        store.mark_deletion_files_removed("meeting-1", T3).unwrap();
    }
    {
        let store = MeetingStore::open(&path).unwrap();
        assert_eq!(
            store.pending_deletions().unwrap()[0].stage,
            MeetingDeletionStage::DatabasePending
        );
        store
            .remove_deletion_database_authority("meeting-1", T3)
            .unwrap();
    }
    {
        let store = MeetingStore::open(&path).unwrap();
        assert!(matches!(
            store.get_meeting("meeting-1"),
            Err(MeetingStoreError::DeletionInProgress { .. })
        ));
        assert_eq!(
            store.pending_deletions().unwrap()[0].stage,
            MeetingDeletionStage::MarkerCleanupPending
        );
        store.complete_deletion("meeting-1").unwrap();
        assert!(matches!(
            store.get_meeting("meeting-1"),
            Err(MeetingStoreError::NotFound { .. })
        ));
    }
}

#[test]
fn deletion_of_finalizing_record_survives_restart_without_reviving_transcription() {
    let store = store();
    let recording = start_recording(&store);
    let stopping = store
        .transition_meeting(
            &recording.id,
            recording.revision,
            MeetingStatus::Stopping,
            T2,
            None,
        )
        .unwrap();
    store
        .transition_meeting(
            &recording.id,
            stopping.revision,
            MeetingStatus::Finalizing,
            T2,
            None,
        )
        .unwrap();
    let deletion = store
        .begin_deletion(&recording.id, MeetingDeletionMode::All, T2)
        .unwrap();
    assert_eq!(deletion.stage, MeetingDeletionStage::WaitingForJobs);
    assert!(store.list_meetings(10).unwrap().is_empty());
    assert_eq!(
        store.refresh_deletion(&recording.id, T2).unwrap().stage,
        MeetingDeletionStage::WaitingForJobs
    );
    store.recover_after_restart(T3).unwrap();
    assert!(store.interrupted_meeting_ids().unwrap().is_empty());
    assert!(store.list_meetings(10).unwrap().is_empty());
    assert_eq!(
        store.refresh_deletion(&recording.id, T3).unwrap().stage,
        MeetingDeletionStage::FilesPending
    );
}
