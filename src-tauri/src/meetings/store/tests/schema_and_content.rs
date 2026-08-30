#[test]
fn gherkin_new_database_migrates_atomically_and_reopens() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("meetings.sqlite");
    {
        let store = MeetingStore::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        store.create_meeting(&meeting(), T0).unwrap();
    }
    let reopened = MeetingStore::open(&path).unwrap();
    assert_eq!(reopened.get_meeting("meeting-1").unwrap().channels.len(), 2);
}

#[test]
fn completing_a_meeting_and_enqueuing_its_summary_is_one_transaction() {
    let store = store();
    let recording = start_recording(&store);
    let stopping = store
        .transition_meeting(
            "meeting-1",
            recording.revision,
            MeetingStatus::Stopping,
            T2,
            None,
        )
        .unwrap();
    let finalizing = store
        .transition_meeting(
            "meeting-1",
            stopping.revision,
            MeetingStatus::Finalizing,
            T2,
            None,
        )
        .unwrap();
    let mut invalid_summary = job("summary-invalid", "summary:1", 3);
    invalid_summary.meeting_id = "another-meeting".into();
    assert!(store
        .complete_meeting_with_job("meeting-1", finalizing.revision, T3, Some(&invalid_summary),)
        .is_err());
    assert_eq!(
        store.get_meeting("meeting-1").unwrap().status,
        MeetingStatus::Finalizing
    );
    assert!(store.list_jobs("meeting-1").unwrap().is_empty());

    let summary = job("summary-valid", "summary:1", 3);
    let (completed, enqueued) = store
        .complete_meeting_with_job("meeting-1", finalizing.revision, T3, Some(&summary))
        .unwrap();
    assert_eq!(completed.status, MeetingStatus::Completed);
    assert_eq!(enqueued.unwrap().definition.id, summary.id);
    assert_eq!(store.list_jobs("meeting-1").unwrap().len(), 1);
}

#[test]
fn schema_v5_backfills_existing_meeting_titles_into_private_search() {
    let mut connection = Connection::open_in_memory().unwrap();
    {
        let transaction = connection.transaction().unwrap();
        migration_v1(&transaction).unwrap();
        migration_v2(&transaction).unwrap();
        migration_v3(&transaction).unwrap();
        migration_v4(&transaction).unwrap();
        transaction
            .execute(
                "INSERT INTO meetings (
                       id,title,origin_json,status,created_at,updated_at,metadata_json
                     ) VALUES (
                       'meeting-legacy','Legacy substring sentinel',
                       '{\"kind\":\"manual\",\"evidence\":{}}','completed',?1,?1,'{}'
                     )",
                [T0],
            )
            .unwrap();
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        transaction.pragma_update(None, "user_version", 4).unwrap();
        transaction.commit().unwrap();
    }

    let store = MeetingStore::from_connection(connection, None).unwrap();
    assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    let hits = store.search_content("acy substring", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].meeting_id, "meeting-legacy");
    assert!(hits[0].title_match);
}

