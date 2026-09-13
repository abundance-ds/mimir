#[cfg(unix)]
#[test]
fn platform_startup_secures_roots_without_walking_legacy_artifacts() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let directory = tempfile::tempdir().unwrap();
    let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
    let content_nested = paths.content_root.join("legacy");
    let export_nested = paths.exports_root.join("legacy");
    let model_nested = paths.models_root.join("whisper-small/test-1");
    for path in [&content_nested, &export_nested, &model_nested] {
        fs::create_dir_all(path).unwrap();
    }
    let config = PersistedMeetingConfig::new(MeetingConfig::default()).unwrap();
    fs::write(&paths.config_file, serde_json::to_vec(&config).unwrap()).unwrap();
    fs::write(content_nested.join("meeting.json"), b"legacy content").unwrap();
    fs::write(export_nested.join("transcript.md"), b"legacy export").unwrap();
    fs::write(model_nested.join("model.bin"), b"legacy model").unwrap();
    fs::write(
        &paths.model_state_file,
        serde_json::to_vec(&PersistedModelState::default()).unwrap(),
    )
    .unwrap();

    for path in [
        directory.path(),
        &paths.meetings_root,
        &paths.content_root,
        &paths.exports_root,
        paths.models_root.parent().unwrap(),
        &paths.models_root,
    ] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    for path in [&paths.config_file, &paths.model_state_file] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    // Startup deliberately does not traverse immutable meeting history or
    // large model trees. Their owner-only managed roots are the access
    // boundary; individual artifacts are repaired when opened or replaced.
    for path in [&content_nested, &export_nested, &model_nested] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755,
            "{} was unexpectedly visited during startup",
            path.display()
        );
    }
    for path in [
        &content_nested.join("meeting.json"),
        &export_nested.join("transcript.md"),
        &model_nested.join("model.bin"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o644,
            "{} was unexpectedly visited during startup",
            path.display()
        );
    }

    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    NativeMeetingPlatform::new(
        paths.clone(),
        Arc::new(MeetingStore::open_in_memory().unwrap()),
        Vec::new(),
        Arc::new(FakeSecrets::default()),
        Arc::new(FakeEnvironment),
        Arc::new(FakeDisk),
        Arc::new(FakeDownloader {
            bytes: Vec::new(),
            completion,
        }),
        Arc::new(NoopMeetingPlatformChangeSink),
    )
    .unwrap();

    for path in [
        directory.path(),
        &paths.meetings_root,
        &paths.content_root,
        &paths.exports_root,
        paths.models_root.parent().unwrap(),
        &paths.models_root,
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700,
            "{} was not repaired owner-only",
            path.display()
        );
    }
    for path in [&paths.config_file, &paths.model_state_file] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600,
            "{} was not repaired owner-only",
            path.display()
        );
    }

    for path in [&content_nested, &export_nested, &model_nested] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755,
            "{} was unexpectedly visited during startup",
            path.display()
        );
    }
    for path in [
        &content_nested.join("meeting.json"),
        &export_nested.join("transcript.md"),
        &model_nested.join("model.bin"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o644,
            "{} was unexpectedly visited during startup",
            path.display()
        );
    }

    let unsafe_root = directory.path().join("unsafe-profile");
    fs::create_dir(&unsafe_root).unwrap();
    fs::create_dir(unsafe_root.join("models")).unwrap();
    let outside = directory.path().join("outside-models");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, unsafe_root.join("models/stt")).unwrap();
    let unsafe_paths = MeetingPlatformPaths::from_mimir_root(&unsafe_root);
    let error = NativeMeetingPlatform::new(
        unsafe_paths,
        Arc::new(MeetingStore::open_in_memory().unwrap()),
        Vec::new(),
        Arc::new(FakeSecrets::default()),
        Arc::new(FakeEnvironment),
        Arc::new(FakeDisk),
        Arc::new(FakeDownloader {
            bytes: Vec::new(),
            completion: Arc::new((Mutex::new(false), Condvar::new())),
        }),
        Arc::new(NoopMeetingPlatformChangeSink),
    )
    .err()
    .expect("a symlinked managed model root must be refused");
    assert!(error.contains("symbolic link") || error.contains("private managed path"));
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}

