//! Native meeting-domain foundation.
//!
//! This module deliberately has no Tauri command or renderer dependencies.
//! `MeetingStore` is the durable authority; capture, transcription, and UI
//! adapters can be layered over its optimistic revisions and idempotent writes.

mod model;
mod store;

pub use model::{
    AudioChannel, AudioChannelDraft, AudioChannelKind, AudioChunk, AudioChunkDraft,
    AudioChunkStatus, FollowUpJob, FollowUpJobDraft, FollowUpJobKind, JobFinish, JobState,
    MeetingDraft, MeetingFailure, MeetingOrigin, MeetingRecord, MeetingStatus, RecoveryReport,
    TranscriptApplyResult, TranscriptBatch, TranscriptChange, TranscriptGapInput,
    TranscriptGapReason, TranscriptGapRecord, TranscriptRevision, TranscriptSegmentInput,
    TranscriptSegmentRecord, TranscriptSnapshot,
};
pub use store::{MeetingStore, MeetingStoreError, CURRENT_SCHEMA_VERSION};
