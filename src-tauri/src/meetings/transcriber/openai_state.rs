use super::*;

pub(super) fn is_openai_realtime_route(endpoint: &CustomSttEndpoint, model: &str) -> bool {
    Url::parse(endpoint.as_str()).is_ok_and(|url| {
        url.path().trim_end_matches('/') == "/v1/realtime" && model.starts_with("gpt-")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OpenAiChannel {
    Microphone,
    System,
}

impl OpenAiChannel {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
        }
    }

    pub(super) fn speaker(self) -> &'static str {
        match self {
            Self::Microphone => "You",
            Self::System => "Others",
        }
    }

    pub(super) fn interleaved_index(self) -> usize {
        match self {
            Self::Microphone => 0,
            Self::System => 1,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct OpenAiAudioRange {
    pub(super) start_ms: u64,
    pub(super) end_ms: u64,
}

#[derive(Default)]
pub(super) struct OpenAiItemState {
    text: String,
    revision: u64,
    range: Option<OpenAiAudioRange>,
}

pub(super) struct OpenAiTranscriptState {
    channel: OpenAiChannel,
    session_start_ms: Option<u64>,
    latest_audio_end_ms: Option<u64>,
    active_speech: Option<(String, u64)>,
    pending_items: HashSet<String>,
    pending_ranges: VecDeque<OpenAiAudioRange>,
    buffered_range: Option<OpenAiAudioRange>,
    buffered_items: HashSet<String>,
    item_ranges: HashMap<String, OpenAiAudioRange>,
    last_bound_range: Option<OpenAiAudioRange>,
    items: HashMap<String, OpenAiItemState>,
    completed_items: HashSet<String>,
    provider_sequence: Arc<AtomicU64>,
}

#[derive(Default)]
pub(super) struct OpenAiEventEffect {
    pub(super) batches: Vec<NormalizedTranscriptBatch>,
}

impl OpenAiTranscriptState {
    pub(super) fn new(channel: OpenAiChannel, provider_sequence: Arc<AtomicU64>) -> Self {
        Self {
            channel,
            session_start_ms: None,
            latest_audio_end_ms: None,
            active_speech: None,
            pending_items: HashSet::new(),
            pending_ranges: VecDeque::new(),
            buffered_range: None,
            buffered_items: HashSet::new(),
            item_ranges: HashMap::new(),
            last_bound_range: None,
            items: HashMap::new(),
            completed_items: HashSet::new(),
            provider_sequence,
        }
    }

    pub(super) fn observe_audio(&mut self, range: OpenAiAudioRange) {
        self.session_start_ms.get_or_insert(range.start_ms);
        self.latest_audio_end_ms = Some(
            self.latest_audio_end_ms
                .map_or(range.end_ms, |end| end.max(range.end_ms)),
        );
        let merged = self
            .buffered_range
            .map_or(range, |buffered| OpenAiAudioRange {
                start_ms: buffered.start_ms.min(range.start_ms),
                end_ms: buffered.end_ms.max(range.end_ms),
            });
        self.buffered_range = Some(merged);
        if let Some((item_id, start_ms)) = &self.active_speech {
            let active = OpenAiAudioRange {
                start_ms: *start_ms,
                end_ms: range.end_ms.max(start_ms.saturating_add(1)),
            };
            self.item_ranges.insert(item_id.clone(), active);
            if let Some(item) = self.items.get_mut(item_id) {
                item.range = Some(active);
            }
        }
        for item_id in &self.buffered_items {
            self.item_ranges.insert(item_id.clone(), merged);
            if let Some(item) = self.items.get_mut(item_id) {
                item.range = Some(merged);
            }
        }
    }

    #[cfg(test)]
    pub(super) fn queue_commit(&mut self, range: OpenAiAudioRange) {
        for item_id in self.buffered_items.drain() {
            self.item_ranges.insert(item_id.clone(), range);
            if let Some(item) = self.items.get_mut(&item_id) {
                item.range = Some(range);
            }
        }
        self.buffered_range = None;
        self.pending_ranges.push_back(range);
    }

    pub(super) fn handle(
        &mut self,
        value: &serde_json::Value,
    ) -> Result<OpenAiEventEffect, String> {
        let event_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        match event_type {
            "input_audio_buffer.speech_started" => {
                let item_id = required_openai_string(value, "item_id")?;
                let relative_start_ms = required_openai_u64(value, "audio_start_ms")?;
                let start_ms = self.session_time(relative_start_ms)?;
                let end_ms = self
                    .latest_audio_end_ms
                    .unwrap_or_else(|| start_ms.saturating_add(1))
                    .max(start_ms.saturating_add(1));
                let range = OpenAiAudioRange { start_ms, end_ms };
                self.active_speech = Some((item_id.to_string(), start_ms));
                if !self.completed_items.contains(item_id) {
                    self.pending_items.insert(item_id.to_string());
                }
                self.item_ranges.insert(item_id.to_string(), range);
                self.last_bound_range = Some(range);
                Ok(OpenAiEventEffect::default())
            }
            "input_audio_buffer.speech_stopped" => {
                let item_id = required_openai_string(value, "item_id")?;
                let relative_end_ms = required_openai_u64(value, "audio_end_ms")?;
                let start_ms = self
                    .item_ranges
                    .get(item_id)
                    .map(|range| range.start_ms)
                    .or_else(|| {
                        self.active_speech
                            .as_ref()
                            .filter(|(active, _)| active == item_id)
                            .map(|(_, start_ms)| *start_ms)
                    })
                    .ok_or_else(|| {
                        "OpenAI stopped speech before reporting its start".to_string()
                    })?;
                let end_ms = self
                    .session_time(relative_end_ms)?
                    .max(start_ms.saturating_add(1));
                let range = OpenAiAudioRange { start_ms, end_ms };
                self.item_ranges.insert(item_id.to_string(), range);
                if let Some(item) = self.items.get_mut(item_id) {
                    item.range = Some(range);
                }
                if self
                    .active_speech
                    .as_ref()
                    .is_some_and(|(active, _)| active == item_id)
                {
                    self.active_speech = None;
                }
                if !self.completed_items.contains(item_id) {
                    self.pending_items.insert(item_id.to_string());
                }
                self.buffered_range = None;
                self.buffered_items.remove(item_id);
                self.last_bound_range = Some(range);
                Ok(OpenAiEventEffect::default())
            }
            "input_audio_buffer.committed" => {
                let item_id = required_openai_string(value, "item_id")?;
                if !self.completed_items.contains(item_id) {
                    self.pending_items.insert(item_id.to_string());
                }
                // OpenAI can begin emitting transcription deltas before its
                // committed acknowledgement reaches us. In that case
                // `range_for` has already bound the oldest queued range to
                // this item. The later acknowledgement is confirmation, not
                // permission to consume and overwrite the next turn's range.
                if let Some(current) = self.item_ranges.get(item_id).copied() {
                    if let Some(confirmed) = self
                        .pending_ranges
                        .pop_front_if(|pending| pending.start_ms == current.start_ms)
                    {
                        self.item_ranges.insert(item_id.to_string(), confirmed);
                        if let Some(item) = self.items.get_mut(item_id) {
                            item.range = Some(confirmed);
                        }
                        self.last_bound_range = Some(confirmed);
                    }
                } else {
                    let range = self
                        .pending_ranges
                        .pop_front()
                        .or(self.buffered_range)
                        .or(self.last_bound_range)
                        .ok_or_else(|| {
                            "OpenAI acknowledged audio before any timeline range existed"
                                .to_string()
                        })?;
                    self.item_ranges.insert(item_id.to_string(), range);
                    self.last_bound_range = Some(range);
                }
                Ok(OpenAiEventEffect::default())
            }
            "conversation.item.input_audio_transcription.delta" => {
                let item_id = required_openai_string(value, "item_id")?;
                let delta = required_openai_string(value, "delta")?;
                // OpenAI can emit framing-only whitespace before speech. It
                // is not a transcript segment; persisting it violates the
                // store contract and used to terminate an otherwise healthy
                // live worker after its first silent turn.
                if delta.trim().is_empty() || self.completed_items.contains(item_id) {
                    return Ok(OpenAiEventEffect::default());
                }
                self.pending_items.insert(item_id.to_string());
                let range = self.range_for(item_id)?;
                let item = self.items.entry(item_id.to_string()).or_default();
                item.text.push_str(delta);
                item.revision = item.revision.saturating_add(1);
                item.range = Some(range);
                let segment = openai_segment(
                    self.channel,
                    item_id,
                    item.revision,
                    SegmentState::Partial,
                    range,
                    &item.text,
                )?;
                Ok(OpenAiEventEffect {
                    batches: vec![self.batch(segment)?],
                })
            }
            "conversation.item.input_audio_transcription.completed" => {
                let item_id = required_openai_string(value, "item_id")?;
                if self.completed_items.contains(item_id) {
                    return Ok(OpenAiEventEffect::default());
                }
                let range = self.range_for(item_id)?;
                self.completed_items.insert(item_id.to_string());
                self.pending_items.remove(item_id);
                if self
                    .active_speech
                    .as_ref()
                    .is_some_and(|(active, _)| active == item_id)
                {
                    self.active_speech = None;
                }
                let completed = value
                    .get("transcript")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .trim();
                let item = self.items.entry(item_id.to_string()).or_default();
                if !completed.is_empty() {
                    item.text.clear();
                    item.text.push_str(completed);
                }
                item.revision = item.revision.saturating_add(1).max(1);
                item.range = Some(range);
                let revision = item.revision;
                let text = item.text.clone();
                let batches = if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![self.batch(openai_segment(
                        self.channel,
                        item_id,
                        revision,
                        SegmentState::Final,
                        range,
                        &text,
                    )?)?]
                };
                Ok(OpenAiEventEffect { batches })
            }
            "conversation.item.input_audio_transcription.failed" | "error" => {
                let code = value
                    .pointer("/error/code")
                    .or_else(|| value.pointer("/error/type"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("provider-error");
                Err(format!(
                    "OpenAI realtime transcription failed ({})",
                    actionable_openai_error_code(code)
                ))
            }
            _ => Ok(OpenAiEventEffect::default()),
        }
    }

    pub(super) fn session_time(&self, relative_ms: u64) -> Result<u64, String> {
        let start_ms = self.session_start_ms.ok_or_else(|| {
            "OpenAI reported voice activity before any audio was appended".to_string()
        })?;
        let timeline_ms = start_ms.saturating_add(relative_ms);
        Ok(self
            .latest_audio_end_ms
            .map_or(timeline_ms, |end_ms| timeline_ms.min(end_ms)))
    }

    pub(super) fn pending_turn_count(&self) -> usize {
        self.pending_items.len()
    }

    pub(super) fn has_active_speech(&self) -> bool {
        self.active_speech.is_some()
    }

    pub(super) fn range_for(&mut self, item_id: &str) -> Result<OpenAiAudioRange, String> {
        if let Some(range) = self.item_ranges.get(item_id).copied() {
            return Ok(range);
        }
        // A long-lived transcription session can emit a trailing item after
        // the committed turn's final event but before the next voice boundary
        // exists. It still belongs to the last confirmed audio window;
        // terminating the worker here made live transcription freeze at four
        // seconds while capture continued normally.
        let pending = self.pending_ranges.front().copied();
        let range = pending
            .or(self.buffered_range)
            .or(self.last_bound_range)
            .ok_or_else(|| {
                "OpenAI transcription arrived before any timeline range existed".to_string()
            })?;
        if pending.is_none() && self.buffered_range.is_some() {
            self.buffered_items.insert(item_id.to_string());
        }
        self.item_ranges.insert(item_id.to_string(), range);
        self.last_bound_range = Some(range);
        Ok(range)
    }

    pub(super) fn batch(
        &self,
        segment: NormalizedSegment,
    ) -> Result<NormalizedTranscriptBatch, String> {
        let sequence = self.provider_sequence.fetch_add(1, Ordering::Relaxed);
        Ok(NormalizedTranscriptBatch {
            provider_sequence: sequence,
            batch_id: WireId::new(format!("openai-{}-{sequence}", self.channel.id()))
                .map_err(|error| error.to_string())?,
            segments: vec![segment],
        })
    }
}

pub(super) fn required_openai_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("OpenAI realtime event omitted {field}"))
}

pub(super) fn required_openai_u64(value: &serde_json::Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("OpenAI realtime event omitted {field}"))
}

pub(super) fn openai_segment(
    channel: OpenAiChannel,
    item_id: &str,
    revision: u64,
    state: SegmentState,
    range: OpenAiAudioRange,
    text: &str,
) -> Result<NormalizedSegment, String> {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{}:{item_id}", channel.id()))
    );
    Ok(NormalizedSegment {
        segment_id: WireId::new(format!("oa-{}-{}", channel.id(), &digest[..24]))
            .map_err(|error| error.to_string())?,
        revision,
        state,
        start_ms: range.start_ms,
        end_ms: range.end_ms.max(range.start_ms.saturating_add(1)),
        text: text.to_string(),
        channel_id: Some(WireId::new(channel.id()).expect("static OpenAI channel id")),
        speaker: Some(channel.speaker().to_string()),
        language: None,
        confidence: None,
    })
}