#[test]
fn legacy_balanced_summary_default_migrates_to_the_selected_recipe() {
    let mut stored = StoredMeetingConfig::from(MeetingConfig::default());
    stored.summary_template = "brief".into();
    stored.summary_prompt = LEGACY_BALANCED_SUMMARY_PROMPT.into();

    let migrated = MeetingConfig::from(stored);

    assert_eq!(
        migrated.summary_prompt,
        super::super::runtime::summary_template_instructions("brief").unwrap()
    );

    let mut stored = StoredMeetingConfig::from(MeetingConfig::default());
    stored.summary_prompt = LEGACY_LOOSE_BLUF_SUMMARY_PROMPT.into();
    let migrated = MeetingConfig::from(stored);
    assert_eq!(
        migrated.summary_prompt,
        super::super::runtime::summary_template_instructions("standard").unwrap()
    );

    let mut stored = StoredMeetingConfig::from(MeetingConfig::default());
    stored.summary_prompt = LEGACY_FLAT_BLUF_SUMMARY_PROMPT.into();
    let migrated = MeetingConfig::from(stored);
    assert_eq!(
        migrated.summary_prompt,
        super::super::runtime::summary_template_instructions("standard").unwrap()
    );

    let mut stored = StoredMeetingConfig::from(MeetingConfig::default());
    stored.summary_prompt = LEGACY_LABELED_BLUF_SUMMARY_PROMPT.into();
    let migrated = MeetingConfig::from(stored);
    assert_eq!(
        migrated.summary_prompt,
        super::super::runtime::summary_template_instructions("standard").unwrap()
    );
}

#[test]
fn config_is_atomic_quarantined_and_custom_urls_are_strict() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            microphone_device_id: Some(Some("CoreAudio:stable-microphone-uid".into())),
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://stt.example.com/v1/listen".into()),
            custom_model: Some("nova-2".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    let stored = fs::read_to_string(&fixture.paths.config_file).unwrap();
    assert!(!stored.contains("apiKey"));
    assert_eq!(
        fixture.platform.projection().unwrap().config.custom_model,
        "nova-2"
    );
    assert_eq!(
        fixture
            .platform
            .projection()
            .unwrap()
            .config
            .microphone_device_id
            .as_deref(),
        Some("CoreAudio:stable-microphone-uid")
    );
    assert_eq!(
        fixture
            .platform
            .custom_stt_endpoint()
            .unwrap()
            .unwrap()
            .as_str(),
        "wss://stt.example.com/v1/listen"
    );

    assert!(fixture
        .platform
        .update_config(&MeetingConfigPatch {
            custom_url: Some("https://127.0.0.1/listen".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap_err()
        .contains("Unsafe"));

    fs::write(&fixture.paths.config_file, b"{not json").unwrap();
    let projection = fixture.platform.projection().unwrap();
    assert_eq!(projection.config.transcription_mode, "local");
    assert!(projection.diagnostic.unwrap().contains("moved"));
    let quarantined = fs::read_dir(fixture.paths.config_file.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
    assert!(quarantined);
}

#[test]
fn hook_configuration_never_reads_the_transcription_credential() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://stt.example.com/v1/listen".into()),
            custom_model: Some("nova-3".into()),
            summary_enabled: Some(true),
            summary_template: Some("decisions-actions".into()),
            summary_prompt: Some("List decisions first, then actions by owner.".into()),
            summary_preset: Some("concise".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();

    let hooks = fixture.platform.hook_config().unwrap();
    assert!(hooks.summary_enabled);
    assert_eq!(hooks.summary_template, "decisions-actions");
    assert_eq!(
        hooks.summary_prompt,
        "List decisions first, then actions by owner."
    );
    assert_eq!(hooks.summary_preset, "concise");
    assert_eq!(fixture.secrets.reads.load(Ordering::Relaxed), 0);

    fixture.platform.projection().unwrap();
    assert_eq!(fixture.secrets.reads.load(Ordering::Relaxed), 1);
}

#[test]
fn repeated_projections_read_the_keychain_only_once_per_endpoint() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://stt.example.com/v1/listen".into()),
            custom_model: Some("nova-3".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();

    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .api_key_configured
    );
    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .api_key_configured
    );
    let endpoint = fixture.platform.custom_stt_endpoint().unwrap().unwrap();
    assert_eq!(
        fixture.platform.custom_api_key_for(&endpoint).unwrap(),
        None
    );

    assert_eq!(fixture.secrets.reads.load(Ordering::Relaxed), 1);
}

#[test]
fn durable_detection_setting_is_applied_at_startup_and_after_updates() {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let fixture = fixture_with_environment(Arc::new(TrackingEnvironment {
        detection_updates: Arc::clone(&updates),
    }));

    assert_eq!(*updates.lock().unwrap(), vec![false]);
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            detection_enabled: Some(true),
            ..MeetingConfigPatch::default()
        })
        .unwrap();

    assert_eq!(*updates.lock().unwrap(), vec![false, true]);
}

