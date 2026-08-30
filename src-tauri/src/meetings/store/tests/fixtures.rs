use super::super::model::MeetingOrigin;
use super::*;
use serde_json::json;
use tempfile::tempdir;

const T0: &str = "2026-07-30T10:00:00Z";
const T1: &str = "2026-07-30T10:01:00Z";
const T2: &str = "2026-07-30T10:02:00Z";
const T3: &str = "2026-07-30T10:03:00Z";
const T4: &str = "2026-07-30T10:04:00Z";

fn store() -> MeetingStore {
    MeetingStore::open_in_memory().unwrap()
}

fn meeting() -> MeetingDraft {
    MeetingDraft {
        id: "meeting-1".into(),
        title: "Project review".into(),
        origin: MeetingOrigin {
            kind: "calendar".into(),
            external_id: Some("event-1".into()),
            confidence: Some(0.98),
            evidence: json!({"process": "zoom"}),
        },
        channels: vec![
            AudioChannelDraft {
                id: "mic".into(),
                kind: AudioChannelKind::Microphone,
                sample_rate_hz: 48_000,
                channels: 1,
                sample_format: "f32le".into(),
                device_id: Some("device-1".into()),
            },
            AudioChannelDraft {
                id: "system".into(),
                kind: AudioChannelKind::System,
                sample_rate_hz: 48_000,
                channels: 2,
                sample_format: "f32le".into(),
                device_id: None,
            },
        ],
        metadata: json!({"workspacePath": "/workspace"}),
    }
}

fn start_recording(store: &MeetingStore) -> MeetingRecord {
    let created = store.create_meeting(&meeting(), T0).unwrap();
    store
        .transition_meeting(
            &created.id,
            created.revision,
            MeetingStatus::Recording,
            T1,
            None,
        )
        .unwrap()
}

fn segment(id: &str, text: &str) -> TranscriptSegmentInput {
    TranscriptSegmentInput {
        id: id.into(),
        start_ms: 0,
        end_ms: 1_000,
        text: text.into(),
        channel_id: Some("system".into()),
        speaker: Some("Alex".into()),
        confidence: Some(0.9),
        is_final: false,
        metadata: json!({}),
    }
}

fn batch(batch_id: &str, base_revision: u64, changes: Vec<TranscriptChange>) -> TranscriptBatch {
    TranscriptBatch {
        meeting_id: "meeting-1".into(),
        batch_id: batch_id.into(),
        base_revision,
        source: "local-whisper".into(),
        observed_at: T2.into(),
        marks_final: false,
        changes,
    }
}

fn repair_terminal(base_revision: u64) -> TranscriptBatch {
    TranscriptBatch {
        meeting_id: "meeting-1".into(),
        batch_id: "repair-terminal".into(),
        base_revision,
        source: "repair-local-whisper".into(),
        observed_at: T3.into(),
        marks_final: true,
        changes: Vec::new(),
    }
}

fn interrupt(store: &MeetingStore) {
    let meeting = store.get_meeting("meeting-1").unwrap();
    store
        .transition_meeting(
            "meeting-1",
            meeting.revision,
            MeetingStatus::Interrupted,
            T2,
            None,
        )
        .unwrap();
}

fn job(id: &str, key: &str, max_attempts: u32) -> FollowUpJobDraft {
    FollowUpJobDraft {
        id: id.into(),
        meeting_id: "meeting-1".into(),
        kind: FollowUpJobKind::Summary,
        idempotency_key: key.into(),
        payload: json!({"prompt": "Summarize"}),
        max_attempts,
        not_before: T1.into(),
    }
}