#[test]
fn schema_v6_cancels_mutable_revision_repairs_before_fresh_generation_ownership() {
    let mut connection = Connection::open_in_memory().unwrap();
    {
        let transaction = connection.transaction().unwrap();
        migration_v1(&transaction).unwrap();
        migration_v2(&transaction).unwrap();
        migration_v3(&transaction).unwrap();
        migration_v4(&transaction).unwrap();
        migration_v5(&transaction).unwrap();
        transaction
            .execute(
                "INSERT INTO meetings (
                       id,title,origin_json,status,created_at,updated_at,metadata_json
                     ) VALUES (
                       'meeting-legacy-repair','Legacy repair',
                       '{\"kind\":\"manual\",\"evidence\":{}}','interrupted',?1,?1,
                       '{\"runId\":\"run-stable-generation\"}'
                     )",
                [T0],
            )
            .unwrap();
        for (id, revision) in [("legacy-repair-zero", 0), ("legacy-repair-one", 1)] {
            transaction
                .execute(
                    "INSERT INTO follow_up_jobs (
                           id,meeting_id,kind,idempotency_key,request_hash,payload_json,
                           state,attempts,max_attempts,not_before,created_at,updated_at
                         ) VALUES (
                           ?1,'meeting-legacy-repair','custom:transcription',?2,?3,?4,
                           'pending',0,3,?5,?5,?5
                         )",
                    params![
                        id,
                        format!("meeting-legacy-repair:transcription:{revision}"),
                        format!("legacy-intent-hash-{revision}"),
                        serde_json::to_string(&json!({
                            "meetingId": "meeting-legacy-repair",
                            "transcriptRevision": revision
                        }))
                        .unwrap(),
                        T0
                    ],
                )
                .unwrap();
        }
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        transaction.pragma_update(None, "user_version", 5).unwrap();
        transaction.commit().unwrap();
    }

    let store = MeetingStore::from_connection(connection, None).unwrap();
    assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    let legacy = store.list_jobs("meeting-legacy-repair").unwrap();
    assert_eq!(legacy.len(), 2);
    assert!(legacy.iter().all(|job| job.state == JobState::Cancelled));
    assert!(legacy.iter().all(|job| {
        job.last_error.as_deref()
            == Some("superseded by capture-generation repair ownership migration")
    }));

    let fresh = FollowUpJobDraft {
        id: "job-transcription-run-stable-generation".into(),
        meeting_id: "meeting-legacy-repair".into(),
        kind: FollowUpJobKind::Custom("transcription".into()),
        idempotency_key: "meeting-legacy-repair:transcription:run-stable-generation".into(),
        payload: json!({
            "meetingId": "meeting-legacy-repair",
            "captureGeneration": "run-stable-generation",
            "transcriptionRoute": "local",
            "transcriptionModel": "whisper-small"
        }),
        max_attempts: 3,
        not_before: T1.into(),
    };
    let (enqueued, duplicate) = store.enqueue_job(&fresh, T1).unwrap();
    assert!(!duplicate);
    assert_eq!(enqueued.state, JobState::Pending);
}

#[test]
fn reviewed_content_search_preserves_substrings_and_scrubs_fts_on_deletion() {
    let store = store();
    let created = store.create_meeting(&meeting(), T0).unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Failed,
            T1,
            Some(&MeetingFailure {
                code: "fixture".into(),
                message: "terminal fixture".into(),
                retryable: false,
            }),
        )
        .unwrap();
    store
        .sync_content_search(
            "meeting-1",
            "Überarbeitete ReleasePlanung",
            Some("The decision lives beyond every library preview."),
            &["RoadmapSentinel".into()],
            false,
            "test-content-v1",
        )
        .unwrap();

    let title = store.search_content("leasePlan", 10).unwrap();
    assert_eq!(title.len(), 1);
    assert!(title[0].title_match);
    assert!(matches!(
        store.search_content("üb", 10),
        Err(MeetingStoreError::Validation(message))
            if message.contains("at least 3 characters")
    ));
    let short_unicode = store.search_content("übe", 10).unwrap();
    assert_eq!(short_unicode.len(), 1);
    assert!(short_unicode[0].title_match);
    let summary = store.search_content("beyond every", 10).unwrap();
    assert_eq!(summary.len(), 1);
    assert!(summary[0].summary_match);
    let tag = store.search_content("mapSent", 10).unwrap();
    assert_eq!(tag.len(), 1);
    assert!(tag[0].tags_match);

    store
        .begin_deletion("meeting-1", MeetingDeletionMode::All, T2)
        .unwrap();
    assert!(store
        .search_content("ReleasePlanung", 10)
        .unwrap()
        .is_empty());
    store.mark_deletion_files_removed("meeting-1", T3).unwrap();
    store
        .remove_deletion_database_authority("meeting-1", T4)
        .unwrap();
    let connection = store.lock().unwrap();
    let indexed_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM meeting_content_search_fts
                 WHERE meeting_id='meeting-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed_rows, 0, "permanent deletion retained indexed text");
}

