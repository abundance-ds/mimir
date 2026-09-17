#[cfg(unix)]
#[test]
fn durable_audio_reader_rejects_symlinked_parent_components() {
    use std::os::unix::fs::symlink;

    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let outside = temporary.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    let (definition, bytes) = chunk_definition("meeting-1", "microphone", 0, &[0.75]);
    fs::write(outside.join("00000000.f32le"), bytes).unwrap();
    store
        .stage_audio_chunk(&definition, "2026-07-30T10:00:02Z")
        .unwrap();
    store
        .commit_audio_chunk(&definition.id, "2026-07-30T10:00:03Z")
        .unwrap();
    let meeting_audio = temporary.path().join("meeting-1").join("audio");
    fs::create_dir_all(&meeting_audio).unwrap();
    symlink(&outside, meeting_audio.join("microphone")).unwrap();
    fs::create_dir_all(meeting_audio.join("system")).unwrap();
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

    let error = source.final_chunks_from(0).unwrap_err();

    assert!(error.contains("without following links"));
}

#[test]
fn a_shorter_channel_is_padded_without_mutating_its_durable_file() {
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
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[3.0]);
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    let values = source.paired_chunks_from(0).unwrap()[0]
        .bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|sample| f32::from_le_bytes(*sample))
        .collect::<Vec<_>>();
    assert_eq!(values, vec![1.0, 3.0, 2.0, 0.0]);
    assert_eq!(
        fs::metadata(
            temporary
                .path()
                .join("meeting-1/audio/system/00000000.f32le")
        )
        .unwrap()
        .len(),
        4
    );
}

#[test]
fn an_unpaired_chunk_is_not_disclosed_to_the_provider() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[1.0],
    );
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    assert!(source.paired_chunks_from(0).unwrap().is_empty());
    let final_chunk = source.final_chunks_from(0).unwrap().pop().unwrap();
    let values = final_chunk
        .bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|sample| f32::from_le_bytes(*sample))
        .collect::<Vec<_>>();
    assert_eq!(values, vec![1.0, 0.0]);
}

#[test]
fn live_reader_never_advances_past_an_unpaired_sequence() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[1.0],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        1,
        &[2.0],
    );
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 1, &[3.0]);
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

    assert!(source.paired_chunks_from(0).unwrap().is_empty());
    let final_chunks = source.final_chunks_from(0).unwrap();
    assert_eq!(
        final_chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
}

#[test]
fn durable_audio_reads_are_contiguous_and_memory_bounded() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    for sequence in 0..40 {
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            sequence,
            &[1.0],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            sequence,
            &[2.0],
        );
    }
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    let chunks = source.paired_chunks_from_bounded(0, 7).unwrap();
    assert_eq!(chunks.len(), 7);
    assert_eq!(chunks.last().unwrap().sequence, 6);
    assert!(source.paired_chunks_from_bounded(0, 0).is_err());
    assert!(source
        .paired_chunks_from_bounded(0, MAX_AUDIO_READ_CHUNKS + 1)
        .is_err());
}

#[test]
fn unregistered_staged_and_corrupt_files_are_silence_not_stt_input() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();

    let (unregistered, unregistered_bytes) =
        chunk_definition("meeting-1", "microphone", 0, &[91.0]);
    write_chunk_file(temporary.path(), &unregistered, &unregistered_bytes);
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[1.0]);

    stage_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        1,
        &[92.0],
    );
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 1, &[2.0]);

    let corrupt = stage_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        2,
        &[93.0],
    );
    store
        .mark_audio_chunk_corrupt(
            &corrupt.id,
            "test integrity rejection",
            "2026-07-30T10:00:03Z",
        )
        .unwrap();
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 2, &[3.0]);

    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    assert!(source.paired_chunks_from(0).unwrap().is_empty());
    let projected = source
        .final_chunks_from(0)
        .unwrap()
        .into_iter()
        .flat_map(|chunk| {
            chunk
                .bytes
                .as_chunks::<BYTES_PER_SAMPLE>()
                .0
                .iter()
                .map(|sample| f32::from_le_bytes(*sample))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    assert_eq!(projected, vec![0.0, 1.0, 0.0, 2.0, 0.0, 3.0]);
    assert!(!projected.contains(&91.0));
    assert!(!projected.contains(&92.0));
    assert!(!projected.contains(&93.0));
}

#[test]
fn tampered_committed_file_fails_sha256_before_stt_disclosure() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let microphone = commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[1.0],
    );
    commit_chunk(&store, temporary.path(), "meeting-1", "system", 0, &[2.0]);
    fs::write(
        temporary.path().join(&microphone.relative_path),
        9_f32.to_le_bytes(),
    )
    .unwrap();
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

    let error = source.final_chunks_from(0).unwrap_err();

    assert!(error.contains("SHA-256"));
}

#[test]
fn noncanonical_committed_database_path_is_rejected_before_file_read() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    let (mut definition, bytes) = chunk_definition("meeting-1", "microphone", 0, &[7.0]);
    definition.relative_path = "meeting-1/audio/microphone/alternate.f32le".into();
    write_chunk_file(temporary.path(), &definition, &bytes);
    store
        .stage_audio_chunk(&definition, "2026-07-30T10:00:02Z")
        .unwrap();
    store
        .commit_audio_chunk(&definition.id, "2026-07-30T10:00:03Z")
        .unwrap();
    let source = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();

    let error = source.final_chunks_from(0).unwrap_err();

    assert!(error.contains("not canonical"));
}

