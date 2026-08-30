use super::*;

pub(super) async fn run_openai_realtime(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
) -> Result<(), String> {
    run_openai_realtime_with_connector(context, sink, &ProductionOpenAiConnector).await
}

pub(super) trait OpenAiConnectionFactory: Send + Sync {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: &'a str,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>>;
}

pub(super) struct ProductionOpenAiConnector;

impl OpenAiConnectionFactory for ProductionOpenAiConnector {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: &'a str,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
        Box::pin(connect_openai_pinned(endpoint, credential))
    }
}

pub(super) async fn run_openai_realtime_with_connector(
    context: CustomRunContext<'_>,
    sink: &mut dyn NormalizedBatchSink,
    connector: &dyn OpenAiConnectionFactory,
) -> Result<(), String> {
    let credential = context
        .credential
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenAI transcription requires an API key stored in Keychain".to_string())?;
    let (microphone, system) = tokio::try_join!(
        openai_session(context.endpoint, credential, context.model, connector),
        openai_session(context.endpoint, credential, context.model, connector),
    )?;
    context.diagnostics.record(
        "openai.sessions.ready",
        json!({ "channels": ["microphone", "system"] }),
    );
    context
        .ready
        .send(Ok(()))
        .map_err(|_| "transcription caller stopped during OpenAI startup".to_string())?;

    let (finalize_tx, finalize_rx) = tokio::sync::watch::channel(false);
    let (batch_tx, mut batch_rx) = tokio::sync::mpsc::unbounded_channel();
    let sequence = Arc::new(AtomicU64::new(1));
    let microphone_future = drive_openai_channel(
        microphone,
        context.audio.clone(),
        OpenAiChannel::Microphone,
        finalize_rx.clone(),
        batch_tx.clone(),
        Arc::clone(&sequence),
        context.request.first_sequence,
        context.diagnostics.clone(),
    );
    let system_future = drive_openai_channel(
        system,
        context.audio.clone(),
        OpenAiChannel::System,
        finalize_rx,
        batch_tx,
        sequence,
        context.request.first_sequence,
        context.diagnostics.clone(),
    );
    tokio::pin!(microphone_future);
    tokio::pin!(system_future);
    let mut microphone_done = false;
    let mut system_done = false;
    let mut finalizing = false;
    let mut poll = tokio::time::interval(Duration::from_millis(50));

    while !microphone_done || !system_done {
        tokio::select! {
            Some(batch) = batch_rx.recv() => sink.ingest(batch)?,
            result = &mut microphone_future, if !microphone_done => {
                result?;
                microphone_done = true;
            }
            result = &mut system_future, if !system_done => {
                result?;
                system_done = true;
            }
            _ = poll.tick() => {
                if !finalizing {
                    match context.finalize.try_recv() {
                        Ok(_) => {
                            finalizing = true;
                            let _ = finalize_tx.send(true);
                        }
                        Err(mpsc::TryRecvError::Disconnected) => {
                            return Err("transcription finalization channel closed".into());
                        }
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                }
            }
        }
    }
    while let Ok(batch) = batch_rx.try_recv() {
        sink.ingest(batch)?;
    }
    Ok(())
}

pub(super) async fn openai_session(
    endpoint: &CustomSttEndpoint,
    credential: &str,
    model: &str,
    connector: &dyn OpenAiConnectionFactory,
) -> Result<PinnedWebSocket, String> {
    let (mut websocket, _) = connector.connect(endpoint, credential).await?;
    websocket
        .send(Message::text(
            json!({
                "type": "session.update",
                "session": {
                    "type": "transcription",
                    "audio": {
                        "input": {
                            "format": {
                                "type": "audio/pcm",
                                "rate": OPENAI_SAMPLE_RATE_HZ
                            },
                            "transcription": {
                                "model": model,
                                "delay": "low"
                            },
                            "turn_detection": {
                                "type": "server_vad",
                                "threshold": OPENAI_VAD_THRESHOLD,
                                "prefix_padding_ms": OPENAI_VAD_PREFIX_PADDING_MS,
                                "silence_duration_ms": OPENAI_VAD_SILENCE_DURATION_MS
                            }
                        }
                    }
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|_| "could not configure OpenAI realtime transcription".to_string())?;
    loop {
        let message = timeout(PROVIDER_RESPONSE_TIMEOUT, websocket.next())
            .await
            .map_err(|_| "OpenAI realtime session setup timed out".to_string())?
            .ok_or_else(|| "OpenAI realtime session closed during setup".to_string())?
            .map_err(|_| "OpenAI realtime session setup failed".to_string())?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "OpenAI realtime session returned invalid JSON".to_string())?;
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("session.updated") => return Ok(websocket),
            Some("error") => {
                let code = value
                    .pointer("/error/code")
                    .or_else(|| value.pointer("/error/type"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("session-rejected");
                return Err(format!(
                    "OpenAI realtime session was rejected ({})",
                    actionable_openai_error_code(code)
                ));
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn drive_openai_channel(
    websocket: PinnedWebSocket,
    audio: PersistedAudioSource,
    channel: OpenAiChannel,
    mut finalizing_rx: tokio::sync::watch::Receiver<bool>,
    batches: tokio::sync::mpsc::UnboundedSender<NormalizedTranscriptBatch>,
    sequence: Arc<AtomicU64>,
    first_sequence: u64,
    diagnostics: ScribeDiagnostics,
) -> Result<(), String> {
    let (mut writer, mut reader) = websocket.split();
    let mut transcript = OpenAiTranscriptState::new(channel, sequence);
    let mut next_sequence = first_sequence;
    let mut finalizing = *finalizing_rx.borrow();
    let mut source_exhausted_since = None;
    let mut vad_tail_padded = false;
    let mut poll = tokio::time::interval(AUDIO_POLL_INTERVAL);

    loop {
        tokio::select! {
            changed = finalizing_rx.changed(), if !finalizing => {
                if changed.is_err() || *finalizing_rx.borrow() {
                    finalizing = true;
                }
            }
            message = reader.next() => {
                let message = message
                    .ok_or_else(|| "OpenAI realtime connection closed before finalization".to_string())?
                    .map_err(|_| "OpenAI realtime connection failed".to_string())?;
                match message {
                    Message::Text(text) => {
                        let value: serde_json::Value = serde_json::from_str(&text)
                            .map_err(|_| "OpenAI realtime returned invalid JSON".to_string())?;
                        let event_type = value.get("type")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown");
                        if matches!(
                            event_type,
                            "input_audio_buffer.speech_started"
                                | "input_audio_buffer.speech_stopped"
                                | "input_audio_buffer.committed"
                                | "conversation.item.input_audio_transcription.completed"
                                | "conversation.item.input_audio_transcription.failed"
                                | "error"
                        ) {
                            diagnostics.record(
                                "openai.event.received",
                                json!({
                                    "channel": channel.id(),
                                    "type": event_type,
                                    "transcriptChars": value.get("transcript").and_then(serde_json::Value::as_str).map(str::len),
                                    "errorCode": value.pointer("/error/code").or_else(|| value.pointer("/error/type")).and_then(serde_json::Value::as_str),
                                    "errorParam": value.pointer("/error/param").and_then(serde_json::Value::as_str),
                                }),
                            );
                        }
                        let effect = transcript.handle(&value)?;
                        for batch in effect.batches {
                            batches.send(batch)
                                .map_err(|_| "OpenAI transcript consumer stopped".to_string())?;
                        }
                    }
                    Message::Close(_) => {
                        return Err("OpenAI realtime connection closed before finalization".into());
                    }
                    Message::Ping(bytes) => {
                        writer.send(Message::Pong(bytes)).await
                            .map_err(|_| "OpenAI realtime keepalive failed".to_string())?;
                    }
                    _ => {}
                }
            }
            _ = poll.tick() => {
                let chunks = audio.chunks_from(next_sequence, finalizing, 1)?;
                if let Some(chunk) = chunks.first() {
                    source_exhausted_since = None;
                    let pcm = openai_pcm16_mono(&chunk.bytes, channel)?;
                    writer.send(Message::text(json!({
                        "type": "input_audio_buffer.append",
                        "audio": BASE64_STANDARD.encode(pcm),
                    }).to_string())).await
                        .map_err(|_| "could not stream audio to OpenAI".to_string())?;
                    transcript.observe_audio(OpenAiAudioRange {
                        start_ms: chunk.start_ms,
                        end_ms: chunk.end_ms,
                    });
                    next_sequence = chunk.sequence.saturating_add(1);
                    diagnostics.record(
                        "openai.audio.appended",
                        json!({
                            "channel": channel.id(),
                            "sequence": chunk.sequence,
                            "startMs": chunk.start_ms,
                            "endMs": chunk.end_ms,
                        }),
                    );
                    continue;
                }
                if finalizing {
                    if !vad_tail_padded {
                        let silence = vec![
                            0_u8;
                            OPENAI_SAMPLE_RATE_HZ as usize * size_of::<i16>()
                        ];
                        writer.send(Message::text(json!({
                            "type": "input_audio_buffer.append",
                            "audio": BASE64_STANDARD.encode(silence),
                        }).to_string())).await
                            .map_err(|_| "could not flush OpenAI voice activity at Stop".to_string())?;
                        vad_tail_padded = true;
                        source_exhausted_since = Some(Instant::now());
                        diagnostics.record(
                            "openai.vad.tail-padded",
                            json!({ "channel": channel.id() }),
                        );
                        continue;
                    }
                    let settled = source_exhausted_since
                        .is_some_and(|started| started.elapsed() >= OPENAI_VAD_SETTLE_TIMEOUT);
                    if settled
                        && transcript.pending_turn_count() == 0
                        && !transcript.has_active_speech()
                    {
                        diagnostics.record(
                            "openai.channel.finished",
                            json!({ "channel": channel.id(), "nextSequence": next_sequence }),
                        );
                        let _ = writer.send(Message::Close(None)).await;
                        return Ok(());
                    }
                    if source_exhausted_since
                        .is_some_and(|started| started.elapsed() > OPENAI_FINALIZE_TIMEOUT)
                    {
                        return Err("OpenAI realtime transcript did not finish before the recovery deadline".into());
                    }
                }
            }
        }
    }
}
