#[test]
fn repair_replaces_partial_and_final_stt_rows_but_preserves_gaps_and_history() {
    let store = store();
    start_recording(&store);
    let mut old_final = segment("old-final", "Old final");
    old_final.is_final = true;
    let prior = batch(
        "prior-live",
        0,
        vec![
            TranscriptChange::UpsertSegment { segment: old_final },
            TranscriptChange::UpsertSegment {
                segment: segment("stale-partial", "unfinished"),
            },
            TranscriptChange::OpenGap {
                gap: TranscriptGapInput {
                    id: "capture-gap".into(),
                    start_ms: 1_000,
                    end_ms: 2_000,
                    reason: TranscriptGapReason::CaptureUnavailable,
                    channel_id: Some("system".into()),
                    detail: Some("capture sleep provenance".into()),
                },
            },
        ],
    );
    store.apply_transcript_batch(&prior).unwrap();
    interrupt(&store);

    assert_eq!(
        store
            .begin_transcript_repair(
                "meeting-1",
                "run-generation-1",
                "repair-run-generation-1",
                T2,
            )
            .unwrap(),
        TranscriptRepairBegin::Collecting
    );
    let mut repaired = segment("new-final", "Repaired from audio sequence zero");
    repaired.is_final = true;
    store
        .stage_transcript_repair_batch(
            "run-generation-1",
            "repair-run-generation-1",
            &batch(
                "repair-segments",
                1,
                vec![TranscriptChange::UpsertSegment { segment: repaired }],
            ),
        )
        .unwrap();
    let applied = store
        .commit_transcript_repair(
            "run-generation-1",
            "repair-run-generation-1",
            &repair_terminal(1),
        )
        .unwrap();
    assert_eq!(applied.revision, 2);
    assert!(!applied.duplicate);

    let current = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(current.segments.len(), 1);
    assert_eq!(current.segments[0].segment.id, "new-final");
    assert!(current.segments[0].segment.is_final);
    assert_eq!(
        current.segments[0].segment.metadata["providerRunId"],
        "repair-run-generation-1"
    );
    assert_eq!(current.gaps.len(), 1);
    assert_eq!(current.gaps[0].gap.id, "capture-gap");

    let before_repair = store.transcript_snapshot("meeting-1", Some(1)).unwrap();
    assert_eq!(before_repair.segments.len(), 2);
    assert!(before_repair
        .segments
        .iter()
        .any(|segment| segment.segment.id == "stale-partial"));
    assert_eq!(before_repair.gaps[0].gap.id, "capture-gap");

    let duplicate = store
        .commit_transcript_repair(
            "run-generation-1",
            "repair-run-generation-1",
            &repair_terminal(1),
        )
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.revision, 2);
}

#[test]
fn repair_restart_twice_clears_stale_staging_and_requires_all_final_output() {
    let store = store();
    start_recording(&store);
    interrupt(&store);
    let mut partial = segment("provider-segment", "partial repair");
    partial.metadata = json!({"attempt": 1});
    store
        .begin_transcript_repair(
            "meeting-1",
            "run-generation-1",
            "repair-run-generation-1",
            T1,
        )
        .unwrap();
    store
        .stage_transcript_repair_batch(
            "run-generation-1",
            "repair-run-generation-1",
            &batch(
                "repair-partial",
                0,
                vec![TranscriptChange::UpsertSegment { segment: partial }],
            ),
        )
        .unwrap();
    assert!(store
        .commit_transcript_repair(
            "run-generation-1",
            "repair-run-generation-1",
            &repair_terminal(0),
        )
        .unwrap_err()
        .to_string()
        .contains("unresolved partial"));

    // Two process restarts replay audio from zero under the same stable
    // provider run. Each begin clears only private staging; no partial
    // repair row ever reaches the authoritative transcript.
    for observed_at in [T2, T3] {
        assert_eq!(
            store
                .begin_transcript_repair(
                    "meeting-1",
                    "run-generation-1",
                    "repair-run-generation-1",
                    observed_at,
                )
                .unwrap(),
            TranscriptRepairBegin::Collecting
        );
        assert_eq!(
            store
                .transcript_overview("meeting-1", 1)
                .unwrap()
                .segment_count,
            0
        );
    }
    let mut final_segment = segment("provider-segment", "complete repair");
    final_segment.is_final = true;
    store
        .stage_transcript_repair_batch(
            "run-generation-1",
            "repair-run-generation-1",
            &batch(
                "repair-final",
                0,
                vec![TranscriptChange::UpsertSegment {
                    segment: final_segment,
                }],
            ),
        )
        .unwrap();
    store
        .commit_transcript_repair(
            "run-generation-1",
            "repair-run-generation-1",
            &repair_terminal(0),
        )
        .unwrap();
    let overview = store.transcript_overview("meeting-1", 1).unwrap();
    assert!(overview.is_final);
    assert_eq!(overview.segment_count, 1);
    assert_eq!(overview.non_final_segment_count, 0);
}

#[test]
fn silent_repair_commits_an_empty_all_final_generation() {
    let store = store();
    start_recording(&store);
    interrupt(&store);
    store
        .begin_transcript_repair("meeting-1", "run-silent", "repair-run-silent", T2)
        .unwrap();
    store
        .commit_transcript_repair("run-silent", "repair-run-silent", &repair_terminal(0))
        .unwrap();
    let overview = store.transcript_overview("meeting-1", 1).unwrap();
    assert!(overview.is_final);
    assert_eq!(overview.segment_count, 0);
    assert_eq!(overview.non_final_segment_count, 0);
}

#[test]
fn repair_reconciliation_is_one_revision_beyond_one_hundred_thousand_segments() {
    let store = store();
    start_recording(&store);
    interrupt(&store);
    store
        .begin_transcript_repair("meeting-1", "run-scale", "repair-run-scale", T2)
        .unwrap();
    {
        let connection = store.lock().unwrap();
        connection
            .execute_batch(
                "WITH RECURSIVE counter(value) AS (
                       SELECT 0
                       UNION ALL
                       SELECT value+1 FROM counter WHERE value<100000
                     )
                     INSERT INTO transcript_repair_segments (
                       meeting_id,capture_generation,segment_id,start_ms,end_ms,
                       text,channel_id,speaker,confidence,is_final,metadata_json,
                       updated_at
                     )
                     SELECT 'meeting-1','run-scale',printf('segment-%06d',value),
                            value*10,value*10+9,printf('text %d',value),
                            'system',NULL,NULL,1,
                            '{\"owner\":\"stt\",\"providerRunId\":\"repair-run-scale\"}',
                            '2026-07-30T10:02:00Z'
                     FROM counter;",
            )
            .unwrap();
    }
    let applied = store
        .commit_transcript_repair("run-scale", "repair-run-scale", &repair_terminal(0))
        .unwrap();
    assert_eq!(applied.revision, 1);
    let overview = store.transcript_overview("meeting-1", 1).unwrap();
    assert_eq!(overview.segment_count, 100_001);
    assert_eq!(overview.non_final_segment_count, 0);
    assert!(overview.is_final);
}

