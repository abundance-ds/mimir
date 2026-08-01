//! Native meeting-domain foundation.
//!
//! This module deliberately has no Tauri command or renderer dependencies.
//! `MeetingStore` is the durable authority; capture, transcription, and UI
//! adapters can be layered over its optimistic revisions and idempotent writes.

pub mod audio_test;
pub mod capture;
pub mod commands;
pub mod config;
pub mod jobs;
pub mod local_whisper;
mod model;
pub mod native;
pub mod permissions;
pub mod platform;
pub mod runtime;
mod store;
pub mod stt;
pub(crate) mod tools;
pub mod transcriber;
mod transcript;

pub use model::{
    AudioChannel, AudioChannelDraft, AudioChannelKind, AudioChunk, AudioChunkDraft,
    AudioChunkStatus, FollowUpJob, FollowUpJobDraft, FollowUpJobKind, JobFinish, JobState,
    MeetingDraft, MeetingFailure, MeetingOrigin, MeetingRecord, MeetingStatus, RecoveryReport,
    TranscriptApplyResult, TranscriptBatch, TranscriptChange, TranscriptGapInput,
    TranscriptGapReason, TranscriptGapRecord, TranscriptRevision, TranscriptSegmentInput,
    TranscriptSegmentRecord, TranscriptSnapshot,
};
pub use store::{
    MeetingDeletion, MeetingDeletionMode, MeetingDeletionStage, MeetingStore, MeetingStoreError,
    TranscriptRepairBegin, CURRENT_SCHEMA_VERSION,
};
pub use transcript::{
    ProviderTranscriptFrame, TranscriptNormalization, TranscriptNormalizer,
    TranscriptNormalizerError,
};