pub(super) fn openai_pcm16_mono(
    interleaved_f32le: &[u8],
    channel: OpenAiChannel,
) -> Result<Vec<u8>, String> {
    let frame_bytes = BYTES_PER_SAMPLE * CHANNELS as usize;
    if interleaved_f32le.is_empty() || !interleaved_f32le.len().is_multiple_of(frame_bytes) {
        return Err("OpenAI audio frame is not aligned to stereo f32le samples".into());
    }
    let input_frames = interleaved_f32le.len() / frame_bytes;
    let output_frames = input_frames
        .checked_mul(OPENAI_SAMPLE_RATE_HZ as usize)
        .ok_or_else(|| "OpenAI audio resample length overflow".to_string())?
        / SAMPLE_RATE_HZ as usize;
    let mut input = Vec::with_capacity(input_frames);
    for frame in interleaved_f32le.chunks_exact(frame_bytes) {
        let offset = channel.interleaved_index() * BYTES_PER_SAMPLE;
        let sample = f32::from_le_bytes(
            frame[offset..offset + BYTES_PER_SAMPLE]
                .try_into()
                .expect("validated f32 sample width"),
        );
        input.push(if sample.is_finite() { sample } else { 0.0 });
    }
    let mut output = Vec::with_capacity(output_frames * size_of::<i16>());
    for target_index in 0..output_frames {
        let numerator = target_index * SAMPLE_RATE_HZ as usize;
        let left = numerator / OPENAI_SAMPLE_RATE_HZ as usize;
        let remainder = numerator % OPENAI_SAMPLE_RATE_HZ as usize;
        let right = (left + 1).min(input.len().saturating_sub(1));
        let fraction = remainder as f32 / OPENAI_SAMPLE_RATE_HZ as f32;
        let sample = input[left] + (input[right] - input[left]) * fraction;
        let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        output.extend_from_slice(&pcm.to_le_bytes());
    }
    Ok(output)
}
