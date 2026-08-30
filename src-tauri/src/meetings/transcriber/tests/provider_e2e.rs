#[tokio::test]
async fn openai_tls_peer_receives_two_channel_sessions_and_returns_live_revisions() {
    const HOST: &str = "openai-test.example";
    const BEARER: &str = "test-openai-bearer";

    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    for sequence in 0..4 {
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "microphone",
            sequence,
            &vec![0.1; SAMPLE_RATE_HZ as usize],
        );
        commit_chunk(
            &store,
            temporary.path(),
            "meeting-1",
            "system",
            sequence,
            &vec![0.7; SAMPLE_RATE_HZ as usize],
        );
    }
    let audio =
        PersistedAudioSource::authoritative(Arc::clone(&store), temporary.path(), "meeting-1")
            .unwrap();
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        ScribeDiagnostics::disabled(),
        "meeting-1",
        "openai-run",
        "custom",
        None,
        Arc::new(CountingChanges::default()),
    )
    .unwrap();

    let (server_config, client_config) = generated_tls_configs(HOST);
    let listener = Arc::new(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap());
    let address = listener.local_addr().unwrap();
    let acceptor = Arc::new(TlsAcceptor::from(Arc::new(server_config)));
    let accepted_handshakes = Arc::new(AtomicUsize::new(0));
    let server = tokio::spawn({
        let listener = Arc::clone(&listener);
        let acceptor = Arc::clone(&acceptor);
        let accepted_handshakes = Arc::clone(&accepted_handshakes);
        async move {
            let expected = format!("Bearer {BEARER}");
            let first = accept_openai_tls_websocket(
                &listener,
                &acceptor,
                &expected,
                Arc::clone(&accepted_handshakes),
            )
            .await;
            let first = tokio::spawn(serve_openai_transcription_session(first));
            let second = accept_openai_tls_websocket(
                &listener,
                &acceptor,
                &expected,
                Arc::clone(&accepted_handshakes),
            )
            .await;
            let second = tokio::spawn(serve_openai_transcription_session(second));
            (first.await.unwrap(), second.await.unwrap())
        }
    });

    let endpoint = CustomSttEndpoint::new(
        &format!("wss://{HOST}:{}/v1/realtime", address.port()),
        HOST,
    )
    .unwrap();
    let connector = InjectedOpenAiTlsConnector {
        address,
        connector: WebSocketConnector::Rustls(Arc::new(client_config)),
    };
    let request = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "openai-run".into(),
        route: endpoint.as_str().into(),
        model: "gpt-live-transcribe".into(),
        first_sequence: 0,
        repair_generation: None,
        repair_intent: None,
    };
    let (finalize_tx, finalize_rx) = mpsc::channel();
    finalize_tx
        .send(FinalizeCommand {
            observed_at: "2026-07-31T12:00:00.000Z".into(),
        })
        .unwrap();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    run_openai_realtime_with_connector(
        CustomRunContext {
            request: &request,
            endpoint: &endpoint,
            model: &request.model,
            credential: Some(BEARER),
            audio: &audio,
            finalize: &finalize_rx,
            ready: &ready_tx,
            status: &test_status_reporter(),
            diagnostics: &ScribeDiagnostics::disabled(),
        },
        &mut sink,
        &connector,
    )
    .await
    .unwrap();
    assert_eq!(ready_rx.recv().unwrap(), Ok(()));
    let sessions = server.await.unwrap();
    let mut channels = [sessions.0 .0, sessions.1 .0];
    channels.sort_unstable();
    assert_eq!(channels, ["microphone", "system"]);
    assert!(sessions.0 .1 > 0 && sessions.1 .1 > 0);
    assert_eq!(sessions.0 .2, 1);
    assert_eq!(sessions.1 .2, 1);
    assert_eq!(accepted_handshakes.load(Ordering::Relaxed), 2);

    let transcript = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(transcript.segments.len(), 2);
    let microphone = transcript
        .segments
        .iter()
        .find(|segment| segment.segment.channel_id.as_deref() == Some("microphone"))
        .unwrap();
    let system = transcript
        .segments
        .iter()
        .find(|segment| segment.segment.channel_id.as_deref() == Some("system"))
        .unwrap();
    assert_eq!(microphone.segment.speaker.as_deref(), Some("You"));
    assert_eq!(microphone.segment.text, "microphone natural speech turn");
    assert!(microphone.segment.is_final);
    assert_eq!(system.segment.speaker.as_deref(), Some("Others"));
    assert_eq!(system.segment.text, "system natural speech turn");
    assert!(system.segment.is_final);
}

