#[test]
fn content_round_trips_and_export_uses_authoritative_transcript() {
    let fixture = fixture();
    create_meeting(&fixture, "meeting-1");
    fixture
        .store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: "meeting-1".into(),
            batch_id: "batch-1".into(),
            base_revision: 0,
            source: "test".into(),
            observed_at: NOW.into(),
            marks_final: true,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "segment-1".into(),
                    start_ms: 1_000,
                    end_ms: 2_000,
                    text: "Ship it carefully.".into(),
                    channel_id: Some("microphone".into()),
                    speaker: Some("Alex".into()),
                    confidence: Some(0.99),
                    is_final: true,
                    metadata: json!({}),
                },
            }],
        })
        .unwrap();
    complete_meeting(&fixture, "meeting-1");
    fixture
        .platform
        .update_content(
            "meeting-1",
            &MeetingUpdatePatch {
                summary: Some("A release decision was made.".into()),
                tags: Some(vec!["release".into()]),
                ..MeetingUpdatePatch::default()
            },
        )
        .unwrap();
    let exported = fixture
        .platform
        .export_meeting("meeting-1", MeetingExportFormat::Markdown)
        .unwrap();
    let markdown = fs::read_to_string(exported.path).unwrap();
    assert!(markdown.contains("A release decision was made."));
    assert!(markdown.contains("Ship it carefully."));
    assert!(markdown.contains("00:00:01 · Alex"));
    let files = fixture
        .platform
        .export_meeting("meeting-1", MeetingExportFormat::Files)
        .unwrap();
    let meeting_markdown = Path::new(&files.path).join("meeting.md");
    assert_eq!(fs::read_to_string(meeting_markdown).unwrap(), markdown);
    let summary_hits = fixture
        .store
        .search_content("release decision", 10)
        .unwrap();
    assert_eq!(summary_hits.len(), 1);
    assert!(summary_hits[0].summary_match);
    let tag_hits = fixture.store.search_content("lea", 10).unwrap();
    assert_eq!(tag_hits.len(), 1);
    assert!(tag_hits[0].tags_match);
}

#[test]
fn readable_transcript_groups_fragments_without_crossing_speakers() {
    let segment =
        |id: &str, start_ms: i64, end_ms: i64, text: &str, channel: &str, speaker: &str| {
            TranscriptSegmentRecord {
                segment: TranscriptSegmentInput {
                    id: id.into(),
                    start_ms,
                    end_ms,
                    text: text.into(),
                    channel_id: Some(channel.into()),
                    speaker: Some(speaker.into()),
                    confidence: None,
                    is_final: true,
                    metadata: json!({}),
                },
                created_revision: 1,
                updated_revision: 1,
            }
        };
    let readable = readable_transcript_segments(
        &[
            segment("s1", 0, 2_000, "The contract is", "system", "Others"),
            segment("s2", 2_000, 4_000, "ready.", "system", "Others"),
            segment("s3", 4_000, 5_000, "Good.", "microphone", "You"),
        ],
        &[],
    );

    assert_eq!(readable.len(), 2);
    assert_eq!(readable[0].text, "The contract is ready.");
    assert_eq!((readable[0].start_ms, readable[0].end_ms), (0, 4_000));
    assert_eq!(readable[1].text, "Good.");
}

