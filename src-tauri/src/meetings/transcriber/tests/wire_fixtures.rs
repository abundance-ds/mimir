fn generated_tls_configs(host: &str) -> (ServerConfig, ClientConfig) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = CertifiedIssuer::self_signed(ca_params, KeyPair::generate().unwrap()).unwrap();
    let server_key = KeyPair::generate().unwrap();
    let server_params = CertificateParams::new(vec![host.to_string()]).unwrap();
    let server_certificate = server_params.signed_by(&server_key, &ca).unwrap();
    let private_key = PrivatePkcs8KeyDer::from(server_key.serialize_der()).into();
    let server = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![server_certificate.der().clone(), ca.der().clone()],
            private_key,
        )
        .unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ca.der().to_vec())).unwrap();
    let client = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    (server, client)
}

fn custom_capabilities() -> SttCapabilities {
    SttCapabilities {
        contract_version: STT_WIRE_VERSION,
        operations: [TranscriptionOperation::Live].into_iter().collect(),
        encodings: [AudioEncoding::PcmF32Le].into_iter().collect(),
        sample_rates_hz: [SAMPLE_RATE_HZ].into_iter().collect(),
        max_channels: CHANNELS,
        max_audio_frame_bytes: MAX_INTERLEAVED_CHUNK_BYTES as u32,
        supports_partial_results: true,
        supports_speaker_labels: false,
        languages: LanguageCapability::Any,
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the tungstenite handshake callback fixes this result type"
)]
async fn accept_tls_websocket(
    listener: &TcpListener,
    acceptor: &TlsAcceptor,
    expected_authorization: &str,
    accepted_credentials: Arc<AtomicUsize>,
) -> tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<TcpStream>> {
    let (tcp, _) = listener.accept().await.unwrap();
    let tls = acceptor.accept(tcp).await.unwrap();
    let expected_authorization = expected_authorization.to_string();
    accept_hdr_async(tls, move |request: &Request, mut response: Response| {
        let credential_matches = request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            == Some(expected_authorization.as_str());
        let protocol_matches = request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            == Some(STT_WIRE_CONTRACT);
        if credential_matches && protocol_matches {
            accepted_credentials.fetch_add(1, Ordering::Relaxed);
        }
        response.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(STT_WIRE_CONTRACT),
        );
        Ok(response)
    })
    .await
    .unwrap()
}

#[allow(
    clippy::result_large_err,
    reason = "the tungstenite handshake callback fixes this result type"
)]
async fn accept_openai_tls_websocket(
    listener: &TcpListener,
    acceptor: &TlsAcceptor,
    expected_authorization: &str,
    accepted_handshakes: Arc<AtomicUsize>,
) -> tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<TcpStream>> {
    let (tcp, _) = listener.accept().await.unwrap();
    let tls = acceptor.accept(tcp).await.unwrap();
    let expected_authorization = expected_authorization.to_string();
    accept_hdr_async(tls, move |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), "/v1/realtime");
        assert_eq!(request.uri().query(), Some("intent=transcription"));
        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some(expected_authorization.as_str())
        );
        assert!(request.headers().get("sec-websocket-protocol").is_none());
        accepted_handshakes.fetch_add(1, Ordering::Relaxed);
        Ok(response)
    })
    .await
    .unwrap()
}

