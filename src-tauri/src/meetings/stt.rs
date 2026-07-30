//! Provider-neutral speech-to-text contracts.
//!
//! Custom endpoints speak one stable WebSocket subprotocol:
//! `mimir.stt.v1`. JSON text frames are represented by [`ClientMessage`] and
//! [`ServerMessage`]; binary audio never appears in diagnostics or JSON. After
//! a successful `start`/`ready` exchange, each binary frame corresponds to the
//! immediately preceding [`ClientMessage::Audio`] metadata frame. Transcript
//! providers emit normalized, revisioned partial/final batches.
//!
//! Capability negotiation is fail-closed. The caller must run
//! [`SttCapabilities::preflight`] before sending audio. A mismatch never chooses
//! a different provider. Reconnects likewise remain on the selected provider;
//! once the bounded budget is exhausted, the only modeled recovery is a
//! durable delayed-repair job.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt,
};
use thiserror::Error;

pub const STT_WIRE_CONTRACT: &str = "mimir.stt.v1";
pub const STT_WIRE_VERSION: u16 = 1;
pub const MAX_NORMALIZED_BATCH_SEGMENTS: usize = 1_024;
pub const MAX_SEGMENT_TEXT_BYTES: usize = 1_048_576;
pub const MAX_WIRE_ID_BYTES: usize = 160;
pub const MAX_DEDUP_BATCHES: usize = 4_096;
pub const MAX_REPLAY_DURATION_MS: u64 = 30_000;
pub const MAX_REPLAY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_REPLAY_CHUNKS: usize = 512;
pub const MAX_RECONNECT_ATTEMPTS: u8 = 8;
pub const MAX_RECONNECT_DELAY_MS: u64 = 30_000;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WireId(String);

impl WireId {
    pub fn new(value: impl Into<String>) -> Result<Self, NormalizeError> {
        let value = value.into();
        validate_wire_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for WireId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("WireId").field(&self.0).finish()
    }
}

impl fmt::Display for WireId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for WireId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for WireId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