#[test]
fn user_title_and_graph_draft_survive_generated_summary_updates() {
    let fixture = fixture();
    create_meeting(&fixture, "meeting-context");
    fixture
        .platform
        .update_content(
            "meeting-context",
            &MeetingUpdatePatch {
                title: Some("Client planning".into()),
                graph_draft: Some(MeetingGraphDraft {
                    project_resolved: true,
                    project_id: Some("project-alpha".into()),
                    people_ids: vec!["person-ana".into()],
                    scope_id: Some("team:main".into()),
                }),
                ..MeetingUpdatePatch::default()
            },
        )
        .unwrap();
    fixture
        .platform
        .update_content(
            "meeting-context",
            &MeetingUpdatePatch {
                generated_title: Some("Generated replacement title".into()),
                summary: Some("- Ship Friday.".into()),
                ..MeetingUpdatePatch::default()
            },
        )
        .unwrap();

    let content = fixture.platform.content("meeting-context").unwrap();
    assert_eq!(content.title.as_deref(), Some("Client planning"));
    assert_eq!(content.summary.as_deref(), Some("- Ship Friday."));
    assert_eq!(
        content.graph_draft.project_id.as_deref(),
        Some("project-alpha")
    );
    assert_eq!(content.graph_draft.people_ids, ["person-ana"]);
    assert_eq!(content.graph_draft.scope_id.as_deref(), Some("team:main"));
}

#[test]
fn startup_reconciles_existing_reviewed_content_into_private_search() {
    let directory = tempfile::tempdir().unwrap();
    let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
    fs::create_dir_all(&paths.content_root).unwrap();
    let store = Arc::new(MeetingStore::open(paths.meetings_root.join("meetings.sqlite")).unwrap());
    let created = store
        .create_meeting(
            &MeetingDraft {
                id: "meeting-before-index".into(),
                title: "Original title".into(),
                origin: MeetingOrigin::default(),
                channels: Vec::new(),
                metadata: json!({}),
            },
            NOW,
        )
        .unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            super::super::MeetingStatus::Failed,
            "2026-07-30T10:01:00Z",
            Some(&super::super::MeetingFailure {
                code: "fixture".into(),
                message: "terminal fixture".into(),
                retryable: false,
            }),
        )
        .unwrap();
    write_private_json_atomic(
        paths.content_root.join("meeting-before-index.json"),
        &PersistedMeetingContent {
            schema_version: CONTENT_SCHEMA_VERSION,
            title: Some("Reviewed startup title".into()),
            summary: Some(format!(
                "{} startup-full-summary-sentinel",
                "reviewed context ".repeat(180)
            )),
            tags: vec!["startup-index-tag".into()],
            ..PersistedMeetingContent::default()
        },
    )
    .unwrap();

    let model_bytes = b"verified managed model".to_vec();
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    let platform = NativeMeetingPlatform::new(
        paths.clone(),
        Arc::clone(&store),
        vec![MeetingModelCatalogEntry {
            title: "Whisper Small".into(),
            manifest: manifest(&model_bytes),
        }],
        Arc::new(FakeSecrets::default()),
        Arc::new(FakeEnvironment),
        Arc::new(FakeDisk),
        Arc::new(FakeDownloader {
            bytes: model_bytes,
            completion,
        }),
        Arc::new(NoopMeetingPlatformChangeSink),
    )
    .unwrap();
    assert_eq!(
        platform.content_load_count(),
        1,
        "the dirty legacy content file should be loaded exactly once"
    );
    let indexed_fingerprint = store
        .content_search_fingerprint("meeting-before-index")
        .unwrap()
        .unwrap();
    assert_ne!(indexed_fingerprint, "missing");

    for (query, field) in [
        ("startup title", "title"),
        ("full-summary-sentinel", "summary"),
        ("index-tag", "tags"),
    ] {
        let hits = store.search_content(query, 10).unwrap();
        assert_eq!(hits.len(), 1, "startup missed {field}");
        assert_eq!(hits[0].meeting_id, "meeting-before-index");
        assert!(match field {
            "title" => hits[0].title_match,
            "summary" => hits[0].summary_match,
            "tags" => hits[0].tags_match,
            _ => false,
        });
    }

    let model_bytes = b"verified managed model".to_vec();
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    let restarted = NativeMeetingPlatform::new(
        paths,
        Arc::clone(&store),
        vec![MeetingModelCatalogEntry {
            title: "Whisper Small".into(),
            manifest: manifest(&model_bytes),
        }],
        Arc::new(FakeSecrets::default()),
        Arc::new(FakeEnvironment),
        Arc::new(FakeDisk),
        Arc::new(FakeDownloader {
            bytes: model_bytes,
            completion,
        }),
        Arc::new(NoopMeetingPlatformChangeSink),
    )
    .unwrap();
    assert_eq!(
        restarted.content_load_count(),
        0,
        "an unchanged library restart must not re-read reviewed content bodies"
    );
}