async fn serve_openai_transcription_session<S>(
    mut websocket: tokio_tungstenite::WebSocketStream<S>,
) -> (&'static str, usize, usize)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(configuration) = websocket.next().await.unwrap().unwrap() else {
        panic!("expected OpenAI session.update");
    };
    let configuration: serde_json::Value = serde_json::from_str(&configuration).unwrap();
    assert_eq!(configuration["type"], "session.update");
    assert_eq!(
        configuration["session"]["audio"]["input"]["format"]["rate"],
        OPENAI_SAMPLE_RATE_HZ
    );
    assert_eq!(
        configuration["session"]["audio"]["input"]["transcription"]["model"],
        "gpt-live-transcribe"
    );
    assert_eq!(
        configuration["session"]["audio"]["input"]["turn_detection"],
        json!({
            "type": "server_vad",
            "threshold": OPENAI_VAD_THRESHOLD,
            "prefix_padding_ms": OPENAI_VAD_PREFIX_PADDING_MS,
            "silence_duration_ms": OPENAI_VAD_SILENCE_DURATION_MS,
        })
    );
    websocket
        .send(Message::text(
            json!({ "type": "session.updated" }).to_string(),
        ))
        .await
        .unwrap();

    let mut total_audio_bytes = 0_usize;
    let mut turns = 0_usize;
    let mut source_chunks = 0_usize;
    let mut channel = None;
    loop {
        match websocket.next().await.unwrap().unwrap() {
            Message::Text(text) => {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                match value["type"].as_str().unwrap_or_default() {
                    "input_audio_buffer.append" => {
                        let bytes = BASE64_STANDARD
                            .decode(value["audio"].as_str().unwrap())
                            .unwrap();
                        if channel.is_none() {
                            let first_sample =
                                i16::from_le_bytes(bytes[..2].try_into().expect("PCM16 sample"));
                            channel.get_or_insert(if first_sample.abs() < 10_000 {
                                "microphone"
                            } else {
                                "system"
                            });
                        }
                        total_audio_bytes = total_audio_bytes.saturating_add(bytes.len());
                        let is_tail_padding = bytes.iter().all(|byte| *byte == 0);
                        if !is_tail_padding {
                            source_chunks = source_chunks.saturating_add(1);
                            let channel = channel.expect("source audio identifies a channel");
                            let item_id = format!("{channel}-item-1");
                            if source_chunks == 1 {
                                websocket
                                    .send(Message::text(
                                        json!({
                                            "type": "input_audio_buffer.speech_started",
                                            "item_id": item_id,
                                            "audio_start_ms": 0,
                                        })
                                        .to_string(),
                                    ))
                                    .await
                                    .unwrap();
                            }
                            if source_chunks == 4 {
                                turns = 1;
                                let transcript = format!("{channel} natural speech turn");
                                for event in [
                                    json!({
                                        "type": "input_audio_buffer.speech_stopped",
                                        "item_id": item_id,
                                        "audio_end_ms": 4_000,
                                    }),
                                    json!({
                                        "type": "input_audio_buffer.committed",
                                        "item_id": item_id,
                                    }),
                                    json!({
                                        "type": "conversation.item.input_audio_transcription.delta",
                                        "item_id": item_id,
                                        "delta": transcript.split_whitespace().next().unwrap(),
                                    }),
                                    json!({
                                        "type": "conversation.item.input_audio_transcription.completed",
                                        "item_id": item_id,
                                        "transcript": transcript,
                                    }),
                                ] {
                                    websocket
                                        .send(Message::text(event.to_string()))
                                        .await
                                        .unwrap();
                                }
                            }
                        }
                    }
                    unexpected => panic!("unexpected OpenAI client event {unexpected}"),
                }
            }
            Message::Close(_) => {
                return (
                    channel.expect("OpenAI test session received source audio"),
                    total_audio_bytes,
                    turns,
                )
            }
            _ => {}
        }
    }
}

async fn expect_start<S>(websocket: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(text) = websocket.next().await.unwrap().unwrap() else {
        panic!("expected start metadata");
    };
    let ClientMessage::Start {
        contract, request, ..
    } = serde_json::from_str::<ClientMessage>(text.as_str()).unwrap()
    else {
        panic!("expected start frame");
    };
    assert_eq!(contract, STT_WIRE_CONTRACT);
    assert_eq!(request.encoding, AudioEncoding::PcmF32Le);
    assert_eq!(request.channels, CHANNELS);
    send_server_message(
        websocket,
        &ServerMessage::Ready {
            contract: STT_WIRE_CONTRACT.into(),
            capabilities: custom_capabilities(),
        },
    )
    .await;
}

async fn expect_audio<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_sequence: u64,
) -> Vec<u8>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(metadata) = websocket.next().await.unwrap().unwrap() else {
        panic!("expected audio metadata");
    };
    let ClientMessage::Audio {
        sequence, byte_len, ..
    } = serde_json::from_str::<ClientMessage>(metadata.as_str()).unwrap()
    else {
        panic!("expected audio metadata frame");
    };
    assert_eq!(sequence, expected_sequence);
    let Message::Binary(audio) = websocket.next().await.unwrap().unwrap() else {
        panic!("expected binary audio");
    };
    assert_eq!(audio.len(), byte_len as usize);
    audio.to_vec()
}

fn provider_batch(
    provider_sequence: u64,
    batch_id: &str,
    revision: u64,
    state: SegmentState,
    text: &str,
) -> NormalizedTranscriptBatch {
    NormalizedTranscriptBatch {
        provider_sequence,
        batch_id: WireId::new(batch_id).unwrap(),
        segments: vec![NormalizedSegment {
            segment_id: WireId::new("tls-utterance").unwrap(),
            revision,
            state,
            start_ms: 0,
            end_ms: 1_000,
            text: text.into(),
            channel_id: Some(WireId::new("microphone").unwrap()),
            speaker: Some("You".into()),
            language: Some("en".into()),
            confidence: Some(0.98),
        }],
    }
}