#[test]
fn route_resolution_has_exactly_local_or_secure_custom_modes() {
    let resolver = RuntimeRouteResolver;
    let local = resolver
        .resolve(&TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "run-1".into(),
            route: "local".into(),
            model: "whisper-small".into(),
            first_sequence: 0,
            repair_generation: None,
            repair_intent: None,
        })
        .unwrap();
    assert!(matches!(local, ResolvedTranscriptionProvider::Local { .. }));

    let custom = resolver
        .resolve(&TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "run-1".into(),
            route: "https://speech.example.com/mimir".into(),
            model: "meeting-model".into(),
            first_sequence: 0,
            repair_generation: None,
            repair_intent: None,
        })
        .unwrap();
    let ResolvedTranscriptionProvider::Custom { endpoint, .. } = custom else {
        panic!("expected custom route");
    };
    assert_eq!(endpoint.as_str(), "wss://speech.example.com/mimir");

    assert!(resolver
        .resolve(&TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "run-1".into(),
            route: "http://speech.example.com/mimir".into(),
            model: "meeting-model".into(),
            first_sequence: 0,
            repair_generation: None,
            repair_intent: None,
        })
        .is_err());
    assert!(resolver
        .resolve(&TranscriptionStart {
            meeting_id: "meeting-1".into(),
            run_id: "run-1".into(),
            route: "http://127.0.0.1:9000/mimir".into(),
            model: "meeting-model".into(),
            first_sequence: 0,
            repair_generation: None,
            repair_intent: None,
        })
        .is_err());
}

#[test]
fn local_default_is_explicitly_unavailable() {
    let unavailable = UnavailableLocalTranscriber;
    let error = unavailable.verify("whisper-small").unwrap_err();
    assert!(error.contains("unavailable"));
    assert!(!error.contains("success"));
}

#[test]
fn diagnostics_omit_credentials_provider_details_transcript_and_audio() {
    const SECRET: &str = "SUPER_SECRET_BEARER_TOKEN_ABC123";
    struct LeakingCredentialResolver;
    impl MeetingCredentialResolver for LeakingCredentialResolver {
        fn bearer_token(&self, _endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
            Err(format!("credential lookup failed with {SECRET}"))
        }
    }

    let endpoint =
        CustomSttEndpoint::new("wss://speech.example.com/mimir", "speech.example.com").unwrap();
    let credential_error =
        resolve_custom_credential(&LeakingCredentialResolver, &endpoint).unwrap_err();
    assert_eq!(
        credential_error,
        "could not resolve custom transcription credential"
    );
    assert!(!credential_error.contains(SECRET));

    let output = sanitize_error_code(&format!("TLS peer said {SECRET}"));
    assert!(output.len() <= 96);
    assert!(!output.contains(SECRET));
    assert!(output
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-'));
    let provider = opaque_provider_error_code(SECRET);
    assert!(!provider.contains(SECRET));
    assert_eq!(
        actionable_openai_error_code("invalid_api_key"),
        "authentication-failed"
    );
    assert_eq!(
        actionable_openai_error_code("insufficient_quota"),
        "quota-exhausted"
    );
    assert!(actionable_openai_error_code(SECRET).starts_with("provider-error-"));
    assert!(!actionable_openai_error_code(SECRET).contains(SECRET));

    let chunk = PersistedAudioChunk {
        sequence: 1,
        start_ms: 0,
        end_ms: 1_000,
        bytes: SECRET.as_bytes().to_vec(),
    };
    let chunk_debug = format!("{chunk:?}");
    assert!(!chunk_debug.contains(SECRET));
    assert!(chunk_debug.contains(&format!("{} bytes", SECRET.len())));

    let transcript = provider_batch(1, "diagnostic", 1, SegmentState::Partial, SECRET);
    let transcript_debug = format!("{transcript:?}");
    assert!(!transcript_debug.contains(SECRET));
}

#[test]
fn sealed_audio_reader_excludes_later_recordings_from_live_and_final_reads() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    for channel in ["microphone", "system"] {
        commit_chunk(&store, temporary.path(), "meeting-1", channel, 0, &[1.0]);
    }
    let source =
        PersistedAudioSource::authoritative(store.clone(), temporary.path(), "meeting-1").unwrap();
    let worker_source = source.clone();
    source.end_sequence.store(1, Ordering::Release);
    for channel in ["microphone", "system"] {
        commit_chunk(&store, temporary.path(), "meeting-1", channel, 1, &[2.0]);
    }
    assert_eq!(worker_source.paired_chunks_from(0).unwrap().len(), 1);
    assert_eq!(worker_source.final_chunks_from(0).unwrap().len(), 1);
    assert!(worker_source.final_chunks_from(1).unwrap().is_empty());
    let continued =
        PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    assert_eq!(continued.final_chunks_from(1).unwrap()[0].sequence, 1);
}
