use super::*;

pub(super) struct CustomRunContext<'a> {
    pub(super) request: &'a TranscriptionStart,
    pub(super) endpoint: &'a CustomSttEndpoint,
    pub(super) model: &'a str,
    pub(super) credential: Option<&'a str>,
    pub(super) audio: &'a PersistedAudioSource,
    pub(super) finalize: &'a Receiver<FinalizeCommand>,
    pub(super) ready: &'a SyncSender<Result<(), String>>,
    pub(super) status: &'a WorkerStatusReporter,
    pub(super) diagnostics: &'a ScribeDiagnostics,
}

pub(super) async fn run_custom(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), String> {
    run_custom_with_connector(context, sink, &ProductionCustomConnector).await
}

pub(super) trait CustomConnectionFactory: Send + Sync {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>>;
}

pub(super) struct ProductionCustomConnector;

impl CustomConnectionFactory for ProductionCustomConnector {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
        Box::pin(connect_pinned(endpoint, credential))
    }
}

pub(super) async fn run_custom_with_connector(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
    connector: &dyn CustomConnectionFactory,
) -> Result<(), String> {
    let CustomRunContext {
        request,
        endpoint,
        model,
        credential,
        audio,
        finalize,
        ready,
        status,
        diagnostics: _,
    } = context;
    let preflight = SttPreflightRequest {
        operation: TranscriptionOperation::Live,
        encoding: AudioEncoding::PcmF32Le,
        sample_rate_hz: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        channel_ids: vec![
            WireId::new("microphone").expect("static wire id"),
            WireId::new("system").expect("static wire id"),
        ],
        audio_frame_bytes: MAX_INTERLEAVED_CHUNK_BYTES as u32,
        partial_results: true,
        speaker_labels: false,
        language: None,
    };
    let session_id =
        WireId::new(request.run_id.clone()).map_err(|error| format!("invalid run id: {error}"))?;
    let model_id = WireId::new(model.to_string())
        .map_err(|error| format!("invalid custom model identifier: {error}"))?;
    let mut next_sequence = request.first_sequence;
    let mut ready_reported = false;
    let mut attempt = 0_u8;
    let mut finalizing = false;

    loop {
        status.set(if ready_reported {
            TranscriptionSessionState::Reconnecting
        } else {
            TranscriptionSessionState::Connecting
        });
        if !finalizing {
            match finalize.try_recv() {
                Ok(_) => finalizing = true,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("transcription finalization channel closed".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let connection = connector.connect(endpoint, credential).await;
        let (mut websocket, _pinned_address) = match connection {
            Ok(connection) => connection,
            Err(message) => {
                attempt = attempt.saturating_add(1);
                let maximum = if ready_reported {
                    MAX_CONNECT_ATTEMPTS
                } else {
                    MAX_INITIAL_CONNECT_ATTEMPTS
                };
                if attempt >= maximum {
                    if !ready_reported {
                        let _ = ready.send(Err(message.clone()));
                    }
                    return Err(format!(
                        "selected custom transcription provider is unavailable after {attempt} attempts: {message}"
                    ));
                }
                sleep(reconnect_delay(attempt)).await;
                continue;
            }
        };

        let handshake = async {
            send_client_message(
                &mut websocket,
                &ClientMessage::start(session_id.clone(), model_id.clone(), preflight.clone()),
            )
            .await?;
            let capabilities = match receive_server_message(&mut websocket).await? {
                ServerMessage::Ready {
                    contract,
                    capabilities,
                } => {
                    if contract != STT_WIRE_CONTRACT {
                        return Err("custom provider selected an incompatible STT contract".into());
                    }
                    capabilities
                }
                _ => return Err("custom provider did not begin with a ready frame".into()),
            };
            capabilities
                .preflight(&preflight)
                .map_err(|error| error.to_string())
        }
        .await;
        if let Err(message) = handshake {
            attempt = attempt.saturating_add(1);
            let maximum = if ready_reported {
                MAX_CONNECT_ATTEMPTS
            } else {
                MAX_INITIAL_CONNECT_ATTEMPTS
            };
            if attempt >= maximum {
                if !ready_reported {
                    let _ = ready.send(Err(message.clone()));
                }
                return Err(format!(
                    "selected custom transcription provider rejected the protocol after {attempt} attempts: {message}"
                ));
            }
            sleep(reconnect_delay(attempt)).await;
            continue;
        }
        if !ready_reported {
            ready
                .send(Ok(()))
                .map_err(|_| "transcription caller stopped during provider startup".to_string())?;
            ready_reported = true;
        }
        match drive_custom_connection(
            &mut websocket,
            audio,
            finalize,
            sink,
            &mut next_sequence,
            model,
            &mut finalizing,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(failure) if failure.retryable => {
                attempt = attempt.saturating_add(1);
                if attempt >= MAX_CONNECT_ATTEMPTS {
                    return Err(format!(
                        "selected custom transcription provider exhausted its reconnect budget ({})",
                        failure.code
                    ));
                }
                let requested = failure.retry_after.unwrap_or_default();
                sleep(
                    requested
                        .max(reconnect_delay(attempt))
                        .min(MAX_RECONNECT_DELAY),
                )
                .await;
            }
            Err(failure) => {
                return Err(format!(
                    "selected custom transcription provider failed ({})",
                    failure.code
                ))
            }
        }
    }
}

#[derive(Debug)]
pub(super) struct ProviderFailure {
    pub(super) code: String,
    pub(super) retryable: bool,
    pub(super) retry_after: Option<Duration>,
}

pub(super) async fn drive_custom_connection<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    audio: &PersistedAudioSource,
    finalize: &Receiver<FinalizeCommand>,
    sink: &mut dyn NormalizedBatchSink,
    next_sequence: &mut u64,
    _model: &str,
    finalizing: &mut bool,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        if !*finalizing {
            match finalize.try_recv() {
                Ok(_) => *finalizing = true,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(ProviderFailure {
                        code: "finalize-channel-closed".into(),
                        retryable: false,
                        retry_after: None,
                    })
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }

        let chunks = audio
            .chunks_from(*next_sequence, *finalizing, 1)
            .map_err(non_retryable)?;
        if let Some(chunk) = chunks.first() {
            send_client_message(
                websocket,
                &ClientMessage::Audio {
                    sequence: chunk.sequence,
                    start_ms: chunk.start_ms,
                    end_ms: chunk.end_ms,
                    byte_len: chunk.bytes.len() as u32,
                },
            )
            .await
            .map_err(retryable_transport)?;
            websocket
                .send(Message::binary(chunk.bytes.clone()))
                .await
                .map_err(|_| retryable("audio-send-failed"))?;
            await_acknowledgement(websocket, chunk.sequence, sink).await?;
            *next_sequence = chunk.sequence.saturating_add(1);
            continue;
        }

        if *finalizing {
            send_client_message(
                websocket,
                &ClientMessage::Stop {
                    final_audio_sequence: next_sequence.saturating_sub(1),
                },
            )
            .await
            .map_err(retryable_transport)?;
            return await_completion(websocket, sink).await;
        }
        sleep(AUDIO_POLL_INTERVAL).await;
    }
}

pub(super) async fn await_acknowledgement<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_sequence: u64,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receive_server_message(websocket)
            .await
            .map_err(retryable_transport)?
        {
            ServerMessage::Acknowledged { audio_sequence }
                if audio_sequence == expected_sequence =>
            {
                return Ok(())
            }
            ServerMessage::Acknowledged { .. } => {
                return Err(non_retryable(
                    "provider acknowledged an unexpected audio sequence",
                ))
            }
            ServerMessage::Transcript { batch } => sink.ingest(batch).map_err(non_retryable)?,
            ServerMessage::Error {
                code,
                retryable,
                retry_after_ms,
            } => {
                return Err(ProviderFailure {
                    code: opaque_provider_error_code(code.as_str()),
                    retryable,
                    retry_after: retry_after_ms.map(Duration::from_millis),
                })
            }
            ServerMessage::Complete { .. } | ServerMessage::Ready { .. } => {
                return Err(non_retryable(
                    "provider emitted an out-of-order control message",
                ))
            }
        }
    }
}

pub(super) async fn await_completion<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), ProviderFailure>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match receive_server_message(websocket)
            .await
            .map_err(retryable_transport)?
        {
            ServerMessage::Transcript { batch } => sink.ingest(batch).map_err(non_retryable)?,
            ServerMessage::Complete { .. } => {
                let _ = websocket.close(None).await;
                return Ok(());
            }
            ServerMessage::Error {
                code,
                retryable,
                retry_after_ms,
            } => {
                return Err(ProviderFailure {
                    code: opaque_provider_error_code(code.as_str()),
                    retryable,
                    retry_after: retry_after_ms.map(Duration::from_millis),
                })
            }
            ServerMessage::Acknowledged { .. } => {}
            ServerMessage::Ready { .. } => {
                return Err(non_retryable(
                    "provider emitted a second ready message during finalization",
                ))
            }
        }
    }
}
