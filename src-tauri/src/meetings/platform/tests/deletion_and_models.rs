#[test]
fn mtg_153_permanent_deletion_replays_every_fault_boundary_without_orphans() {
    for fault in [
        "after-content-hidden",
        "after-files-removed",
        "after-files-stage",
        "after-database-removed",
        "after-marker-cleanup",
    ] {
        let fixture = fixture();
        create_meeting(&fixture, "meeting-1");
        complete_meeting(&fixture, "meeting-1");
        let meeting_root = fixture.paths.meetings_root.join("meeting-1");
        fs::create_dir_all(meeting_root.join("audio")).unwrap();
        fs::write(meeting_root.join("audio/0001.raw"), b"private audio").unwrap();
        fixture
            .platform
            .update_content(
                "meeting-1",
                &MeetingUpdatePatch {
                    summary: Some("private summary".into()),
                    ..MeetingUpdatePatch::default()
                },
            )
            .unwrap();
        fixture
            .store
            .begin_deletion("meeting-1", StoreDeletionMode::All, NOW)
            .unwrap();
        fixture.platform.inject_deletion_fault(fault);

        let error = fixture
            .platform
            .delete_meeting("meeting-1", MeetingDeleteMode::All)
            .unwrap_err();
        assert!(error.contains(fault), "{fault}: {error}");
        assert!(
            fixture.store.deletion("meeting-1").unwrap().is_some(),
            "{fault} erased the recovery journal"
        );

        assert_eq!(
            fixture.platform.recover_pending_deletions().unwrap(),
            ["meeting-1"]
        );
        assert!(fixture.store.deletion("meeting-1").unwrap().is_none());
        assert!(matches!(
            fixture.store.get_meeting("meeting-1"),
            Err(crate::meetings::MeetingStoreError::NotFound { .. })
        ));
        assert!(!meeting_root.exists());
        assert!(!fixture.paths.content_root.join("meeting-1.json").exists());
    }
}

#[test]
fn mtg_153_audio_only_deletion_replays_files_database_and_cleanup_faults() {
    for fault in [
        "after-files-removed",
        "after-files-stage",
        "after-database-removed",
        "after-marker-cleanup",
    ] {
        let fixture = fixture();
        create_meeting(&fixture, "meeting-1");
        let detected = fixture.store.get_meeting("meeting-1").unwrap();
        let recording = fixture
            .store
            .transition_meeting(
                "meeting-1",
                detected.revision,
                super::super::MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        let meeting_root = fixture.paths.meetings_root.join("meeting-1");
        fs::create_dir_all(meeting_root.join("audio")).unwrap();
        let audio_path = meeting_root.join("audio/0001.f32le");
        fs::write(&audio_path, b"private audio").unwrap();
        let bytes = fs::read(&audio_path).unwrap();
        let chunk = crate::meetings::AudioChunkDraft {
            id: "audio-delete-chunk".into(),
            meeting_id: "meeting-1".into(),
            channel_id: "microphone".into(),
            sequence: 0,
            start_ms: 0,
            end_ms: 1_000,
            sample_count: 16_000,
            byte_len: bytes.len() as u64,
            sha256: Sha256Digest::calculate(Cursor::new(&bytes))
                .unwrap()
                .to_string(),
            relative_path: "meeting-1/audio/0001.f32le".into(),
        };
        fixture.store.stage_audio_chunk(&chunk, NOW).unwrap();
        fixture.store.commit_audio_chunk(&chunk.id, NOW).unwrap();
        let mut meeting = recording;
        for status in [
            super::super::MeetingStatus::Stopping,
            super::super::MeetingStatus::Finalizing,
            super::super::MeetingStatus::Completed,
        ] {
            meeting = fixture
                .store
                .transition_meeting("meeting-1", meeting.revision, status, NOW, None)
                .unwrap();
        }
        fixture
            .store
            .begin_deletion("meeting-1", StoreDeletionMode::Audio, NOW)
            .unwrap();
        fixture.platform.inject_deletion_fault(fault);
        assert!(fixture
            .platform
            .delete_meeting("meeting-1", MeetingDeleteMode::Audio)
            .unwrap_err()
            .contains(fault));

        assert_eq!(
            fixture.platform.recover_pending_deletions().unwrap(),
            ["meeting-1"]
        );
        assert!(!audio_path.exists());
        assert!(fixture.store.deletion("meeting-1").unwrap().is_none());
        assert_eq!(
            fixture.store.get_meeting("meeting-1").unwrap().status,
            super::super::MeetingStatus::Completed
        );
    }
}

#[test]
fn model_install_is_background_verified_fsynced_and_atomically_published() {
    let fixture = fixture();
    if RuntimePlatform::current().is_none() {
        assert!(fixture
            .platform
            .install_model("whisper-small")
            .unwrap_err()
            .contains("macOS arm64"));
        return;
    }
    fixture.platform.install_model("whisper-small").unwrap();
    let (done, condition) = &*fixture.completion;
    let guard = done.lock().unwrap();
    let _ = condition
        .wait_timeout_while(guard, StdDuration::from_secs(5), |value| !*value)
        .unwrap();
    for _ in 0..100 {
        if fixture
            .platform
            .projection()
            .unwrap()
            .models
            .iter()
            .any(|model| model.status == "installed")
        {
            break;
        }
        thread::sleep(StdDuration::from_millis(10));
    }
    let model = fixture.platform.projection().unwrap().models.remove(0);
    assert_eq!(model.status, "installed");
    let artifact = fixture
        .paths
        .models_root
        .join("whisper-small/test-1/model.bin");
    assert_eq!(fs::read(&artifact).unwrap(), b"verified managed model");
    assert_eq!(
        fixture
            .platform
            .managed_model_artifact("whisper-small")
            .unwrap(),
        artifact
    );
    assert!(!fs::read_dir(artifact.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".part")));
}

