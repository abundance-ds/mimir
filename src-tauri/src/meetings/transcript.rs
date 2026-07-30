//! Provider-neutral live transcript normalization.
//!
//! The partial/final separation, per-channel state, replacement semantics, and
//! bounded replay behavior are adapted from fastrepl/anarlog's MIT-licensed
//! `crates/transcript` at commit
//! `08aad83f0c5cef1317d74a31519ae3190d726504`. Mimir owns this implementation
//! and its stable-id/revision contract; see `src-tauri/vendor/anarlog`.

use super::{TranscriptBatch, TranscriptChange, TranscriptSegmentInput};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use thiserror::Error;

const MAX_EVENT_ID_BYTES: usize = 256;
const MAX_UTTERANCE_ID_BYTES: usize = 256;
const MAX_CHANNEL_ID_BYTES: usize = 160;
const MAX_FRAME_TEXT_BYTES: usize = 256 * 1024;
const MAX_REMEMBERED_EVENTS: usize = 8_192;
const MAX_LIVE_PARTIALS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTranscriptFrame {
    pub event_id: String,
    pub utterance_id: String,
    pub sequence: u64,
    pub channel_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default)]
    pub is_final: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptNormalization {
    pub batch: Option<TranscriptBatch>,
    pub partials: Vec<TranscriptSegmentInput>,
    pub duplicate: bool,
    pub stale: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TranscriptNormalizerError {
    #[error("invalid provider transcript frame: {0}")]
    Invalid(String),
    #[error(
        "provider event id '{event_id}' was replayed with different content in run '{provider_run_id}'"
    )]
    ConflictingReplay {
        provider_run_id: String,
        event_id: String,
    },
    #[error("too many live partial utterances")]
    TooManyPartials,
}

#[derive(Debug, Clone)]
struct EventFingerprint {
    hash: String,
}

#[derive(Debug, Clone)]
struct UtteranceState {
    sequence: u64,
    final_seen: bool,
}

pub struct TranscriptNormalizer {
    meeting_id: String,
    provider_run_id: String,
    source: String,
    events: HashMap<String, EventFingerprint>,
    event_order: VecDeque<String>,
    utterances: HashMap<(String, String), UtteranceState>,
    partials: BTreeMap<(String, String), TranscriptSegmentInput>,
}

impl TranscriptNormalizer {
    pub fn new(
        meeting_id: impl Into<String>,
        provider_run_id: impl Into<String>,
        source: impl Into<String>,
    ) -> Result<Self, TranscriptNormalizerError> {
        let meeting_id = meeting_id.into();
        let provider_run_id = provider_run_id.into();
        let source = source.into();
        validate_identifier(&meeting_id, "meeting id", MAX_CHANNEL_ID_BYTES)?;
        validate_identifier(&provider_run_id, "provider run id", MAX_CHANNEL_ID_BYTES)?;
        validate_identifier(&source, "transcript source", MAX_CHANNEL_ID_BYTES)?;
        Ok(Self {
            meeting_id,
            provider_run_id,
            source,
            events: HashMap::new(),
            event_order: VecDeque::new(),
            utterances: HashMap::new(),
            partials: BTreeMap::new(),
        })
    }

    pub fn apply(
        &mut self,
        frame: ProviderTranscriptFrame,
        base_revision: u64,
        observed_at: &str,
    ) -> Result<TranscriptNormalization, TranscriptNormalizerError> {
        validate_frame(&frame)?;
        let fingerprint = frame_fingerprint(&frame);
        if let Some(previous) = self.events.get(&frame.event_id) {
            if previous.hash != fingerprint {
                return Err(TranscriptNormalizerError::ConflictingReplay {
                    provider_run_id: self.provider_run_id.clone(),
                    event_id: frame.event_id,
                });
            }
            return Ok(self.outcome(None, true, false));
        }
        self.remember_event(&frame.event_id, fingerprint);

        let utterance_key = (frame.channel_id.clone(), frame.utterance_id.clone());
        let previous = self.utterances.get(&utterance_key);
        if previous.is_some_and(|value| value.sequence >= frame.sequence) {
            return Ok(self.outcome(None, false, true));
        }
        if previous.is_some_and(|value| value.final_seen && !frame.is_final) {
            return Ok(self.outcome(None, false, true));
        }

        let segment = segment_from_frame(&self.provider_run_id, &frame);
        self.utterances.insert(
            utterance_key.clone(),
            UtteranceState {
                sequence: frame.sequence,
                final_seen: frame.is_final,
            },
        );

        if !frame.is_final {
            if !self.partials.contains_key(&utterance_key)
                && self.partials.len() >= MAX_LIVE_PARTIALS
            {
                return Err(TranscriptNormalizerError::TooManyPartials);
            }
            self.partials.insert(utterance_key, segment);
            return Ok(self.outcome(None, false, false));
        }

        self.partials.remove(&utterance_key);
        let batch = TranscriptBatch {
            meeting_id: self.meeting_id.clone(),
            batch_id: format!("{}:{}", self.provider_run_id, frame.event_id),
            base_revision,
            source: self.source.clone(),
            observed_at: observed_at.into(),
            marks_final: false,
            changes: vec![TranscriptChange::UpsertSegment { segment }],
        };
        Ok(self.outcome(Some(batch), false, false))
    }