#[test]
fn builtin_model_manifest_pins_revision_size_and_sha256() {
    let catalog = builtin_model_catalog().unwrap();
    assert_eq!(catalog.len(), 1);
    let manifest = &catalog[0].manifest;
    assert_eq!(manifest.model_id.as_str(), "whisper-small");
    assert_eq!(manifest.artifact_bytes, 487_601_967);
    assert_eq!(
        manifest.sha256.to_string(),
        "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
    );
    assert!(manifest
        .download_url
        .as_str()
        .contains("/c521a4b02f422512d734391fdf08bb08c0862f68/"));
    assert!(!manifest.download_url.as_str().contains("/main/"));
}

#[test]
fn credentials_never_enter_config_or_content_files() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://stt.example.com/v1/listen".into()),
            custom_model: Some("nova-2".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    fixture.platform.set_api_key("secret-value").unwrap();
    assert!(
        fixture
            .platform
            .projection()
            .unwrap()
            .config
            .api_key_configured
    );
    for path in [&fixture.paths.config_file, &fixture.paths.model_state_file] {
        if let Ok(bytes) = fs::read(path) {
            assert!(!String::from_utf8_lossy(&bytes).contains("secret-value"));
        }
    }
    fixture.platform.clear_api_key().unwrap();
    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .api_key_configured
    );
}

#[test]
fn credential_save_succeeds_only_after_endpoint_bound_readback() {
    struct DiscardedSecret;
    impl MeetingSecretStore for DiscardedSecret {
        fn read(&self, _endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
            Ok(None)
        }

        fn set(&self, _endpoint: &CustomSttEndpoint, _secret: &str) -> Result<(), String> {
            Ok(())
        }

        fn clear(&self) -> Result<(), String> {
            Ok(())
        }
    }

    let endpoint = custom_stt_endpoint_from_https_url("https://stt.example.com/v1/listen").unwrap();
    let error =
        store_and_verify_secret(&DiscardedSecret, &endpoint, "transient-secret").unwrap_err();
    assert!(error.contains("did not confirm"));
}

#[test]
fn credential_save_clears_an_unconfirmed_write_when_readback_errors() {
    use std::sync::atomic::{AtomicBool, Ordering};

    struct ReadbackFailure {
        cleared: AtomicBool,
    }
    impl MeetingSecretStore for ReadbackFailure {
        fn read(&self, _endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
            Err("Keychain access denied".into())
        }

        fn set(&self, _endpoint: &CustomSttEndpoint, _secret: &str) -> Result<(), String> {
            Ok(())
        }

        fn clear(&self) -> Result<(), String> {
            self.cleared.store(true, Ordering::Release);
            Ok(())
        }
    }

    let secrets = ReadbackFailure {
        cleared: AtomicBool::new(false),
    };
    let endpoint = custom_stt_endpoint_from_https_url("https://stt.example.com/v1/listen").unwrap();
    let error = store_and_verify_secret(&secrets, &endpoint, "transient-secret").unwrap_err();

    assert!(error.contains("could not confirm"));
    assert!(secrets.cleared.load(Ordering::Acquire));
}