#[test]
fn model_download_selection_and_removal_remain_separate_across_restart() {
    if RuntimePlatform::current().is_none() {
        return;
    }
    let fixture = fixture();
    let bytes = b"verified managed model".to_vec();
    let target = "whisper-large-v3-turbo-q5_0";
    let mut turbo_manifest = manifest(&bytes);
    turbo_manifest.model_id = id(target);
    let catalog = vec![
        MeetingModelCatalogEntry {
            title: "Whisper Small".into(),
            manifest: manifest(&bytes),
        },
        MeetingModelCatalogEntry {
            title: "Whisper Large v3 Turbo (Q5)".into(),
            manifest: turbo_manifest,
        },
    ];
    let open = || {
        NativeMeetingPlatform::new(
            fixture.paths.clone(),
            fixture.store.clone(),
            catalog.clone(),
            fixture.secrets.clone(),
            Arc::new(FakeEnvironment),
            Arc::new(FakeDisk),
            Arc::new(FakeDownloader {
                bytes: bytes.clone(),
                completion: fixture.completion.clone(),
            }),
            Arc::new(NoopMeetingPlatformChangeSink),
        )
        .unwrap()
    };
    let platform = open();
    let initial = platform.projection().unwrap();
    assert_eq!(
        initial
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["whisper-small", target]
    );
    assert!(initial
        .models
        .iter()
        .all(|model| model.status == "available"));
    assert!(!*fixture.completion.0.lock().unwrap());
    for unavailable in [target, "unknown-model"] {
        assert!(platform
            .update_config(&MeetingConfigPatch {
                local_model: Some(unavailable.into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap_err()
            .contains("Download the local model"));
        assert_eq!(
            platform.projection().unwrap().config.local_model,
            "whisper-small"
        );
    }

    platform.install_model(target).unwrap();
    for _ in 0..500 {
        if platform.projection().unwrap().models[1].status == "installed" {
            break;
        }
        thread::sleep(StdDuration::from_millis(10));
    }
    let downloaded = platform.projection().unwrap();
    assert_eq!(downloaded.models[1].status, "installed");
    assert_eq!(downloaded.config.local_model, "whisper-small");
    platform
        .update_config(&MeetingConfigPatch {
            local_model: Some(target.into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    drop(platform);

    let reopened = open();
    assert_eq!(reopened.projection().unwrap().config.local_model, target);
    let artifact = reopened.managed_model_artifact(target).unwrap();
    assert_eq!(fs::read(&artifact).unwrap(), bytes);
    reopened.delete_model(target).unwrap();
    assert!(!artifact.exists());
    let removed = reopened.projection().unwrap();
    assert_eq!(removed.config.local_model, target);
    assert_eq!(removed.models[1].status, "available");
    assert!(reopened.managed_model_artifact(target).is_err());
}

#[test]
fn retention_skips_active_work_and_removes_only_expired_source_audio() {
    let fixture = fixture();
    create_meeting(&fixture, "meeting-old");
    let old = fixture.store.get_meeting("meeting-old").unwrap();
    fixture
        .store
        .transition_meeting(
            "meeting-old",
            old.revision,
            super::super::MeetingStatus::Recording,
            NOW,
            None,
        )
        .unwrap();
    let recording = fixture.store.get_meeting("meeting-old").unwrap();
    fixture
        .store
        .transition_meeting(
            "meeting-old",
            recording.revision,
            super::super::MeetingStatus::Stopping,
            NOW,
            None,
        )
        .unwrap();
    let stopping = fixture.store.get_meeting("meeting-old").unwrap();
    fixture
        .store
        .transition_meeting(
            "meeting-old",
            stopping.revision,
            super::super::MeetingStatus::Finalizing,
            NOW,
            None,
        )
        .unwrap();
    fixture
        .store
        .apply_transcript_batch(&TranscriptBatch {
            meeting_id: "meeting-old".into(),
            batch_id: "retention-terminal".into(),
            base_revision: 0,
            source: "test".into(),
            observed_at: NOW.into(),
            marks_final: true,
            changes: vec![TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: "retention-segment".into(),
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "Durable transcript".into(),
                    channel_id: Some("microphone".into()),
                    speaker: None,
                    confidence: Some(1.0),
                    is_final: true,
                    metadata: json!({}),
                },
            }],
        })
        .unwrap();
    fixture
        .store
        .transition_meeting(
            "meeting-old",
            fixture.store.get_meeting("meeting-old").unwrap().revision,
            super::super::MeetingStatus::Completed,
            NOW,
            None,
        )
        .unwrap();
    let removed = fixture
        .platform
        .enforce_retention(
            DateTime::parse_from_rfc3339("2026-09-30T10:00:00Z")
                .unwrap()
                .into(),
        )
        .unwrap();
    assert_eq!(removed, vec!["meeting-old"]);
    assert!(!fixture.platform.content("meeting-old").unwrap().deleted);
    assert!(fixture.store.get_meeting("meeting-old").is_ok());
    assert_eq!(
        fixture
            .store
            .transcript_snapshot("meeting-old", None)
            .unwrap()
            .segments
            .len(),
        1
    );
}
