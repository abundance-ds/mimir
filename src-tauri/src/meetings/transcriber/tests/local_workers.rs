#[test]
fn slow_local_start_is_owned_immediately_and_stop_never_reports_a_missing_worker() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let (release_tx, release_rx) = mpsc::channel();
    let transcriber = NativeMeetingTranscriber::new(
        Arc::clone(&store),
        temporary.path(),
        Arc::new(RuntimeRouteResolver),
        Arc::new(NoMeetingCredential),
        Arc::new(SlowStartingLocal {
            release: Mutex::new(release_rx),
        }),
        Arc::new(NoopTranscriptionChangeSink),
    )
    .unwrap();
    let start = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "slow-run".into(),
        route: "local".into(),
        model: "whisper-small".into(),
        first_sequence: 0,
        repair_generation: None,
        repair_intent: None,
    };
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(150));
        release_tx.send(()).unwrap();
    });

    let started_at = Instant::now();
    transcriber.start(&start).unwrap();
    assert!(
        started_at.elapsed() < Duration::from_millis(50),
        "recording start waited for local model preparation"
    );
    release.join().unwrap();

    let batch = transcriber
        .finalize(&TranscriptionFinalize {
            meeting_id: "meeting-1".into(),
            run_id: start.run_id,
            base_revision: 0,
            observed_at: "2026-07-30T10:05:00Z".into(),
        })
        .unwrap();
    assert!(batch.marks_final);
}

#[test]
fn a_worker_failure_after_readiness_cannot_remain_projected_as_live() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let transcriber = NativeMeetingTranscriber::new(
        Arc::clone(&store),
        temporary.path(),
        Arc::new(RuntimeRouteResolver),
        Arc::new(NoMeetingCredential),
        Arc::new(FailingAfterReadyLocal),
        Arc::new(NoopTranscriptionChangeSink),
    )
    .unwrap();
    let start = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "ready-then-fail-run".into(),
        route: "local".into(),
        model: "whisper-small".into(),
        first_sequence: 0,
        repair_generation: None,
        repair_intent: None,
    };
    transcriber.start(&start).unwrap();

    let deadline = Instant::now() + Duration::from_secs(1);
    while transcriber.status("meeting-1") != TranscriptionWorkerStatus::Failed
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        transcriber.status("meeting-1"),
        TranscriptionWorkerStatus::Failed
    );
    assert!(transcriber
        .finalize(&TranscriptionFinalize {
            meeting_id: "meeting-1".into(),
            run_id: start.run_id,
            base_revision: 0,
            observed_at: "2026-07-31T15:00:00Z".into(),
        })
        .unwrap_err()
        .contains("inference worker stopped"));
}

#[test]
fn silent_local_meeting_emits_an_empty_terminal_batch() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let transcriber = NativeMeetingTranscriber::new(
        Arc::clone(&store),
        temporary.path(),
        Arc::new(RuntimeRouteResolver),
        Arc::new(NoMeetingCredential),
        Arc::new(SilentLocal),
        Arc::new(NoopTranscriptionChangeSink),
    )
    .unwrap();
    let start = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "silent-run".into(),
        route: "local".into(),
        model: "whisper-small".into(),
        first_sequence: 0,
        repair_generation: None,
        repair_intent: None,
    };
    transcriber.start(&start).unwrap();

    let batch = transcriber
        .finalize(&TranscriptionFinalize {
            meeting_id: "meeting-1".into(),
            run_id: "silent-run".into(),
            base_revision: 0,
            observed_at: "2026-07-30T10:05:00Z".into(),
        })
        .unwrap();

    assert!(batch.marks_final);
    assert!(batch.changes.is_empty());
    assert_eq!(batch.base_revision, 0);
    store.apply_transcript_batch(&batch).unwrap();
    let overview = store.transcript_overview("meeting-1", 1).unwrap();
    assert!(overview.is_final);
    assert_eq!(overview.segment_count, 0);
}

#[test]
fn repair_worker_stages_privately_then_reconciles_from_audio_zero() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: "meeting-1".into(),
            batch_id: "pre-crash-partial".into(),
            base_revision: 0,
            source: "custom".into(),
            observed_at: "2026-07-30T10:00:02Z".into(),
            marks_final: false,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "stale-live-partial".into(),
                    start_ms: 0,
                    end_ms: 500,
                    text: "stale partial".into(),
                    channel_id: Some("microphone".into()),
                    speaker: None,
                    confidence: Some(0.4),
                    is_final: false,
                    metadata: json!({
                        "owner": "stt",
                        "providerRunId": "crashed-live-run"
                    }),
                },
            }],
        })
        .unwrap();
    let meeting = store.get_meeting("meeting-1").unwrap();
    store
        .transition_meeting(
            "meeting-1",
            meeting.revision,
            MeetingStatus::Interrupted,
            "2026-07-30T10:00:03Z",
            None,
        )
        .unwrap();
    let changes = Arc::new(CountingChanges::default());
    let transcriber = NativeMeetingTranscriber::new(
        Arc::clone(&store),
        temporary.path(),
        Arc::new(RuntimeRouteResolver),
        Arc::new(NoMeetingCredential),
        Arc::new(OneFinalRepairLocal),
        changes.clone(),
    )
    .unwrap();
    let start = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "repair-run-generation-1".into(),
        route: "local".into(),
        model: "whisper-small".into(),
        first_sequence: 0,
        repair_generation: Some("run-generation-1".into()),
        repair_intent: None,
    };
    transcriber.start(&start).unwrap();
    let terminal = transcriber
        .finalize(&TranscriptionFinalize {
            meeting_id: "meeting-1".into(),
            run_id: start.run_id.clone(),
            base_revision: 1,
            observed_at: "2026-07-30T10:05:00Z".into(),
        })
        .unwrap();

    // Provider output has completed, but only private repair staging has
    // changed. The pre-crash transcript remains authoritative until the
    // terminal reconciliation transaction.
    let before_commit = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(before_commit.segments.len(), 1);
    assert_eq!(before_commit.segments[0].segment.id, "stale-live-partial");
    assert_eq!(changes.0.load(Ordering::Relaxed), 0);
    store
        .commit_transcript_repair("run-generation-1", "repair-run-generation-1", &terminal)
        .unwrap();
    let after_commit = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(after_commit.segments.len(), 1);
    assert_eq!(
        after_commit.segments[0].segment.text,
        "Repaired only after the complete pass."
    );
    assert!(after_commit.segments[0].segment.is_final);
    assert_eq!(
        after_commit.segments[0].segment.metadata["providerRunId"],
        "repair-run-generation-1"
    );
}