fn validate_wire_id(value: &str) -> Result<(), NormalizeError> {
    if value.is_empty() || value.len() > MAX_WIRE_ID_BYTES {
        return Err(NormalizeError::InvalidIdentifier);
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(NormalizeError::InvalidIdentifier);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptionOperation {
    Live,
    BatchRepair,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioEncoding {
    PcmS16Le,
    PcmF32Le,
    Flac,
    Opus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum LanguageCapability {
    Any,
    Explicit { tags: BTreeSet<String> },
}

impl LanguageCapability {
    fn validate(&self) -> Result<(), CapabilityContractError> {
        if let Self::Explicit { tags } = self {
            if tags.is_empty() || tags.iter().any(|tag| !is_valid_language_tag(tag)) {
                return Err(CapabilityContractError::InvalidLanguages);
            }
        }
        Ok(())
    }

    fn supports(&self, requested: Option<&str>) -> bool {
        let Some(requested) = requested else {
            return true;
        };
        match self {
            Self::Any => is_valid_language_tag(requested),
            Self::Explicit { tags } => tags.iter().any(|tag| tag.eq_ignore_ascii_case(requested)),
        }
    }
}

fn is_valid_language_tag(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 35 {
        return false;
    }
    let parts = tag.split('-').collect::<Vec<_>>();
    !parts.is_empty()
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 8
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        && parts[0].len() >= 2
        && parts[0].bytes().all(|byte| byte.is_ascii_alphabetic())
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CapabilityContractError {
    #[error("STT contract version is unsupported")]
    UnsupportedContract,
    #[error("STT provider must advertise at least one operation")]
    MissingOperations,
    #[error("STT provider must advertise at least one audio encoding")]
    MissingEncodings,
    #[error("STT provider must advertise valid sample rates")]
    InvalidSampleRates,
    #[error("STT provider channel limit is outside supported bounds")]
    InvalidChannelLimit,
    #[error("STT provider frame-size limit is outside supported bounds")]
    InvalidFrameLimit,
    #[error("STT provider language capability is invalid")]
    InvalidLanguages,
}

/// Provider-advertised behavior used for preflight before any audio leaves the
/// capture pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SttCapabilities {
    pub contract_version: u16,
    pub operations: BTreeSet<TranscriptionOperation>,
    pub encodings: BTreeSet<AudioEncoding>,
    pub sample_rates_hz: BTreeSet<u32>,
    pub max_channels: u8,
    pub max_audio_frame_bytes: u32,
    pub supports_partial_results: bool,
    pub supports_speaker_labels: bool,
    pub languages: LanguageCapability,
}

impl SttCapabilities {
    pub fn validate(&self) -> Result<(), CapabilityContractError> {
        if self.contract_version != STT_WIRE_VERSION {
            return Err(CapabilityContractError::UnsupportedContract);
        }
        if self.operations.is_empty() {
            return Err(CapabilityContractError::MissingOperations);
        }
        if self.encodings.is_empty() {
            return Err(CapabilityContractError::MissingEncodings);
        }
        if self.sample_rates_hz.is_empty()
            || self
                .sample_rates_hz
                .iter()
                .any(|rate| !(8_000..=384_000).contains(rate))
        {
            return Err(CapabilityContractError::InvalidSampleRates);
        }
        if self.max_channels == 0 || self.max_channels > 32 {
            return Err(CapabilityContractError::InvalidChannelLimit);
        }
        if !(1_024..=16_777_216).contains(&self.max_audio_frame_bytes) {
            return Err(CapabilityContractError::InvalidFrameLimit);
        }
        self.languages.validate()
    }

    pub fn preflight(&self, request: &SttPreflightRequest) -> Result<(), PreflightFailure> {
        let mut mismatches = Vec::new();
        if let Err(error) = self.validate() {
            mismatches.push(CapabilityMismatch::InvalidProviderContract {
                reason: error.to_string(),
            });
            return Err(PreflightFailure { mismatches });
        }
        if !self.operations.contains(&request.operation) {
            mismatches.push(CapabilityMismatch::Operation {
                requested: request.operation,
            });
        }
        if !self.encodings.contains(&request.encoding) {
            mismatches.push(CapabilityMismatch::Encoding {
                requested: request.encoding,
            });
        }
        if !self.sample_rates_hz.contains(&request.sample_rate_hz) {
            mismatches.push(CapabilityMismatch::SampleRate {
                requested_hz: request.sample_rate_hz,
            });
        }
        if request.channels == 0 || request.channels > self.max_channels {
            mismatches.push(CapabilityMismatch::Channels {
                requested: request.channels,
                maximum: self.max_channels,
            });
        }
        if request.audio_frame_bytes == 0 || request.audio_frame_bytes > self.max_audio_frame_bytes
        {
            mismatches.push(CapabilityMismatch::AudioFrameBytes {
                requested: request.audio_frame_bytes,
                maximum: self.max_audio_frame_bytes,
            });
        }
        if request.partial_results && !self.supports_partial_results {
            mismatches.push(CapabilityMismatch::PartialResults);
        }
        if request.speaker_labels && !self.supports_speaker_labels {
            mismatches.push(CapabilityMismatch::SpeakerLabels);
        }
        if request
            .language
            .as_deref()
            .is_some_and(|language| !is_valid_language_tag(language))
            || !self.languages.supports(request.language.as_deref())
        {
            mismatches.push(CapabilityMismatch::Language {
                requested: request.language.clone(),
            });
        }
        if mismatches.is_empty() {
            Ok(())
        } else {
            Err(PreflightFailure { mismatches })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SttPreflightRequest {
    pub operation: TranscriptionOperation,
    pub encoding: AudioEncoding,
    pub sample_rate_hz: u32,
    pub channels: u8,
    pub audio_frame_bytes: u32,
    pub partial_results: bool,
    pub speaker_labels: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "capability",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CapabilityMismatch {
    InvalidProviderContract { reason: String },
    Operation { requested: TranscriptionOperation },
    Encoding { requested: AudioEncoding },
    SampleRate { requested_hz: u32 },
    Channels { requested: u8, maximum: u8 },
    AudioFrameBytes { requested: u32, maximum: u32 },
    PartialResults,
    SpeakerLabels,
    Language { requested: Option<String> },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("selected STT provider cannot satisfy {count} requested capability/capabilities", count = .mismatches.len())]
pub struct PreflightFailure {
    pub mismatches: Vec<CapabilityMismatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentState {
    Partial,
    Final,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedSegment {
    pub segment_id: WireId,
    pub revision: u64,
    pub state: SegmentState,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<WireId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

impl fmt::Debug for NormalizedSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NormalizedSegment")
            .field("segment_id", &self.segment_id)
            .field("revision", &self.revision)
            .field("state", &self.state)
            .field("start_ms", &self.start_ms)
            .field("end_ms", &self.end_ms)
            .field("text", &format_args!("[{} bytes]", self.text.len()))
            .field("channel_id", &self.channel_id)
            .field("speaker_present", &self.speaker.is_some())
            .field("language", &self.language)
            .field("confidence", &self.confidence)
            .finish()
    }
}

impl NormalizedSegment {
    pub fn validate(&self) -> Result<(), NormalizeError> {
        validate_wire_id(self.segment_id.as_str())?;
        if self.start_ms >= self.end_ms {
            return Err(NormalizeError::InvalidTimeRange);
        }
        if self.text.trim().is_empty() || self.text.len() > MAX_SEGMENT_TEXT_BYTES {
            return Err(NormalizeError::InvalidText);
        }
        if self
            .speaker
            .as_ref()
            .is_some_and(|speaker| speaker.is_empty() || speaker.len() > 256)
        {
            return Err(NormalizeError::InvalidSpeaker);
        }
        if self
            .language
            .as_deref()
            .is_some_and(|language| !is_valid_language_tag(language))
        {
            return Err(NormalizeError::InvalidLanguage);
        }
        if self
            .confidence
            .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
        {
            return Err(NormalizeError::InvalidConfidence);
        }
        Ok(())
    }

    fn same_provenance(&self, other: &Self) -> bool {
        self.start_ms == other.start_ms
            && self.end_ms == other.end_ms
            && self.channel_id == other.channel_id
    }

    fn same_payload(&self, other: &Self) -> bool {
        self.same_provenance(other)
            && self.text == other.text
            && self.speaker == other.speaker
            && self.language == other.language
            && self.confidence == other.confidence
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedTranscriptBatch {
    pub provider_sequence: u64,
    pub batch_id: WireId,
    pub segments: Vec<NormalizedSegment>,
}

impl NormalizedTranscriptBatch {
    pub fn validate(&self) -> Result<(), NormalizeError> {
        validate_wire_id(self.batch_id.as_str())?;
        if self.segments.is_empty() || self.segments.len() > MAX_NORMALIZED_BATCH_SEGMENTS {
            return Err(NormalizeError::InvalidBatchSize);
        }
        let mut ids = BTreeSet::new();
        for segment in &self.segments {
            segment.validate()?;
            if !ids.insert(segment.segment_id.clone()) {
                return Err(NormalizeError::DuplicateSegmentInBatch);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum NormalizeError {
    #[error("wire identifier is invalid")]
    InvalidIdentifier,
    #[error("normalized batch size is outside supported bounds")]
    InvalidBatchSize,
    #[error("normalized batch contains a segment more than once")]
    DuplicateSegmentInBatch,
    #[error("transcript segment time range is invalid")]
    InvalidTimeRange,
    #[error("transcript segment text is empty or too large")]
    InvalidText,
    #[error("transcript segment speaker label is invalid")]
    InvalidSpeaker,
    #[error("transcript segment language is invalid")]
    InvalidLanguage,
    #[error("transcript segment confidence is invalid")]
    InvalidConfidence,
    #[error("provider changed the audio-time provenance of a segment")]
    ProvenanceConflict,
    #[error("provider reused a segment revision with different content")]
    RevisionConflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyReport {
    pub accepted_segment_ids: Vec<WireId>,
    pub ignored_stale_segment_ids: Vec<WireId>,
    pub duplicate_batch: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedSegment {
    pub value: NormalizedSegment,
    pub provider_sequence: u64,
}

/// Idempotent projection of provider batches. Batches may arrive out of order;
/// revision and finality are evaluated per segment rather than by a single
/// global sequence watermark.
#[derive(Debug, Clone)]
pub struct TranscriptAccumulator {
    segments: BTreeMap<WireId, AcceptedSegment>,
    seen_batches: BTreeSet<(u64, WireId)>,
    seen_order: VecDeque<(u64, WireId)>,
    max_seen_batches: usize,
}

impl Default for TranscriptAccumulator {
    fn default() -> Self {
        Self::new(MAX_DEDUP_BATCHES)
    }
}

impl TranscriptAccumulator {
    pub fn new(max_seen_batches: usize) -> Self {
        Self {
            segments: BTreeMap::new(),
            seen_batches: BTreeSet::new(),
            seen_order: VecDeque::new(),
            max_seen_batches: max_seen_batches.clamp(1, MAX_DEDUP_BATCHES),
        }
    }

    pub fn segments(&self) -> &BTreeMap<WireId, AcceptedSegment> {
        &self.segments
    }

    pub fn apply(
        &mut self,
        batch: NormalizedTranscriptBatch,
    ) -> Result<ApplyReport, NormalizeError> {
        batch.validate()?;
        let batch_key = (batch.provider_sequence, batch.batch_id.clone());
        if self.seen_batches.contains(&batch_key) {
            return Ok(ApplyReport {
                accepted_segment_ids: Vec::new(),
                ignored_stale_segment_ids: Vec::new(),
                duplicate_batch: true,
            });
        }

        enum Action {
            Accept(NormalizedSegment),
            Ignore(WireId),
        }
        let mut actions = Vec::with_capacity(batch.segments.len());
        for incoming in batch.segments {
            let Some(existing) = self.segments.get(&incoming.segment_id) else {
                actions.push(Action::Accept(incoming));
                continue;
            };
            if !incoming.same_provenance(&existing.value) {
                return Err(NormalizeError::ProvenanceConflict);
            }
            if existing.value.state == SegmentState::Final {
                actions.push(Action::Ignore(incoming.segment_id));
                continue;
            }
            if incoming.revision < existing.value.revision {
                actions.push(Action::Ignore(incoming.segment_id));
                continue;
            }
            if incoming.revision == existing.value.revision {
                if !incoming.same_payload(&existing.value) {
                    return Err(NormalizeError::RevisionConflict);
                }
                if incoming.state == SegmentState::Final
                    && existing.value.state == SegmentState::Partial
                {
                    actions.push(Action::Accept(incoming));
                } else {
                    actions.push(Action::Ignore(incoming.segment_id));
                }
                continue;
            }
            actions.push(Action::Accept(incoming));
        }

        let mut accepted_segment_ids = Vec::new();
        let mut ignored_stale_segment_ids = Vec::new();
        for action in actions {
            match action {
                Action::Accept(segment) => {
                    accepted_segment_ids.push(segment.segment_id.clone());
                    self.segments.insert(
                        segment.segment_id.clone(),
                        AcceptedSegment {
                            value: segment,
                            provider_sequence: batch.provider_sequence,
                        },
                    );
                }
                Action::Ignore(segment_id) => ignored_stale_segment_ids.push(segment_id),
            }
        }
        self.remember_batch(batch_key);
        Ok(ApplyReport {
            accepted_segment_ids,
            ignored_stale_segment_ids,
            duplicate_batch: false,
        })
    }

    fn remember_batch(&mut self, key: (u64, WireId)) {
        self.seen_batches.insert(key.clone());
        self.seen_order.push_back(key);
        while self.seen_order.len() > self.max_seen_batches {
            if let Some(evicted) = self.seen_order.pop_front() {
                self.seen_batches.remove(&evicted);
            }
        }
    }
}

/// Versioned `mimir.stt.v1` client text frames. `Audio` is followed by exactly
/// one binary frame of `byte_len` bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    Start {
        contract: String,
        session_id: WireId,
        request: SttPreflightRequest,
    },
    Audio {
        sequence: u64,
        start_ms: u64,
        end_ms: u64,
        byte_len: u32,
    },
    Stop {
        final_audio_sequence: u64,
    },
}

impl ClientMessage {
    pub fn start(session_id: WireId, request: SttPreflightRequest) -> Self {
        Self::Start {
            contract: STT_WIRE_CONTRACT.to_string(),
            session_id,
            request,
        }
    }
}

/// Versioned `mimir.stt.v1` server text frames. Error messages are represented
/// by stable codes only so remote response bodies cannot enter logs or IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Ready {
        contract: String,
        capabilities: SttCapabilities,
    },
    Transcript {
        batch: NormalizedTranscriptBatch,
    },
    Acknowledged {
        audio_sequence: u64,
    },
    Error {
        code: WireId,
        retryable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
    Complete {
        final_provider_sequence: u64,
    },
}

impl ServerMessage {
    pub fn validate(&self) -> Result<(), WireProtocolError> {
        match self {
            Self::Ready {
                contract,
                capabilities,
            } => {
                if contract != STT_WIRE_CONTRACT {
                    return Err(WireProtocolError::ContractMismatch);
                }
                capabilities
                    .validate()
                    .map_err(WireProtocolError::InvalidCapabilities)
            }
            Self::Transcript { batch } => batch
                .validate()
                .map_err(WireProtocolError::InvalidTranscript),
            Self::Error { retry_after_ms, .. }
                if retry_after_ms.is_some_and(|delay| delay > MAX_RECONNECT_DELAY_MS) =>
            {
                Err(WireProtocolError::InvalidRetryDelay)
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Error)]
pub enum WireProtocolError {
    #[error("STT peer selected an unexpected wire contract")]
    ContractMismatch,
    #[error("STT peer advertised invalid capabilities: {0}")]
    InvalidCapabilities(CapabilityContractError),
    #[error("STT peer emitted an invalid transcript batch: {0}")]
    InvalidTranscript(NormalizeError),
    #[error("STT peer requested an excessive retry delay")]
    InvalidRetryDelay,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ReplayError {
    #[error("replay buffer limits are outside supported bounds")]
    InvalidLimits,
    #[error("replay audio chunk is invalid")]
    InvalidChunk,
    #[error("replay audio chunk exceeds the entire bounded buffer")]
    ChunkTooLarge,
    #[error("replay audio chunks must be pushed in sequence and time order")]
    OutOfOrderChunk,
    #[error("replay interval is invalid")]
    InvalidInterval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayBufferLimits {
    pub max_duration_ms: u64,
    pub max_bytes: usize,
    pub max_chunks: usize,
}

impl ReplayBufferLimits {
    pub fn validate(self) -> Result<Self, ReplayError> {
        if self.max_duration_ms == 0
            || self.max_duration_ms > MAX_REPLAY_DURATION_MS
            || self.max_bytes == 0
            || self.max_bytes > MAX_REPLAY_BYTES
            || self.max_chunks == 0
            || self.max_chunks > MAX_REPLAY_CHUNKS
        {
            return Err(ReplayError::InvalidLimits);
        }
        Ok(self)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ReplayAudioChunk {
    pub sequence: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    bytes: Vec<u8>,
}

impl ReplayAudioChunk {
    pub fn new(
        sequence: u64,
        start_ms: u64,
        end_ms: u64,
        bytes: Vec<u8>,
    ) -> Result<Self, ReplayError> {
        if start_ms >= end_ms || bytes.is_empty() {
            return Err(ReplayError::InvalidChunk);
        }
        Ok(Self {
            sequence,
            start_ms,
            end_ms,
            bytes,
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

impl fmt::Debug for ReplayAudioChunk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReplayAudioChunk")
            .field("sequence", &self.sequence)
            .field("start_ms", &self.start_ms)
            .field("end_ms", &self.end_ms)
            .field("audio", &format_args!("[{} bytes]", self.bytes.len()))
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGap {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayPlan {
    pub chunks: Vec<ReplayAudioChunk>,
    pub gaps: Vec<ReplayGap>,
}

/// A time-, byte-, and item-bounded replay queue. Eviction is deterministic
/// and replayed chunks are never selected twice.
#[derive(Debug, Clone)]
pub struct ReplayBuffer {
    limits: ReplayBufferLimits,
    chunks: VecDeque<ReplayAudioChunk>,
    total_bytes: usize,
    replayed_sequences: BTreeSet<u64>,
    accounted_through_ms: Option<u64>,
}

impl ReplayBuffer {
    pub fn new(limits: ReplayBufferLimits) -> Result<Self, ReplayError> {
        Ok(Self {
            limits: limits.validate()?,
            chunks: VecDeque::new(),
            total_bytes: 0,
            replayed_sequences: BTreeSet::new(),
            accounted_through_ms: None,
        })
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn push(&mut self, chunk: ReplayAudioChunk) -> Result<(), ReplayError> {
        if chunk.byte_len() > self.limits.max_bytes
            || chunk.end_ms - chunk.start_ms > self.limits.max_duration_ms
        {
            return Err(ReplayError::ChunkTooLarge);
        }
        if let Some(last) = self.chunks.back() {
            if chunk.sequence <= last.sequence
                || chunk.start_ms < last.start_ms
                || chunk.end_ms <= last.end_ms
            {
                return Err(ReplayError::OutOfOrderChunk);
            }
        }
        self.total_bytes = self
            .total_bytes
            .checked_add(chunk.byte_len())
            .ok_or(ReplayError::ChunkTooLarge)?;
        let newest_end = chunk.end_ms;
        self.chunks.push_back(chunk);
        self.evict_to_limits(newest_end);
        Ok(())
    }

    fn evict_to_limits(&mut self, newest_end_ms: u64) {
        let earliest_allowed = newest_end_ms.saturating_sub(self.limits.max_duration_ms);
        while self.chunks.front().is_some_and(|front| {
            front.end_ms <= earliest_allowed
                || self.total_bytes > self.limits.max_bytes
                || self.chunks.len() > self.limits.max_chunks
        }) {
            let evicted = self.chunks.pop_front().expect("front was present");
            self.total_bytes -= evicted.byte_len();
            self.replayed_sequences.remove(&evicted.sequence);
        }
    }

    pub fn plan_once(
        &mut self,
        interruption_start_ms: u64,
        reconnect_at_ms: u64,
    ) -> Result<ReplayPlan, ReplayError> {
        if interruption_start_ms >= reconnect_at_ms {
            return Err(ReplayError::InvalidInterval);
        }
        let bounded_start = reconnect_at_ms.saturating_sub(self.limits.max_duration_ms);
        let requested_start =
            interruption_start_ms.max(self.accounted_through_ms.unwrap_or(interruption_start_ms));
        let mut cursor = requested_start;
        let mut chunks = Vec::new();
        let mut gaps = Vec::new();
        let first_eligible_start = self
            .chunks
            .iter()
            .find(|chunk| {
                chunk.end_ms > bounded_start
                    && chunk.start_ms < reconnect_at_ms
                    && !self.replayed_sequences.contains(&chunk.sequence)
            })
            .map(|chunk| chunk.start_ms);
        if let Some(first_start) = first_eligible_start {
            let replay_starts = first_start.max(requested_start);
            if requested_start < replay_starts {
                gaps.push(ReplayGap {
                    start_ms: requested_start,
                    end_ms: replay_starts,
                });
            }
            cursor = replay_starts;
        }

        for chunk in &self.chunks {
            if chunk.end_ms <= bounded_start
                || chunk.start_ms >= reconnect_at_ms
                || self.replayed_sequences.contains(&chunk.sequence)
            {
                continue;
            }
            if chunk.start_ms > cursor {
                gaps.push(ReplayGap {
                    start_ms: cursor,
                    end_ms: chunk.start_ms.min(reconnect_at_ms),
                });
            }
            cursor = cursor.max(chunk.end_ms.min(reconnect_at_ms));
            self.replayed_sequences.insert(chunk.sequence);
            chunks.push(chunk.clone());
        }
        if cursor < reconnect_at_ms {
            gaps.push(ReplayGap {
                start_ms: cursor,
                end_ms: reconnect_at_ms,
            });
            cursor = reconnect_at_ms;
        }
        self.accounted_through_ms = Some(
            self.accounted_through_ms
                .unwrap_or(interruption_start_ms)
                .max(cursor),
        );
        Ok(ReplayPlan { chunks, gaps })
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ReconnectPolicyError {
    #[error("reconnect policy is outside supported bounds")]
    InvalidBounds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    pub max_attempts: u8,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl ReconnectPolicy {
    pub fn validate(self) -> Result<Self, ReconnectPolicyError> {
        if self.max_attempts == 0
            || self.max_attempts > MAX_RECONNECT_ATTEMPTS
            || self.base_delay_ms == 0
            || self.base_delay_ms > self.max_delay_ms
            || self.max_delay_ms > MAX_RECONNECT_DELAY_MS
        {
            return Err(ReconnectPolicyError::InvalidBounds);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconnectDecision {
    RetrySelectedProvider {
        attempt: u8,
        delay_ms: u64,
    },
    QueueDelayedRepair {
        gap: ReplayGap,
        reason: DelayedRepairReason,
        /// `true` only for the first exhaustion decision in this connection
        /// episode; callers use it to avoid duplicate durable enqueue work.
        newly_queued: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelayedRepairReason {
    LiveProviderUnavailable,
    ReconnectBudgetExhausted,
}

#[derive(Debug, Clone)]
pub struct ReconnectController {
    policy: ReconnectPolicy,
    attempts: u8,
    repair_queued: bool,
}

impl ReconnectController {
    pub fn new(policy: ReconnectPolicy) -> Result<Self, ReconnectPolicyError> {
        Ok(Self {
            policy: policy.validate()?,
            attempts: 0,
            repair_queued: false,
        })
    }

    pub fn attempts(&self) -> u8 {
        self.attempts
    }

    pub fn on_provider_failure(
        &mut self,
        interruption_start_ms: u64,
        observed_at_ms: u64,
    ) -> Result<ReconnectDecision, ReplayError> {
        if interruption_start_ms >= observed_at_ms {
            return Err(ReplayError::InvalidInterval);
        }
        if self.attempts < self.policy.max_attempts {
            self.attempts += 1;
            let exponent = u32::from(self.attempts.saturating_sub(1));
            let multiplier = 2_u64.checked_pow(exponent).unwrap_or(u64::MAX);
            let delay_ms = self
                .policy
                .base_delay_ms
                .saturating_mul(multiplier)
                .min(self.policy.max_delay_ms);
            return Ok(ReconnectDecision::RetrySelectedProvider {
                attempt: self.attempts,
                delay_ms,
            });
        }
        let newly_queued = !self.repair_queued;
        self.repair_queued = true;
        Ok(ReconnectDecision::QueueDelayedRepair {
            gap: ReplayGap {
                start_ms: interruption_start_ms,
                end_ms: observed_at_ms,
            },
            reason: DelayedRepairReason::ReconnectBudgetExhausted,
            newly_queued,
        })
    }

    pub fn repair_queued(&self) -> bool {
        self.repair_queued
    }

    pub fn on_connected(&mut self) {
        self.attempts = 0;
        self.repair_queued = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn id(value: &str) -> WireId {
        WireId::new(value).unwrap()
    }

    fn capabilities() -> SttCapabilities {
        SttCapabilities {
            contract_version: STT_WIRE_VERSION,
            operations: [
                TranscriptionOperation::Live,
                TranscriptionOperation::BatchRepair,
            ]
            .into_iter()
            .collect(),
            encodings: [AudioEncoding::PcmS16Le].into_iter().collect(),
            sample_rates_hz: [16_000, 48_000].into_iter().collect(),
            max_channels: 2,
            max_audio_frame_bytes: 64 * 1024,
            supports_partial_results: true,
            supports_speaker_labels: false,
            languages: LanguageCapability::Explicit {
                tags: ["de-DE".to_string(), "en-US".to_string()]
                    .into_iter()
                    .collect(),
            },
        }
    }

    fn request() -> SttPreflightRequest {
        SttPreflightRequest {
            operation: TranscriptionOperation::Live,
            encoding: AudioEncoding::PcmS16Le,
            sample_rate_hz: 48_000,
            channels: 2,
            audio_frame_bytes: 32_000,
            partial_results: true,
            speaker_labels: false,
            language: Some("de-DE".into()),
        }
    }

    fn segment(revision: u64, state: SegmentState, text: &str) -> NormalizedSegment {
        NormalizedSegment {
            segment_id: id("segment-1"),
            revision,
            state,
            start_ms: 100,
            end_ms: 900,
            text: text.into(),
            channel_id: Some(id("system")),
            speaker: None,
            language: Some("de-DE".into()),
            confidence: Some(0.9),
        }
    }

    fn batch(
        sequence: u64,
        batch_id: &str,
        segment: NormalizedSegment,
    ) -> NormalizedTranscriptBatch {
        NormalizedTranscriptBatch {
            provider_sequence: sequence,
            batch_id: id(batch_id),
            segments: vec![segment],
        }
    }

    #[test]
    fn capability_preflight_passes_before_audio_for_exact_contract() {
        assert!(capabilities().preflight(&request()).is_ok());
    }

    #[test]
    fn capability_preflight_reports_every_mismatch_without_fallback() {
        let mut request = request();
        request.encoding = AudioEncoding::Opus;
        request.sample_rate_hz = 44_100;
        request.channels = 3;
        request.audio_frame_bytes = 70_000;
        request.speaker_labels = true;
        request.language = Some("fr-FR".into());
        let failure = capabilities().preflight(&request).unwrap_err();
        assert_eq!(failure.mismatches.len(), 6);
        let json = serde_json::to_string(&failure.mismatches).unwrap();
        assert!(!json.contains("fallback"));
        assert!(!json.contains("provider"));
    }

    #[test]
    fn malformed_provider_capabilities_fail_closed() {
        let mut advertised = capabilities();
        advertised.contract_version = 99;
        let failure = advertised.preflight(&request()).unwrap_err();
        assert!(matches!(
            failure.mismatches.as_slice(),
            [CapabilityMismatch::InvalidProviderContract { .. }]
        ));
    }

    #[test]
    fn wire_contract_has_stable_json_shape_and_no_vendor_fields() {
        let message = ClientMessage::start(id("meeting-1"), request());
        let value = serde_json::to_value(message).unwrap();
        assert_eq!(value["type"], "start");
        assert_eq!(value["contract"], STT_WIRE_CONTRACT);
        assert_eq!(value["sessionId"], "meeting-1");
        assert_eq!(value["request"]["sampleRateHz"], 48_000);
        let encoded = serde_json::to_string(&value).unwrap();
        for vendor in ["deepgram", "openai", "google", "aws", "azure"] {
            assert!(!encoded.contains(vendor));
        }
    }

    #[test]
    fn server_ready_requires_exact_contract_and_valid_capabilities() {
        let valid = ServerMessage::Ready {
            contract: STT_WIRE_CONTRACT.into(),
            capabilities: capabilities(),
        };
        assert!(valid.validate().is_ok());
        let invalid = ServerMessage::Ready {
            contract: "mimir.stt.v2".into(),
            capabilities: capabilities(),
        };
        assert!(matches!(
            invalid.validate(),
            Err(WireProtocolError::ContractMismatch)
        ));
    }

    #[test]
    fn provisional_revision_replaces_only_same_segment_then_final_is_terminal() {
        let mut accumulator = TranscriptAccumulator::default();
        accumulator
            .apply(batch(
                1,
                "batch-1",
                segment(1, SegmentState::Partial, "Guten"),
            ))
            .unwrap();
        accumulator
            .apply(batch(
                2,
                "batch-2",
                segment(2, SegmentState::Partial, "Guten Morgen"),
            ))
            .unwrap();
        accumulator
            .apply(batch(
                3,
                "batch-3",
                segment(2, SegmentState::Final, "Guten Morgen"),
            ))
            .unwrap();
        let accepted = &accumulator.segments()[&id("segment-1")];
        assert_eq!(accepted.value.text, "Guten Morgen");
        assert_eq!(accepted.value.state, SegmentState::Final);

        let stale = accumulator
            .apply(batch(
                4,
                "batch-4",
                segment(99, SegmentState::Final, "must not replace"),
            ))
            .unwrap();
        assert_eq!(stale.ignored_stale_segment_ids, vec![id("segment-1")]);
        assert_eq!(
            accumulator.segments()[&id("segment-1")].value.text,
            "Guten Morgen"
        );
    }

    #[test]
    fn duplicate_and_out_of_order_batches_are_idempotent_per_segment() {
        let mut accumulator = TranscriptAccumulator::default();
        let first = batch(10, "batch-a", segment(2, SegmentState::Partial, "new"));
        accumulator.apply(first.clone()).unwrap();
        assert!(accumulator.apply(first).unwrap().duplicate_batch);
        let stale = accumulator
            .apply(batch(
                9,
                "batch-b",
                segment(1, SegmentState::Partial, "old"),
            ))
            .unwrap();
        assert_eq!(stale.ignored_stale_segment_ids.len(), 1);
        assert_eq!(accumulator.segments()[&id("segment-1")].value.text, "new");
    }

    #[test]
    fn revision_and_provenance_conflicts_are_atomic() {
        let mut accumulator = TranscriptAccumulator::default();
        accumulator
            .apply(batch(
                1,
                "batch-1",
                segment(1, SegmentState::Partial, "one"),
            ))
            .unwrap();
        let conflict = batch(2, "batch-2", segment(1, SegmentState::Partial, "different"));
        assert!(matches!(
            accumulator.apply(conflict),
            Err(NormalizeError::RevisionConflict)
        ));
        assert_eq!(accumulator.segments()[&id("segment-1")].value.text, "one");

        let mut moved = segment(2, SegmentState::Final, "one");
        moved.start_ms = 99;
        assert!(matches!(
            accumulator.apply(batch(3, "batch-3", moved)),
            Err(NormalizeError::ProvenanceConflict)
        ));
        assert_eq!(accumulator.segments()[&id("segment-1")].value.start_ms, 100);
    }

    #[test]
    fn transcript_debug_omits_content() {
        let value = segment(1, SegmentState::Partial, "private meeting words");
        let debug = format!("{value:?}");
        assert!(!debug.contains("private meeting words"));
        assert!(debug.contains("21 bytes"));
    }

    #[test]
    fn replay_buffer_is_bounded_by_time_bytes_and_count() {
        let limits = ReplayBufferLimits {
            max_duration_ms: 1_000,
            max_bytes: 6,
            max_chunks: 2,
        };
        let mut buffer = ReplayBuffer::new(limits).unwrap();
        buffer
            .push(ReplayAudioChunk::new(1, 0, 500, vec![1; 3]).unwrap())
            .unwrap();
        buffer
            .push(ReplayAudioChunk::new(2, 500, 1_000, vec![2; 3]).unwrap())
            .unwrap();
        buffer
            .push(ReplayAudioChunk::new(3, 1_000, 1_500, vec![3; 3]).unwrap())
            .unwrap();
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.total_bytes(), 6);
    }

    #[test]
    fn reconnect_replays_recent_chunks_once_and_turns_older_audio_into_gap() {
        let mut buffer = ReplayBuffer::new(ReplayBufferLimits {
            max_duration_ms: 1_000,
            max_bytes: 1_024,
            max_chunks: 8,
        })
        .unwrap();
        buffer
            .push(ReplayAudioChunk::new(2, 1_000, 1_500, vec![2]).unwrap())
            .unwrap();
        buffer
            .push(ReplayAudioChunk::new(3, 1_500, 2_000, vec![3]).unwrap())
            .unwrap();
        let first = buffer.plan_once(0, 2_000).unwrap();
        assert_eq!(
            first
                .chunks
                .iter()
                .map(|chunk| chunk.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(
            first.gaps,
            vec![ReplayGap {
                start_ms: 0,
                end_ms: 1_000
            }]
        );

        let second = buffer.plan_once(0, 2_100).unwrap();
        assert!(second.chunks.is_empty());
        assert_eq!(
            second.gaps,
            vec![ReplayGap {
                start_ms: 2_000,
                end_ms: 2_100
            }]
        );
    }

    #[test]
    fn replay_gap_ends_at_indivisible_chunk_boundary() {
        let mut buffer = ReplayBuffer::new(ReplayBufferLimits {
            max_duration_ms: 1_000,
            max_bytes: 1_024,
            max_chunks: 8,
        })
        .unwrap();
        buffer
            .push(ReplayAudioChunk::new(1, 900, 1_100, vec![1]).unwrap())
            .unwrap();
        let plan = buffer.plan_once(0, 2_000).unwrap();
        assert_eq!(plan.chunks.len(), 1);
        assert_eq!(
            plan.gaps,
            vec![
                ReplayGap {
                    start_ms: 0,
                    end_ms: 900
                },
                ReplayGap {
                    start_ms: 1_100,
                    end_ms: 2_000
                }
            ]
        );
    }

    #[test]
    fn reconnect_budget_is_bounded_and_only_queues_delayed_repair() {
        let mut controller = ReconnectController::new(ReconnectPolicy {
            max_attempts: 3,
            base_delay_ms: 100,
            max_delay_ms: 250,
        })
        .unwrap();
        let mut delays = Vec::new();
        for now in [1_000, 2_000, 3_000] {
            match controller.on_provider_failure(500, now).unwrap() {
                ReconnectDecision::RetrySelectedProvider { delay_ms, .. } => delays.push(delay_ms),
                _ => panic!("repair queued too early"),
            }
        }
        assert_eq!(delays, vec![100, 200, 250]);
        assert!(matches!(
            controller.on_provider_failure(500, 4_000).unwrap(),
            ReconnectDecision::QueueDelayedRepair {
                reason: DelayedRepairReason::ReconnectBudgetExhausted,
                newly_queued: true,
                ..
            }
        ));
        assert!(matches!(
            controller.on_provider_failure(500, 5_000).unwrap(),
            ReconnectDecision::QueueDelayedRepair {
                newly_queued: false,
                ..
            }
        ));
        assert!(controller.repair_queued());
    }

    proptest! {
        #[test]
        fn normalized_confidence_accepts_only_finite_unit_interval(value in any::<f32>()) {
            let mut candidate = segment(1, SegmentState::Partial, "text");
            candidate.confidence = Some(value);
            let valid = value.is_finite() && (0.0..=1.0).contains(&value);
            prop_assert_eq!(candidate.validate().is_ok(), valid);
        }

        #[test]
        fn replay_queue_never_exceeds_declared_bounds(
            chunk_sizes in prop::collection::vec(1_usize..64, 1..100)
        ) {
            let limits = ReplayBufferLimits {
                max_duration_ms: 1_000,
                max_bytes: 128,
                max_chunks: 7,
            };
            let mut buffer = ReplayBuffer::new(limits).unwrap();
            let mut start = 0_u64;
            for (sequence, size) in chunk_sizes.into_iter().enumerate() {
                let end = start + 100;
                let chunk = ReplayAudioChunk::new(
                    sequence as u64,
                    start,
                    end,
                    vec![0; size],
                ).unwrap();
                let _ = buffer.push(chunk);
                prop_assert!(buffer.total_bytes() <= limits.max_bytes);
                prop_assert!(buffer.len() <= limits.max_chunks);
                start = end;
            }
        }

        #[test]
        fn reconnect_delay_is_always_capped(attempts in 1_u8..=MAX_RECONNECT_ATTEMPTS) {
            let policy = ReconnectPolicy {
                max_attempts: attempts,
                base_delay_ms: 1,
                max_delay_ms: 17,
            };
            let mut controller = ReconnectController::new(policy).unwrap();
            for attempt in 0..attempts {
                let decision = controller
                    .on_provider_failure(0, u64::from(attempt) + 1)
                    .unwrap();
                match decision {
                    ReconnectDecision::RetrySelectedProvider { delay_ms, .. } => {
                        prop_assert!(delay_ms <= 17);
                    }
                    _ => prop_assert!(false, "retry budget exhausted too early"),
                }
            }
        }
    }
}