#[test]
fn endpoint_bound_keychain_payload_rejects_legacy_and_mismatched_authority() {
    let endpoint_a = custom_stt_endpoint_from_https_url("https://a.example.com/v1/listen").unwrap();
    let endpoint_b = custom_stt_endpoint_from_https_url("https://b.example.com/v1/listen").unwrap();
    let encoded = encode_endpoint_bound_secret(&endpoint_a, "native-secret").unwrap();

    assert_eq!(
        decode_endpoint_bound_secret(&encoded, &endpoint_a).as_deref(),
        Some("native-secret")
    );
    assert_eq!(decode_endpoint_bound_secret(&encoded, &endpoint_b), None);
    assert_eq!(
        decode_endpoint_bound_secret("legacy-unbound-secret", &endpoint_a),
        None
    );
    assert!(!encoded.contains(endpoint_a.as_str()));
}

#[test]
fn changing_custom_endpoint_invalidates_keychain_secret() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://STT.example.com:443/v1/listen".into()),
            custom_model: Some("nova-2".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    fixture.platform.set_api_key("endpoint-a-secret").unwrap();
    let endpoint_a = fixture.platform.custom_stt_endpoint().unwrap().unwrap();

    // A spelling-only change preserves the same canonical authority.
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            custom_url: Some("https://stt.example.com/v1/listen".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    assert_eq!(
        fixture
            .platform
            .custom_api_key_for(&endpoint_a)
            .unwrap()
            .as_deref(),
        Some("endpoint-a-secret")
    );

    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            custom_url: Some("https://other.example.com/v1/listen".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    assert!(
        !fixture
            .platform
            .projection()
            .unwrap()
            .config
            .api_key_configured
    );
    assert!(fixture
        .platform
        .custom_api_key_for(&endpoint_a)
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn endpoint_b_receives_no_authorization_before_key_reentry() {
    let fixture = fixture();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            transcription_mode: Some("custom".into()),
            custom_url: Some("https://a.example.com/v1/listen".into()),
            custom_model: Some("nova-2".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    fixture.platform.set_api_key("endpoint-a-secret").unwrap();
    fixture
        .platform
        .update_config(&MeetingConfigPatch {
            custom_url: Some("https://b.example.com/v1/listen".into()),
            ..MeetingConfigPatch::default()
        })
        .unwrap();
    let endpoint_b = fixture.platform.custom_stt_endpoint().unwrap().unwrap();
    let resolver = EndpointBoundMeetingCredentialResolver::new(Arc::new(fixture.platform.clone()));

    assert_eq!(resolver.bearer_token(&endpoint_b).unwrap(), None);
    fixture.platform.set_api_key("endpoint-b-secret").unwrap();
    assert_eq!(
        resolver.bearer_token(&endpoint_b).unwrap().as_deref(),
        Some("endpoint-b-secret")
    );
}

#[test]
fn auto_record_true_is_rejected_by_native_configuration() {
    let fixture = fixture();
    let error = fixture
        .platform
        .update_config(&MeetingConfigPatch {
            auto_record: Some(true),
            ..MeetingConfigPatch::default()
        })
        .unwrap_err();
    assert!(error.contains("explicit human consent"));
    assert!(!fixture.platform.projection().unwrap().config.auto_record);
}

#[test]
fn model_download_diagnostics_redact_signed_redirect_queries() {
    let fixture = fixture();
    fixture.platform.inner.models.record_install_failure(
        "whisper-small",
        "Managed model download failed for https://cdn.example/model?token=SECRET_QUERY",
    );

    let diagnostic = fixture.platform.projection().unwrap().diagnostic.unwrap();
    assert!(diagnostic.contains("download did not complete"));
    assert!(!diagnostic.contains("SECRET_QUERY"));
    assert!(!diagnostic.contains("token="));
    assert!(!diagnostic.contains("https://"));
}



#[test]
fn ignored_apps_persist_reload_and_filter_candidates_before_worker_update() {
    struct Environment { updates: Arc<Mutex<Vec<Vec<MeetingIgnoredApp>>>> }
    impl MeetingEnvironmentProbe for Environment {
        fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
            let mut projection = FakeEnvironment.projection()?;
            projection.candidates = [("ai.shoulders.mimtts", "Mim Dictate"), ("us.zoom.xos", "Zoom")].into_iter().map(|(id, name)| MeetingCandidate {
                id: format!("candidate:{id}"), app_id: id.into(), app_name: name.into(), detected_at: None, confidence: 0.95,
            }).collect();
            Ok(projection)
        }
        fn set_ignored_apps(&self, apps: &[MeetingIgnoredApp]) { self.updates.lock().unwrap().push(apps.to_vec()); }
    }
    let updates = Arc::new(Mutex::new(Vec::new()));
    let environment = Arc::new(Environment { updates: updates.clone() });
    let fixture = fixture_with_environment(environment.clone());
    let ignored = vec![MeetingIgnoredApp { app_id: "ai.shoulders.mimtts".into(), app_name: "Mim Dictate".into() }];
    fixture.platform.update_config(&MeetingConfigPatch { ignored_apps: Some(ignored.clone()), ..MeetingConfigPatch::default() }).unwrap();
    assert_eq!(*updates.lock().unwrap(), vec![vec![], ignored.clone()]);
    let projection = fixture.platform.projection().unwrap();
    assert_eq!(projection.candidates.len(), 1);
    assert_eq!(projection.candidates[0].app_id, "us.zoom.xos");
    assert_eq!(projection.config.ignored_apps, ignored);
    // The environment deliberately still returns both apps: native consent sees
    // only the allowed candidate even before the worker processes its wake.
    let reopened = NativeMeetingPlatform::new(
        fixture.paths.clone(), fixture.store.clone(), Vec::new(), fixture.secrets.clone(), environment,
        Arc::new(FakeDisk), Arc::new(FakeDownloader { bytes: Vec::new(), completion: fixture.completion.clone() }),
        Arc::new(NoopMeetingPlatformChangeSink),
    ).unwrap();
    assert_eq!(updates.lock().unwrap().last(), Some(&ignored));
    assert_eq!(reopened.projection().unwrap().config.ignored_apps, ignored);
    reopened.update_config(&MeetingConfigPatch { ignored_apps: Some(vec![]), ..MeetingConfigPatch::default() }).unwrap();
    assert_eq!(reopened.projection().unwrap().candidates.len(), 2);
}

#[test]
fn legacy_config_has_no_exclusions_and_invalid_exclusions_do_not_replace_config() {
    let fixture = fixture();
    let mut stored = serde_json::to_value(PersistedMeetingConfig::new(MeetingConfig::default()).unwrap()).unwrap();
    stored["config"].as_object_mut().unwrap().remove("ignoredApps");
    fs::write(&fixture.paths.config_file, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert!(fixture.platform.projection().unwrap().config.ignored_apps.is_empty());
    let app = MeetingIgnoredApp { app_id: "ai.shoulders.mimtts".into(), app_name: "Mim Dictate".into() };
    for invalid in [
        vec![app.clone(), MeetingIgnoredApp { app_id: app.app_id.to_ascii_uppercase(), ..app.clone() }],
        vec![MeetingIgnoredApp { app_id: "pid:671".into(), ..app.clone() }],
        vec![MeetingIgnoredApp { app_name: "".into(), ..app.clone() }],
        vec![app.clone(); 129],
    ] {
        assert!(fixture.platform.update_config(&MeetingConfigPatch { ignored_apps: Some(invalid), ..MeetingConfigPatch::default() }).is_err());
        assert!(fixture.platform.projection().unwrap().config.ignored_apps.is_empty());
    }
}
