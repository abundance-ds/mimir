#[test]
fn gherkin_transcript_batches_are_atomic_revisioned_and_exactly_once() {
    let store = store();
    start_recording(&store);
    let first = batch(
        "batch-1",
        0,
        vec![
            TranscriptChange::UpsertSegment {
                segment: segment("segment-1", "Draft"),
            },
            TranscriptChange::OpenGap {
                gap: TranscriptGapInput {
                    id: "gap-1".into(),
                    start_ms: 1_000,
                    end_ms: 2_000,
                    reason: TranscriptGapReason::BufferOverflow,
                    channel_id: Some("system".into()),
                    detail: Some("provider lag".into()),
                },
            },
        ],
    );
    assert_eq!(
        store.apply_transcript_batch(&first).unwrap(),
        TranscriptApplyResult {
            revision: 1,
            duplicate: false
        }
    );
    assert_eq!(
        store.apply_transcript_batch(&first).unwrap(),
        TranscriptApplyResult {
            revision: 1,
            duplicate: true
        }
    );
    let second = batch(
        "batch-2",
        1,
        vec![
            TranscriptChange::UpsertSegment {
                segment: segment("segment-1", "Final"),
            },
            TranscriptChange::ResolveGap {
                gap_id: "gap-1".into(),
            },
        ],
    );
    store.apply_transcript_batch(&second).unwrap();

    let revision_one = store.transcript_snapshot("meeting-1", Some(1)).unwrap();
    assert_eq!(revision_one.segments[0].segment.text, "Draft");
    assert_eq!(revision_one.gaps.len(), 1);
    assert_eq!(revision_one.gaps[0].resolved_revision, None);
    let revision_two = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(revision_two.segments[0].segment.text, "Final");
    assert!(revision_two.gaps.is_empty());
    assert_eq!(store.transcript_revisions("meeting-1").unwrap().len(), 2);
}

#[test]
fn transcript_pages_remain_bounded_and_stable_at_one_hundred_thousand_segments() {
    let store = store();
    start_recording(&store);
    {
        let mut connection = store.lock().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute(
                "INSERT INTO transcript_revisions (
                       meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
                     ) VALUES ('meeting-1',1,0,'scale-fixture','test',?1,0)",
                [T2],
            )
            .unwrap();
        transaction
            .execute(
                "UPDATE meetings SET transcript_revision=1 WHERE id='meeting-1'",
                [],
            )
            .unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO transcript_segments (
                           meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
                           confidence,is_final,metadata_json,created_revision,updated_revision
                         ) VALUES ('meeting-1',?1,?2,?3,'word','system',NULL,0.9,1,'{}',1,1)",
                )
                .unwrap();
            for index in 0_i64..100_000 {
                let start_ms = index * 1_000;
                insert
                    .execute(params![
                        format!("segment-{index:06}"),
                        start_ms,
                        start_ms + 900
                    ])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }

    let latest = store.transcript_page("meeting-1", None, 10_000).unwrap();
    assert_eq!(latest.total_segments, 100_000);
    assert_eq!(latest.segments.len(), MAX_TRANSCRIPT_PAGE_SEGMENTS as usize);
    assert!(latest.has_more);
    assert_eq!(
        latest.segments.first().unwrap().segment.start_ms,
        99_750_000
    );
    assert_eq!(latest.segments.last().unwrap().segment.start_ms, 99_999_000);
    assert!(
        serde_json::to_vec(&latest.segments).unwrap().len() < 128 * 1024,
        "a single IPC transcript page exceeded its 128 KiB payload budget"
    );

    let older = store
        .transcript_page("meeting-1", latest.next_before.as_ref(), 250)
        .unwrap();
    assert_eq!(older.segments.len(), 250);
    assert_eq!(older.segments.first().unwrap().segment.start_ms, 99_500_000);
    assert_eq!(older.segments.last().unwrap().segment.start_ms, 99_749_000);
    assert_ne!(
        latest.segments.first().unwrap().segment.id,
        older.segments.last().unwrap().segment.id
    );
    for status in [
        MeetingStatus::Stopping,
        MeetingStatus::Finalizing,
        MeetingStatus::Completed,
    ] {
        let meeting = store.get_meeting("meeting-1").unwrap();
        store
            .transition_meeting("meeting-1", meeting.revision, status, T3, None)
            .unwrap();
    }
    let hits = store.search_transcript("word", 300).unwrap();
    assert_eq!(hits.len(), 3);
    assert!(hits.iter().all(|hit| hit.meeting_id == "meeting-1"));
}

#[test]
fn meeting_keyset_pages_reach_records_beyond_the_old_one_thousand_cap() {
    let store = store();
    {
        let mut connection = store.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO meetings (
                           id,title,origin_json,status,created_at,updated_at,metadata_json
                         ) VALUES (
                           ?1,'Scale','{\"kind\":\"manual\",\"evidence\":{}}',
                           'completed',?2,?2,'{}'
                         )",
                )
                .unwrap();
            for index in 0..1_205 {
                insert
                    .execute(params![
                        format!("meeting-{index:04}"),
                        format!("2026-07-{:02}T10:00:00Z", 1 + index % 30)
                    ])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();
    }

    let mut before = None;
    let mut ids = Vec::new();
    loop {
        let page = store.list_meetings_page(before.as_ref(), 250).unwrap();
        ids.extend(page.meetings.iter().map(|meeting| meeting.id.clone()));
        if !page.has_more {
            break;
        }
        before = page.next_before;
    }
    assert_eq!(ids.len(), 1_205);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        1_205
    );
    assert!(ids.contains(&"meeting-0000".to_string()));
}

#[test]
fn gherkin_failed_transcript_change_rolls_back_the_whole_batch() {
    let store = store();
    start_recording(&store);
    let invalid = batch(
        "batch-1",
        0,
        vec![
            TranscriptChange::UpsertSegment {
                segment: segment("segment-1", "Should roll back"),
            },
            TranscriptChange::DeleteSegment {
                segment_id: "missing".into(),
            },
        ],
    );
    assert!(matches!(
        store.apply_transcript_batch(&invalid),
        Err(MeetingStoreError::NotFound { .. })
    ));
    let snapshot = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.segments.is_empty());
    assert!(store.transcript_revisions("meeting-1").unwrap().is_empty());
}

#[test]
fn gherkin_stale_transcript_writer_cannot_overwrite_a_newer_revision() {
    let store = store();
    start_recording(&store);
    store
        .apply_transcript_batch(&batch(
            "batch-1",
            0,
            vec![TranscriptChange::UpsertSegment {
                segment: segment("segment-1", "Current"),
            }],
        ))
        .unwrap();
    assert!(matches!(
        store.apply_transcript_batch(&batch(
            "batch-stale",
            0,
            vec![TranscriptChange::UpsertSegment {
                segment: segment("segment-1", "Stale"),
            }],
        )),
        Err(MeetingStoreError::RevisionConflict { actual: 1, .. })
    ));
    assert_eq!(
        store
            .transcript_snapshot("meeting-1", None)
            .unwrap()
            .segments[0]
            .segment
            .text,
        "Current"
    );
}