#[test]
fn detector_policy_failure_degrades_startup_but_settings_still_surface_it() {
    let fixture = fixture_with_environment(Arc::new(FailingDetectionEnvironment));
    let diagnostic = fixture.platform.projection().unwrap().diagnostic.unwrap();
    assert!(diagnostic.contains("manual recording remains available"));
    assert!(diagnostic.chars().count() <= MAX_DIAGNOSTIC_CHARS + 100);
    assert!(
        !diagnostic.ends_with("bounded-diagnostic-tail"),
        "unbounded detector error reached the public projection"
    );

    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            detection_enabled: Some(false),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .detection_enabled
    );

    let error = fixture
        .platform
        .update_config(&MeetingConfigPatch {
            detection_enabled: Some(true),
            ..MeetingConfigPatch::default()
        })
        .unwrap_err();
    assert!(error.contains("detector unavailable"));
    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .detection_enabled,
        "a rejected detector policy must not mutate durable configuration"
    );
}

#[test]
fn delete_and_audio_export_never_follow_symlinks() {
    let fixture = fixture();
    create_meeting(&fixture, "meeting-1");
    complete_meeting(&fixture, "meeting-1");
    let audio = fixture
        .paths
        .meetings_root
        .join("meeting-1")
        .join("microphone");
    fs::create_dir_all(&audio).unwrap();
    fs::write(audio.join("0001.raw"), b"audio").unwrap();
    let hook_input = fixture
        .paths
        .meetings_root
        .join("meeting-1/followups/summary-job/transcript.jsonl");
    fs::create_dir_all(hook_input.parent().unwrap()).unwrap();
    fs::write(
        &hook_input,
        b"{\"type\":\"segment\",\"text\":\"private\"}\n",
    )
    .unwrap();
    let export = fixture
        .platform
        .export_meeting("meeting-1", MeetingExportFormat::Audio)
        .unwrap();
    assert_eq!(
        fs::read(Path::new(&export.path).join("microphone/0001.raw")).unwrap(),
        b"audio"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = fixture._directory.path().join("outside");
        fs::write(&outside, b"preserve").unwrap();
        symlink(&outside, audio.join("escape")).unwrap();
        assert!(fixture
            .platform
            .export_meeting("meeting-1", MeetingExportFormat::Audio)
            .is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"preserve");
    }

    fixture
        .store
        .begin_deletion(
            "meeting-1",
            StoreDeletionMode::All,
            &Utc::now().to_rfc3339(),
        )
        .unwrap();
    fixture
        .platform
        .delete_meeting("meeting-1", MeetingDeleteMode::All)
        .unwrap();
    assert!(matches!(
        fixture.store.get_meeting("meeting-1"),
        Err(crate::meetings::MeetingStoreError::NotFound { .. })
    ));
    assert!(!fixture.paths.content_root.join("meeting-1.json").exists());
    assert!(
        !hook_input.exists(),
        "whole-record deletion must remove managed hook transcript inputs"
    );
}

#[cfg(unix)]
#[test]
fn content_fingerprint_errors_never_disclose_private_paths() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let private_path = directory.path().join("meeting-secret.json");
    let outside = directory.path().join("outside.json");
    fs::write(&outside, b"private content").unwrap();
    symlink(&outside, &private_path).unwrap();

    let error = content_file_fingerprint(&private_path).unwrap_err();
    assert!(error.contains("regular file"));
    assert!(!error.contains(&directory.path().display().to_string()));
    assert!(!error.contains("meeting-secret"));
    assert!(!error.contains("outside.json"));
}

