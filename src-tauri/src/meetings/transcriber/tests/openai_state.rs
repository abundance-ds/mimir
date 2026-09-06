#[test]
fn openai_audio_is_resampled_and_keeps_capture_channels_separate() {
    let mut interleaved = Vec::new();
    for (microphone, system) in [(0.5_f32, -0.25_f32), (0.25_f32, -0.5_f32)] {
        interleaved.extend_from_slice(&microphone.to_le_bytes());
        interleaved.extend_from_slice(&system.to_le_bytes());
    }

    let microphone = openai_pcm16_mono(&interleaved, OpenAiChannel::Microphone).unwrap();
    let system = openai_pcm16_mono(&interleaved, OpenAiChannel::System).unwrap();
    assert_eq!(microphone.len(), 3 * size_of::<i16>());
    assert_eq!(system.len(), 3 * size_of::<i16>());
    assert!(microphone
        .as_chunks::<2>().0.iter()
        .map(|sample| i16::from_le_bytes(*sample))
        .all(|sample| sample > 0));
    assert!(system
        .as_chunks::<2>().0.iter()
        .map(|sample| i16::from_le_bytes(*sample))
        .all(|sample| sample < 0));
}

#[test]
fn openai_events_revise_one_channel_segment_with_mimir_timing() {
    let mut state = OpenAiTranscriptState::new(OpenAiChannel::System, Arc::new(AtomicU64::new(1)));
    state.queue_commit(OpenAiAudioRange {
        start_ms: 2_000,
        end_ms: 4_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "item_123"
        }))
        .unwrap();
    let partial = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_123",
            "delta": "Guten "
        }))
        .unwrap();
    let final_event = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item_123",
            "transcript": "Guten Morgen"
        }))
        .unwrap();

    let partial = &partial.batches[0].segments[0];
    assert_eq!(partial.state, SegmentState::Partial);
    assert_eq!(partial.channel_id.as_ref().unwrap().as_str(), "system");
    assert_eq!(partial.speaker.as_deref(), Some("Others"));
    assert_eq!((partial.start_ms, partial.end_ms), (2_000, 4_000));
    let completed = &final_event.batches[0].segments[0];
    assert_eq!(completed.state, SegmentState::Final);
    assert_eq!(completed.text, "Guten Morgen");
    assert_eq!(completed.segment_id, partial.segment_id);
    assert_eq!(state.pending_turn_count(), 0);
}

#[test]
fn openai_server_vad_maps_a_natural_turn_onto_a_continued_timeline() {
    let mut state = OpenAiTranscriptState::new(OpenAiChannel::System, Arc::new(AtomicU64::new(1)));
    state.observe_audio(OpenAiAudioRange {
        start_ms: 42_000,
        end_ms: 43_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.speech_started",
            "item_id": "natural-turn",
            "audio_start_ms": 250,
        }))
        .unwrap();
    state.observe_audio(OpenAiAudioRange {
        start_ms: 43_000,
        end_ms: 44_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.speech_stopped",
            "item_id": "natural-turn",
            "audio_end_ms": 1_750,
        }))
        .unwrap();
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "natural-turn",
        }))
        .unwrap();
    let completed = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "natural-turn",
            "transcript": "A complete thought with context.",
        }))
        .unwrap();

    let segment = &completed.batches[0].segments[0];
    assert_eq!((segment.start_ms, segment.end_ms), (42_250, 43_750));
    assert_eq!(state.pending_turn_count(), 0);
    assert!(!state.has_active_speech());
}