    pub fn finish(&mut self, base_revision: u64, observed_at: &str) -> TranscriptNormalization {
        // Partials are UI projections, not durable speech. Providers that want
        // to preserve words at end-of-stream must emit a final frame.
        self.partials.clear();
        TranscriptNormalization {
            batch: Some(TranscriptBatch {
                meeting_id: self.meeting_id.clone(),
                batch_id: format!("{}:terminal:{base_revision}", self.provider_run_id),
                base_revision,
                source: self.source.clone(),
                observed_at: observed_at.into(),
                marks_final: true,
                changes: Vec::new(),
            }),
            partials: Vec::new(),
            duplicate: false,
            stale: false,
        }
    }

    pub fn partials(&self) -> Vec<TranscriptSegmentInput> {
        self.partials.values().cloned().collect()
    }

    fn outcome(
        &self,
        batch: Option<TranscriptBatch>,
        duplicate: bool,
        stale: bool,
    ) -> TranscriptNormalization {
        TranscriptNormalization {
            batch,
            partials: self.partials(),
            duplicate,
            stale,
        }
    }

    fn remember_event(&mut self, event_id: &str, hash: String) {
        self.events
            .insert(event_id.into(), EventFingerprint { hash });
        self.event_order.push_back(event_id.into());
        while self.event_order.len() > MAX_REMEMBERED_EVENTS {
            if let Some(expired) = self.event_order.pop_front() {
                self.events.remove(&expired);
            }
        }
    }
}

fn segment_from_frame(
    provider_run_id: &str,
    frame: &ProviderTranscriptFrame,
) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        id: stable_segment_id(provider_run_id, &frame.channel_id, &frame.utterance_id),
        start_ms: frame.start_ms,
        end_ms: frame.end_ms,
        text: frame.text.clone(),
        channel_id: Some(frame.channel_id.clone()),
        speaker: frame.speaker.clone(),
        confidence: frame.confidence,
        is_final: frame.is_final,
        metadata: frame.metadata.clone(),
    }
}

fn stable_segment_id(provider_run_id: &str, channel_id: &str, utterance_id: &str) -> String {
    let mut hasher = Sha256::new();
    for value in [provider_run_id, channel_id, utterance_id] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("segment:{:x}", hasher.finalize())
}

fn validate_frame(frame: &ProviderTranscriptFrame) -> Result<(), TranscriptNormalizerError> {
    validate_identifier(&frame.event_id, "event id", MAX_EVENT_ID_BYTES)?;
    validate_identifier(&frame.utterance_id, "utterance id", MAX_UTTERANCE_ID_BYTES)?;
    validate_identifier(&frame.channel_id, "channel id", MAX_CHANNEL_ID_BYTES)?;
    if frame.end_ms < frame.start_ms || frame.start_ms < 0 {
        return Err(TranscriptNormalizerError::Invalid(
            "audio timestamps must be ordered and non-negative".into(),
        ));
    }
    if frame.text.len() > MAX_FRAME_TEXT_BYTES {
        return Err(TranscriptNormalizerError::Invalid(format!(
            "frame text exceeds {MAX_FRAME_TEXT_BYTES} bytes"
        )));
    }
    if frame.text.trim().is_empty() {
        return Err(TranscriptNormalizerError::Invalid(
            "frame text must not be empty".into(),
        ));
    }
    if frame
        .confidence
        .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err(TranscriptNormalizerError::Invalid(
            "confidence must be between zero and one".into(),
        ));
    }
    let metadata_size = serde_json::to_vec(&frame.metadata)
        .map_err(|error| TranscriptNormalizerError::Invalid(error.to_string()))?
        .len();
    if metadata_size > 64 * 1024 {
        return Err(TranscriptNormalizerError::Invalid(
            "frame metadata exceeds 65536 bytes".into(),
        ));
    }
    Ok(())
}