#[cfg(unix)]
#[test]
fn meeting_database_and_wal_sidecars_are_repaired_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempdir().unwrap();
    let root = directory.path().join("meetings");
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
    let path = root.join("meetings.sqlite");
    let store = MeetingStore::open(&path).unwrap();
    store.create_meeting(&meeting(), T0).unwrap();

    assert_eq!(
        std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    let shm = PathBuf::from(format!("{}-shm", path.display()));
    assert!(wal.exists(), "WAL mode must keep a live write-ahead log");
    assert!(shm.exists(), "WAL mode must keep a live shared-memory file");

    // Simulate state left by an older permissive build, then verify an
    // ordinary startup repairs all SQLite-owned artifacts.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
    std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o666)).unwrap();
    std::fs::set_permissions(&shm, std::fs::Permissions::from_mode(0o666)).unwrap();
    drop(store);
    let reopened = MeetingStore::open(&path).unwrap();
    reopened.repair_database_permissions().unwrap();
    for artifact in [&path, &wal, &shm] {
        if artifact.exists() {
            assert_eq!(
                std::fs::metadata(artifact).unwrap().permissions().mode() & 0o777,
                0o600,
                "{} was not owner-only",
                artifact.display()
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn meeting_database_open_refuses_database_and_sidecar_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempdir().unwrap();
    let root = directory.path().join("meetings");
    std::fs::create_dir(&root).unwrap();
    let outside = directory.path().join("outside.sqlite");
    std::fs::write(&outside, b"outside").unwrap();
    let database = root.join("meetings.sqlite");
    symlink(&outside, &database).unwrap();
    assert!(matches!(
        MeetingStore::open(&database),
        Err(MeetingStoreError::PrivateStorage(_))
    ));
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");

    std::fs::remove_file(&database).unwrap();
    let store = MeetingStore::open(&database).unwrap();
    drop(store);
    let outside_sidecar = directory.path().join("outside-sidecar");
    std::fs::write(&outside_sidecar, b"outside sidecar").unwrap();
    let wal = PathBuf::from(format!("{}-wal", database.display()));
    symlink(&outside_sidecar, &wal).unwrap();
    assert!(matches!(
        MeetingStore::open(&database),
        Err(MeetingStoreError::PrivateStorage(_))
    ));
    assert_eq!(std::fs::read(&outside_sidecar).unwrap(), b"outside sidecar");
}

#[test]
fn gherkin_a_newer_schema_is_refused_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("future.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    connection.pragma_update(None, "user_version", 999).unwrap();
    drop(connection);
    assert!(matches!(
        MeetingStore::open(&path),
        Err(MeetingStoreError::UnsupportedSchemaVersion { found: 999, .. })
    ));
    let connection = Connection::open(path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 999);
}

#[test]
fn gherkin_state_changes_use_optimistic_revision_and_idempotent_replay() {
    let store = store();
    let detected = store.create_meeting(&meeting(), T0).unwrap();
    let recording = store
        .transition_meeting(&detected.id, 0, MeetingStatus::Recording, T1, None)
        .unwrap();
    assert_eq!(recording.revision, 1);
    assert_eq!(
        store
            .transition_meeting(&detected.id, 1, MeetingStatus::Recording, T2, None)
            .unwrap()
            .revision,
        1
    );
    assert!(matches!(
        store.transition_meeting(&detected.id, 0, MeetingStatus::Stopping, T2, None),
        Err(MeetingStoreError::RevisionConflict { actual: 1, .. })
    ));
    assert!(matches!(
        store.transition_meeting(&detected.id, 1, MeetingStatus::Completed, T2, None),
        Err(MeetingStoreError::InvalidTransition { .. })
    ));
}

#[test]
fn interrupted_and_failed_recordings_keep_a_terminal_stop_timestamp() {
    for (meeting_id, terminal) in [
        ("meeting-interrupted", MeetingStatus::Interrupted),
        ("meeting-failed", MeetingStatus::Failed),
    ] {
        let store = store();
        let mut draft = meeting();
        draft.id = meeting_id.into();
        let created = store.create_meeting(&draft, T0).unwrap();
        let recording = store
            .transition_meeting(
                meeting_id,
                created.revision,
                MeetingStatus::Recording,
                T1,
                None,
            )
            .unwrap();
        let failure = (terminal == MeetingStatus::Failed).then_some(MeetingFailure {
            code: "capture-failed".into(),
            message: "capture worker ended".into(),
            retryable: true,
        });
        let ended = store
            .transition_meeting(
                meeting_id,
                recording.revision,
                terminal,
                T2,
                failure.as_ref(),
            )
            .unwrap();
        assert_eq!(
            ended.stopped_at.as_deref(),
            Some("2026-07-30T10:02:00.000Z")
        );
    }
}