#[test]
fn openai_late_commit_ack_does_not_move_an_item_onto_the_next_turn() {
    let mut state =
        OpenAiTranscriptState::new(OpenAiChannel::Microphone, Arc::new(AtomicU64::new(1)));
    state.queue_commit(OpenAiAudioRange {
        start_ms: 0,
        end_ms: 2_000,
    });
    state.queue_commit(OpenAiAudioRange {
        start_ms: 2_000,
        end_ms: 4_000,
    });

    // This is the ordering observed from the production API: the first
    // delta can beat the corresponding committed acknowledgement.
    let partial = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "turn-1",
            "delta": "First",
        }))
        .unwrap();
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "turn-1",
        }))
        .unwrap();
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "turn-2",
        }))
        .unwrap();
    let completed = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "turn-1",
            "transcript": "First turn",
        }))
        .unwrap();
    let second = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "turn-2",
            "delta": "Second",
        }))
        .unwrap();

    assert_eq!(
        (
            partial.batches[0].segments[0].start_ms,
            partial.batches[0].segments[0].end_ms
        ),
        (0, 2_000)
    );
    assert_eq!(
        (
            completed.batches[0].segments[0].start_ms,
            completed.batches[0].segments[0].end_ms
        ),
        (0, 2_000)
    );
    assert_eq!(
        (
            second.batches[0].segments[0].start_ms,
            second.batches[0].segments[0].end_ms
        ),
        (2_000, 4_000)
    );
}

#[test]
fn openai_trailing_item_before_the_next_commit_keeps_the_last_confirmed_range() {
    let mut state =
        OpenAiTranscriptState::new(OpenAiChannel::Microphone, Arc::new(AtomicU64::new(1)));
    state.queue_commit(OpenAiAudioRange {
        start_ms: 0,
        end_ms: 2_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "confirmed-turn",
        }))
        .unwrap();
    state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "confirmed-turn",
            "transcript": "Confirmed",
        }))
        .unwrap();

    // Seen in the live dual-channel API session before the second commit
    // was available. This must not terminate an otherwise healthy worker.
    let trailing = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "trailing-item",
            "delta": "Trailing",
        }))
        .unwrap();

    assert_eq!(
        (
            trailing.batches[0].segments[0].start_ms,
            trailing.batches[0].segments[0].end_ms,
        ),
        (0, 2_000)
    );
}

#[test]
fn openai_explicit_commit_keeps_continued_meeting_timestamps_on_the_existing_timeline() {
    let mut state =
        OpenAiTranscriptState::new(OpenAiChannel::Microphone, Arc::new(AtomicU64::new(1)));
    state.queue_commit(OpenAiAudioRange {
        start_ms: 42_250,
        end_ms: 44_500,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "continued-turn-1",
        }))
        .unwrap();
    let live = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "continued-turn-1",
            "delta": "We are back",
        }))
        .unwrap();
    assert_eq!(live.batches[0].segments[0].start_ms, 42_250);

    let completed = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "continued-turn-1",
            "transcript": "We are back after the break",
        }))
        .unwrap();
    let segment = &completed.batches[0].segments[0];
    assert_eq!((segment.start_ms, segment.end_ms), (42_250, 44_500));
}

#[test]
fn openai_continuation_accepts_a_delta_before_its_first_explicit_commit() {
    let mut state =
        OpenAiTranscriptState::new(OpenAiChannel::Microphone, Arc::new(AtomicU64::new(1)));
    state.observe_audio(OpenAiAudioRange {
        start_ms: 51_000,
        end_ms: 52_000,
    });

    let partial = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "continued-before-commit",
            "delta": "We are back",
        }))
        .unwrap();
    assert_eq!(
        (
            partial.batches[0].segments[0].start_ms,
            partial.batches[0].segments[0].end_ms,
        ),
        (51_000, 52_000),
    );

    state.observe_audio(OpenAiAudioRange {
        start_ms: 52_000,
        end_ms: 53_000,
    });
    state.queue_commit(OpenAiAudioRange {
        start_ms: 51_000,
        end_ms: 53_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "continued-before-commit",
        }))
        .unwrap();
    let completed = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "continued-before-commit",
            "transcript": "We are back after the break",
        }))
        .unwrap();
    assert_eq!(
        (
            completed.batches[0].segments[0].start_ms,
            completed.batches[0].segments[0].end_ms,
        ),
        (51_000, 53_000),
    );
}