#[tokio::test]
async fn generated_ca_tls_provider_reconnects_replays_and_finalizes_end_to_end() {
    const HOST: &str = "scribe-test.example";
    const BEARER: &str = "ultra-secret-bearer-value";
    const PARTIAL: &str = "private transcript sentinel";
    const FINAL: &str = "private transcript sentinel finalized";

    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[0.1, 0.2],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "system",
        0,
        &[0.3, 0.4],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        1,
        &[0.5, 0.6],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "system",
        1,
        &[0.7, 0.8],
    );
    let audio =
        PersistedAudioSource::authoritative(Arc::clone(&store), temporary.path(), "meeting-1")
            .unwrap();
    let mut sink = StoreBatchSink::new(
        Arc::clone(&store),
        ScribeDiagnostics::disabled(),
        "meeting-1",
        "tls-run",
        "custom",
        None,
        Arc::new(CountingChanges::default()),
    )
    .unwrap();

    let (server_config, client_config) = generated_tls_configs(HOST);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(server_config));
    let accepted_credentials = Arc::new(AtomicUsize::new(0));
    let credential_counter = Arc::clone(&accepted_credentials);
    let server = tokio::spawn(async move {
        let expected_authorization = format!("Bearer {BEARER}");
        let mut first = accept_tls_websocket(
            &listener,
            &acceptor,
            &expected_authorization,
            Arc::clone(&credential_counter),
        )
        .await;
        expect_start(&mut first).await;
        let first_audio = expect_audio(&mut first, 0).await;
        send_server_message(
            &mut first,
            &ServerMessage::Transcript {
                batch: provider_batch(1, "tls-partial", 1, SegmentState::Partial, PARTIAL),
            },
        )
        .await;
        send_server_message(
            &mut first,
            &ServerMessage::Error {
                code: WireId::new("transient-private-provider-detail").unwrap(),
                retryable: true,
                retry_after_ms: Some(1),
            },
        )
        .await;
        drop(first);

        let mut second = accept_tls_websocket(
            &listener,
            &acceptor,
            &expected_authorization,
            Arc::clone(&credential_counter),
        )
        .await;
        expect_start(&mut second).await;
        let replayed_audio = expect_audio(&mut second, 0).await;
        send_server_message(
            &mut second,
            &ServerMessage::Transcript {
                batch: provider_batch(2, "tls-final", 2, SegmentState::Final, FINAL),
            },
        )
        .await;
        send_server_message(
            &mut second,
            &ServerMessage::Acknowledged { audio_sequence: 0 },
        )
        .await;
        let second_audio = expect_audio(&mut second, 1).await;
        send_server_message(
            &mut second,
            &ServerMessage::Acknowledged { audio_sequence: 1 },
        )
        .await;
        let Message::Text(stop) = second.next().await.unwrap().unwrap() else {
            panic!("expected stop frame");
        };
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(stop.as_str()).unwrap(),
            ClientMessage::Stop {
                final_audio_sequence: 1
            }
        ));
        send_server_message(
            &mut second,
            &ServerMessage::Complete {
                final_provider_sequence: 2,
            },
        )
        .await;
        (first_audio, replayed_audio, second_audio)
    });

    let endpoint =
        CustomSttEndpoint::new(&format!("wss://{HOST}:{}/listen", address.port()), HOST).unwrap();
    let connector = InjectedTlsConnector {
        address,
        connector: WebSocketConnector::Rustls(Arc::new(client_config)),
    };
    let request = TranscriptionStart {
        meeting_id: "meeting-1".into(),
        run_id: "tls-run".into(),
        route: endpoint.as_str().into(),
        model: "tls-model".into(),
        first_sequence: 0,
        repair_generation: None,
        repair_intent: None,
    };
    let (finalize_tx, finalize_rx) = mpsc::channel();
    finalize_tx
        .send(FinalizeCommand {
            observed_at: "2026-07-31T12:00:00.000Z".into(),
        })
        .unwrap();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    run_custom_with_connector(
        CustomRunContext {
            request: &request,
            endpoint: &endpoint,
            model: &request.model,
            credential: Some(BEARER),
            audio: &audio,
            finalize: &finalize_rx,
            ready: &ready_tx,
            status: &test_status_reporter(),
            diagnostics: &ScribeDiagnostics::disabled(),
        },
        &mut sink,
        &connector,
    )
    .await
    .unwrap();
    assert_eq!(ready_rx.recv().unwrap(), Ok(()));
    let (first_audio, replayed_audio, second_audio) = server.await.unwrap();
    assert_eq!(first_audio, replayed_audio);
    assert_ne!(first_audio, second_audio);
    assert_eq!(accepted_credentials.load(Ordering::Relaxed), 2);
    let transcript = store.transcript_snapshot("meeting-1", None).unwrap();
    assert_eq!(transcript.segments.len(), 1);
    assert!(transcript.segments[0].segment.is_final);
    assert_eq!(transcript.segments[0].segment.text, FINAL);
    assert_eq!(sink.final_segment_count(), 1);
    assert_eq!(sink.accumulator.unresolved_partial_count(), 0);
}