#[test]
fn partial_segments_are_live_durable_and_replaced_by_their_final_revision() {
    let store = recording_store();
    let changes = Arc::new(CountingChanges::default());
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        ScribeDiagnostics::disabled(),
        "meeting-1",
        "run-1",
        "custom",
        None,
        changes.clone(),
    )
    .unwrap();
    let segment = |revision, state, text: &str| NormalizedTranscriptBatch {
        provider_sequence: revision + 1,
        batch_id: WireId::new(format!("batch-{revision}")).unwrap(),
        segments: vec![NormalizedSegment {
            segment_id: WireId::new("utterance-1").unwrap(),
            revision,
            state,
            start_ms: 0,
            end_ms: 1_000,
            text: text.into(),
            channel_id: Some(WireId::new("microphone").unwrap()),
            speaker: Some("You".into()),
            language: Some("en".into()),
            confidence: Some(0.9),
        }],
    };

    sink.ingest(segment(0, SegmentState::Partial, "planning"))
        .unwrap();
    let partial = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(partial.segments.len(), 1);
    assert!(!partial.segments[0].segment.is_final);
    assert_eq!(partial.segments[0].segment.text, "planning");

    sink.ingest(segment(1, SegmentState::Final, "planning complete"))
        .unwrap();
    let final_snapshot = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(final_snapshot.segments.len(), 1);
    assert!(final_snapshot.segments[0].segment.is_final);
    assert_eq!(final_snapshot.segments[0].segment.text, "planning complete");
    assert_eq!(sink.final_segment_count(), 1);
    assert_eq!(changes.0.load(Ordering::Relaxed), 2);
}

#[test]
fn normalized_provider_whitespace_is_ignored_before_durable_ingest() {
    let store = recording_store();
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        ScribeDiagnostics::disabled(),
        "meeting-1",
        "run-whitespace",
        "custom",
        None,
        Arc::new(CountingChanges::default()),
    )
    .unwrap();

    sink.ingest(provider_batch(
        1,
        "whitespace-only",
        1,
        SegmentState::Partial,
        " \n\t",
    ))
    .unwrap();
    assert!(store
        .transcript_snapshot("meeting-1", None)
        .unwrap()
        .segments
        .is_empty());

    sink.ingest(provider_batch(
        2,
        "speech-after-whitespace",
        2,
        SegmentState::Final,
        "Still listening",
    ))
    .unwrap();
    assert_eq!(
        store
            .transcript_snapshot("meeting-1", None)
            .unwrap()
            .segments[0]
            .segment
            .text,
        "Still listening"
    );
}

#[test]
fn durable_channels_are_interleaved_only_at_the_provider_boundary() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[1.0, 2.0],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "system",
        0,
        &[3.0, 4.0],
    );
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    let chunks = source.paired_chunks_from(0).unwrap();
    let values = chunks[0]
        .bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|sample| f32::from_le_bytes(*sample))
        .collect::<Vec<_>>();
    assert_eq!(values, vec![1.0, 3.0, 2.0, 4.0]);
    assert_eq!(chunks[0].sequence, 0);
}

#[test]
fn simultaneous_runs_in_one_meeting_own_separate_transcription_workers() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let transcriber = NativeMeetingTranscriber::new(
        store,
        temporary.path(),
        Arc::new(RuntimeRouteResolver),
        Arc::new(NoMeetingCredential),
        Arc::new(SilentLocal),
        Arc::new(NoopTranscriptionChangeSink),
    )
    .unwrap();
    for run_id in ["first-run", "second-run"] {
        transcriber
            .start(&TranscriptionStart {
                meeting_id: "meeting-1".into(),
                run_id: run_id.into(),
                route: "local".into(),
                model: "whisper-small".into(),
                first_sequence: 0,
                repair_generation: None,
                repair_intent: None,
            })
            .unwrap();
        transcriber.seal("meeting-1", run_id, 0).unwrap();
    }
    for run_id in ["second-run", "first-run"] {
        assert!(
            transcriber
                .finalize(&TranscriptionFinalize {
                    meeting_id: "meeting-1".into(),
                    run_id: run_id.into(),
                    base_revision: 0,
                    observed_at: "2026-07-30T10:05:00Z".into(),
                })
                .unwrap()
                .marks_final
        );
    }
}