#[test]
fn openai_whitespace_only_deltas_never_become_empty_segments_or_stop_the_worker() {
    let mut state =
        OpenAiTranscriptState::new(OpenAiChannel::Microphone, Arc::new(AtomicU64::new(1)));
    state.queue_commit(OpenAiAudioRange {
        start_ms: 0,
        end_ms: 2_000,
    });
    state
        .handle(&json!({
            "type": "input_audio_buffer.committed",
            "item_id": "item_whitespace"
        }))
        .unwrap();

    let whitespace = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_whitespace",
            "delta": " \n\t"
        }))
        .unwrap();
    assert!(whitespace.batches.is_empty());

    let speech = state
        .handle(&json!({
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_whitespace",
            "delta": "Still listening"
        }))
        .unwrap();
    assert_eq!(speech.batches.len(), 1);
    assert_eq!(speech.batches[0].segments[0].text, "Still listening");
}

#[test]
fn only_openai_realtime_routes_use_the_openai_wire_contract() {
    let openai =
        CustomSttEndpoint::new("wss://api.openai.com/v1/realtime", "api.openai.com").unwrap();
    let private =
        CustomSttEndpoint::new("wss://speech.example.com/mimir-stt", "speech.example.com").unwrap();
    assert!(is_openai_realtime_route(&openai, "gpt-live-transcribe"));
    assert!(!is_openai_realtime_route(&private, "meeting-v2"));
    assert!(!is_openai_realtime_route(&openai, "meeting-v2"));
}

#[test]
fn reconnect_backoff_is_bounded() {
    assert_eq!(reconnect_delay(1), Duration::from_millis(250));
    assert_eq!(reconnect_delay(2), Duration::from_millis(500));
    assert_eq!(reconnect_delay(20), MAX_RECONNECT_DELAY);
}

#[derive(Default)]
struct MockSink {
    batches: Vec<NormalizedTranscriptBatch>,
}

impl NormalizedBatchSink for MockSink {
    fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String> {
        batch.validate().map_err(|error| error.to_string())?;
        self.batches.push(batch);
        Ok(())
    }

    fn final_segment_count(&self) -> u64 {
        self.batches
            .iter()
            .flat_map(|batch| &batch.segments)
            .filter(|segment| segment.state == SegmentState::Final)
            .count() as u64
    }
}

struct InjectedTlsConnector {
    address: SocketAddr,
    connector: WebSocketConnector,
}

impl CustomConnectionFactory for InjectedTlsConnector {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
        let address = self.address;
        let connector = self.connector.clone();
        Box::pin(async move {
            connect_prevalidated_addresses(endpoint, credential, vec![address], Some(connector))
                .await
        })
    }
}

struct InjectedOpenAiTlsConnector {
    address: SocketAddr,
    connector: WebSocketConnector,
}

impl OpenAiConnectionFactory for InjectedOpenAiTlsConnector {
    fn connect<'a>(
        &'a self,
        endpoint: &'a CustomSttEndpoint,
        credential: &'a str,
    ) -> BoxFuture<'a, Result<(PinnedWebSocket, SocketAddr), String>> {
        let address = self.address;
        let connector = self.connector.clone();
        Box::pin(async move {
            let tcp = TcpStream::connect(address)
                .await
                .map_err(|_| "test OpenAI TCP connection failed".to_string())?;
            let transport = openai_transport_url(endpoint)?;
            let mut request = transport
                .as_str()
                .into_client_request()
                .map_err(|_| "could not build test OpenAI handshake".to_string())?;
            let authorization = HeaderValue::from_str(&format!("Bearer {credential}"))
                .map_err(|_| "test OpenAI credential contains invalid bytes".to_string())?;
            request.headers_mut().insert(AUTHORIZATION, authorization);
            let configuration = WebSocketConfig::default()
                .write_buffer_size(64 * 1024)
                .max_write_buffer_size(512 * 1024)
                .max_message_size(Some(MAX_PROVIDER_RESPONSE_BYTES))
                .max_frame_size(Some(MAX_PROVIDER_FRAME_BYTES));
            let (websocket, _) =
                client_async_tls_with_config(request, tcp, Some(configuration), Some(connector))
                    .await
                    .map_err(|_| "test OpenAI TLS/WebSocket handshake failed".to_string())?;
            Ok((websocket, address))
        })
    }
}