#[tokio::test]
async fn scripted_wire_peer_receives_durable_audio_and_completes_with_a_final_batch() {
    let temporary = TempDir::new().unwrap();
    let store = recording_store();
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "microphone",
        0,
        &[0.25, 0.5],
    );
    commit_chunk(
        &store,
        temporary.path(),
        "meeting-1",
        "system",
        0,
        &[0.75, 1.0],
    );
    let audio = PersistedAudioSource::authoritative(store, temporary.path(), "meeting-1").unwrap();
    let (finalize_tx, finalize_rx) = mpsc::channel();
    finalize_tx
        .send(FinalizeCommand {
            observed_at: "2026-07-31T12:00:00.000Z".into(),
        })
        .unwrap();
    let (client_io, server_io) = tokio::io::duplex(512 * 1024);
    let mut client =
        tokio_tungstenite::WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
    let mut server =
        tokio_tungstenite::WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;

    let peer = async move {
        let metadata = server.next().await.unwrap().unwrap();
        let Message::Text(metadata) = metadata else {
            panic!("expected audio metadata");
        };
        let metadata: ClientMessage = serde_json::from_str(metadata.as_str()).unwrap();
        assert!(matches!(
            metadata,
            ClientMessage::Audio {
                sequence: 0,
                byte_len: 16,
                ..
            }
        ));
        let audio = server.next().await.unwrap().unwrap();
        assert!(matches!(audio, Message::Binary(bytes) if bytes.len() == 16));
        send_server_message(
            &mut server,
            &ServerMessage::Acknowledged { audio_sequence: 0 },
        )
        .await;

        let stop = server.next().await.unwrap().unwrap();
        let Message::Text(stop) = stop else {
            panic!("expected stop message");
        };
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(stop.as_str()).unwrap(),
            ClientMessage::Stop {
                final_audio_sequence: 0
            }
        ));
        send_server_message(
            &mut server,
            &ServerMessage::Transcript {
                batch: NormalizedTranscriptBatch {
                    provider_sequence: 1,
                    batch_id: WireId::new("provider-batch-1").unwrap(),
                    segments: vec![NormalizedSegment {
                        segment_id: WireId::new("utterance-1").unwrap(),
                        revision: 1,
                        state: SegmentState::Final,
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "Durable audio reached the provider.".into(),
                        channel_id: Some(WireId::new("microphone").unwrap()),
                        speaker: Some("You".into()),
                        language: Some("en".into()),
                        confidence: Some(0.99),
                    }],
                },
            },
        )
        .await;
        send_server_message(
            &mut server,
            &ServerMessage::Complete {
                final_provider_sequence: 1,
            },
        )
        .await;
        Ok::<(), ProviderFailure>(())
    };

    let mut sink = MockSink::default();
    let mut next_sequence = 0;
    let mut finalizing = false;
    let client_run = drive_custom_connection(
        &mut client,
        &audio,
        &finalize_rx,
        &mut sink,
        &mut next_sequence,
        "model-1",
        &mut finalizing,
    );
    tokio::try_join!(client_run, peer).unwrap();
    assert_eq!(next_sequence, 1);
    assert_eq!(sink.final_segment_count(), 1);
}

async fn send_server_message<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: &ServerMessage,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    websocket
        .send(Message::text(serde_json::to_string(message).unwrap()))
        .await
        .unwrap();
}