fn validate_identifier(
    value: &str,
    label: &str,
    maximum: usize,
) -> Result<(), TranscriptNormalizerError> {
    if value.is_empty() || value.len() > maximum {
        return Err(TranscriptNormalizerError::Invalid(format!(
            "{label} must contain 1 to {maximum} bytes"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(TranscriptNormalizerError::Invalid(format!(
            "{label} must not contain control characters"
        )));
    }
    Ok(())
}

fn frame_fingerprint(frame: &ProviderTranscriptFrame) -> String {
    let encoded = serde_json::to_vec(frame).expect("serializable provider frame");
    format!("{:x}", Sha256::digest(encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(
        event_id: &str,
        utterance_id: &str,
        sequence: u64,
        text: &str,
        is_final: bool,
    ) -> ProviderTranscriptFrame {
        ProviderTranscriptFrame {
            event_id: event_id.into(),
            utterance_id: utterance_id.into(),
            sequence,
            channel_id: "microphone".into(),
            start_ms: 100,
            end_ms: 500,
            text: text.into(),
            is_final,
            speaker: Some("You".into()),
            confidence: Some(0.9),
            metadata: Value::Null,
        }
    }

    #[test]
    fn gherkin_partials_are_ephemeral_and_final_words_become_one_revisioned_batch() {
        let mut normalizer =
            TranscriptNormalizer::new("meeting-1", "provider-run-1", "local").unwrap();
        let partial = normalizer
            .apply(
                frame("e1", "u1", 1, "hel", false),
                0,
                "2026-07-30T12:00:00Z",
            )
            .unwrap();
        assert!(partial.batch.is_none());
        assert_eq!(partial.partials[0].text, "hel");

        let final_result = normalizer
            .apply(
                frame("e2", "u1", 2, "hello", true),
                0,
                "2026-07-30T12:00:01Z",
            )
            .unwrap();
        assert!(final_result.partials.is_empty());
        let batch = final_result.batch.unwrap();
        assert_eq!(batch.base_revision, 0);
        let TranscriptChange::UpsertSegment { segment } = &batch.changes[0] else {
            panic!("expected one segment upsert");
        };
        assert_eq!(segment.text, "hello");
        assert!(segment.is_final);
    }

    #[test]
    fn gherkin_duplicate_provider_delivery_is_idempotent_and_conflicts_are_rejected() {
        let mut normalizer =
            TranscriptNormalizer::new("meeting-1", "provider-run-1", "custom").unwrap();
        let first = frame("e1", "u1", 1, "hello", true);
        normalizer
            .apply(first.clone(), 0, "2026-07-30T12:00:00Z")
            .unwrap();
        let duplicate = normalizer.apply(first, 1, "2026-07-30T12:00:01Z").unwrap();
        assert!(duplicate.duplicate);
        assert!(duplicate.batch.is_none());

        let error = normalizer
            .apply(
                frame("e1", "u1", 2, "different", true),
                1,
                "2026-07-30T12:00:02Z",
            )
            .unwrap_err();
        assert!(matches!(
            error,
            TranscriptNormalizerError::ConflictingReplay { .. }
        ));
    }

    #[test]
    fn gherkin_out_of_order_partial_cannot_rewrite_a_final_utterance() {
        let mut normalizer =
            TranscriptNormalizer::new("meeting-1", "provider-run-1", "local").unwrap();
        let finalized = normalizer
            .apply(
                frame("e2", "u1", 2, "hello", true),
                0,
                "2026-07-30T12:00:00Z",
            )
            .unwrap();
        let TranscriptChange::UpsertSegment {
            segment: final_segment,
        } = &finalized.batch.unwrap().changes[0]
        else {
            panic!("expected final segment");
        };

        let stale = normalizer
            .apply(
                frame("e1", "u1", 1, "hel", false),
                1,
                "2026-07-30T12:00:01Z",
            )
            .unwrap();
        assert!(stale.stale);
        assert!(stale.partials.is_empty());

        let corrected = normalizer
            .apply(
                frame("e3", "u1", 3, "hello there", true),
                1,
                "2026-07-30T12:00:02Z",
            )
            .unwrap();
        let TranscriptChange::UpsertSegment {
            segment: corrected_segment,
        } = &corrected.batch.unwrap().changes[0]
        else {
            panic!("expected correction");
        };
        assert_eq!(final_segment.id, corrected_segment.id);
        assert_eq!(corrected_segment.text, "hello there");
    }

    #[test]
    fn gherkin_session_end_discards_unconfirmed_partials_and_marks_revision_terminal() {
        let mut normalizer =
            TranscriptNormalizer::new("meeting-1", "provider-run-1", "local").unwrap();
        normalizer
            .apply(
                frame("e1", "u1", 1, "maybe", false),
                4,
                "2026-07-30T12:00:00Z",
            )
            .unwrap();
        let terminal = normalizer.finish(4, "2026-07-30T12:00:01Z");
        assert!(terminal.partials.is_empty());
        let batch = terminal.batch.unwrap();
        assert!(batch.marks_final);
        assert!(batch.changes.is_empty());
        assert_eq!(batch.base_revision, 4);
    }

    #[test]
    fn gherkin_invalid_and_oversized_provider_frames_fail_before_state_changes() {
        let mut normalizer =
            TranscriptNormalizer::new("meeting-1", "provider-run-1", "custom").unwrap();
        let mut invalid = frame("e1", "u1", 1, "hello", false);
        invalid.end_ms = 99;
        assert!(matches!(
            normalizer.apply(invalid, 0, "2026-07-30T12:00:00Z"),
            Err(TranscriptNormalizerError::Invalid(_))
        ));
        assert!(normalizer.partials().is_empty());
    }
}
