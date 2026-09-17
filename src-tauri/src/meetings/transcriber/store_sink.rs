use super::*;

pub(super) struct StoreBatchSink {
    store: Arc<MeetingStore>,
    diagnostics: ScribeDiagnostics,
    meeting_id: String,
    provider_run_id: String,
    source: String,
    repair_generation: Option<String>,
    pub(super) accumulator: TranscriptAccumulator,
    final_segment_count: u64,
    changes: Arc<dyn TranscriptionChangeSink>,
}

impl StoreBatchSink {
    pub(super) fn new(
        store: Arc<MeetingStore>,
        diagnostics: ScribeDiagnostics,
        meeting_id: &str,
        provider_run_id: &str,
        source: &str,
        repair_generation: Option<&str>,
        changes: Arc<dyn TranscriptionChangeSink>,
    ) -> Result<Self, String> {
        WireId::new(meeting_id.to_string()).map_err(|error| error.to_string())?;
        WireId::new(provider_run_id.to_string()).map_err(|error| error.to_string())?;
        Ok(Self {
            store,
            diagnostics,
            meeting_id: meeting_id.into(),
            provider_run_id: provider_run_id.into(),
            source: source.into(),
            repair_generation: repair_generation.map(str::to_string),
            accumulator: TranscriptAccumulator::default(),
            final_segment_count: 0,
            changes,
        })
    }
}

impl NormalizedBatchSink for StoreBatchSink {
    fn ingest(&mut self, mut batch: NormalizedTranscriptBatch) -> Result<(), String> {
        let received_finals = batch
            .segments
            .iter()
            .filter(|segment| segment.state == SegmentState::Final)
            .count();
        if received_finals > 0 {
            self.diagnostics.record(
                "transcription.final.received",
                json!({
                    "providerSequence": batch.provider_sequence,
                    "finalSegments": received_finals,
                }),
            );
        }
        // Provider adapters should already suppress framing-only output, but
        // the durable boundary is the final defense. One empty partial must
        // never turn a healthy audio/provider session into a failed meeting.
        batch
            .segments
            .retain(|segment| !segment.text.trim().is_empty());
        if batch.segments.is_empty() {
            return Ok(());
        }
        for segment in &batch.segments {
            if segment.state != SegmentState::Final {
                continue;
            }
            let channel_id = segment.channel_id.as_ref().ok_or_else(|| {
                "provider final segment omitted the required audio channel identifier".to_string()
            })?;
            if !matches!(channel_id.as_str(), "microphone" | "system") {
                return Err(
                    "provider final segment used an unknown audio channel identifier".into(),
                );
            }
        }
        let provider_sequence = batch.provider_sequence;
        // Apply to a candidate state. Provider normalization and durable store
        // persistence commit together; a failed SQLite write must remain
        // replayable on reconnect.
        let mut candidate = self.accumulator.clone();
        let report = candidate.apply(batch).map_err(|error| {
            let error = error.to_string();
            self.diagnostics.record(
                "transcription.batch.rejected",
                json!({ "stage": "accumulator", "error": error }),
            );
            error
        })?;
        if report.duplicate_batch {
            return Ok(());
        }
        let mut changes = Vec::new();
        let mut accepted_finals = 0_u64;
        for segment_id in report.accepted_segment_ids {
            let accepted = candidate
                .segments()
                .get(&segment_id)
                .ok_or_else(|| "accepted provider segment disappeared".to_string())?;
            let segment = &accepted.value;
            let channel_id = segment.channel_id.as_ref().ok_or_else(|| {
                "provider final segment omitted the required audio channel identifier".to_string()
            })?;
            if !matches!(channel_id.as_str(), "microphone" | "system") {
                return Err(
                    "provider final segment used an unknown audio channel identifier".into(),
                );
            }
            let start_ms = i64::try_from(segment.start_ms)
                .map_err(|_| "provider segment start exceeds durable range".to_string())?;
            let end_ms = i64::try_from(segment.end_ms)
                .map_err(|_| "provider segment end exceeds durable range".to_string())?;
            changes.push(TranscriptChange::UpsertSegment {
                segment: TranscriptSegmentInput {
                    id: stable_durable_id(
                        "segment",
                        &[&self.provider_run_id, segment.segment_id.as_str()],
                    ),
                    start_ms,
                    end_ms,
                    text: segment.text.clone(),
                    channel_id: Some(channel_id.to_string()),
                    speaker: segment.speaker.clone(),
                    confidence: segment.confidence.map(f64::from),
                    is_final: segment.state == SegmentState::Final,
                    metadata: json!({
                        "owner": "stt",
                        "providerRunId": self.provider_run_id,
                        "providerSequence": accepted.provider_sequence,
                        "providerRevision": segment.revision,
                        "language": segment.language,
                    }),
                },
            });
            if segment.state == SegmentState::Final {
                accepted_finals = accepted_finals.saturating_add(1);
            }
        }
        if changes.is_empty() {
            self.accumulator = candidate;
            return Ok(());
        }
        let meeting = self
            .store
            .get_meeting(&self.meeting_id)
            .map_err(|error| error.to_string())?;
        let durable = TranscriptBatch {
            meeting_id: self.meeting_id.clone(),
            batch_id: format!(
                "{}:{}",
                sanitize_wire_component(&self.provider_run_id),
                provider_sequence
            ),
            base_revision: meeting.transcript_revision,
            source: self.source.clone(),
            observed_at: now(),
            marks_final: false,
            changes,
        };
        if let Some(capture_generation) = self.repair_generation.as_deref() {
            self.store
                .stage_transcript_repair_batch(capture_generation, &self.provider_run_id, &durable)
                .map_err(|error| error.to_string())?;
        } else {
            self.store
                .append_provider_transcript_batch(&durable)
                .map_err(|error| {
                    let error = error.to_string();
                    self.diagnostics.record(
                        "transcription.batch.rejected",
                        json!({
                            "stage": "durable-store",
                            "providerSequence": provider_sequence,
                            "error": error,
                        }),
                    );
                    error
                })?;
            self.changes.changed(&self.meeting_id);
        }
        if accepted_finals > 0 {
            self.diagnostics.record(
                "transcription.final.persisted",
                json!({
                    "providerSequence": provider_sequence,
                    "acceptedFinalSegments": accepted_finals,
                }),
            );
        }
        self.accumulator = candidate;
        self.final_segment_count = self.final_segment_count.saturating_add(accepted_finals);
        Ok(())
    }

    fn final_segment_count(&self) -> u64 {
        self.final_segment_count
    }
}
