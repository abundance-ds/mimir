use super::*;
use crate::meetings::{TranscriptChange, TranscriptSegmentInput};
use std::collections::BTreeMap;
use std::{sync::Barrier, thread};

const NOW: &str = "2026-07-30T10:00:00.000Z";
const LEASE_END: &str = "2026-07-30T10:05:00.000Z";

#[derive(Default)]
struct FakeCapture {
    starts: Mutex<Vec<CaptureStart>>,
    stops: Mutex<Vec<CaptureStop>>,
    mute_changes: Mutex<Vec<(String, String, bool)>>,
    recoveries: Mutex<Vec<RecoveryReport>>,
    fail_start: Mutex<Option<String>>,
}

impl MeetingCapturePort for FakeCapture {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
        self.recoveries.lock().unwrap().push(report.clone());
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        if let Some(error) = self.fail_start.lock().unwrap().clone() {
            return Err(error);
        }
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        self.stops.lock().unwrap().push(request.clone());
        Ok(CaptureStopResult {
            duration_ms: 42_000,
        })
    }

    fn set_microphone_muted(
        &self,
        meeting_id: &str,
        run_id: &str,
        muted: bool,
    ) -> Result<(), String> {
        self.mute_changes
            .lock()
            .unwrap()
            .push((meeting_id.into(), run_id.into(), muted));
        Ok(())
    }
}

struct ReconnectGapOnStopCapture {
    store: Arc<MeetingStore>,
}

impl MeetingCapturePort for ReconnectGapOnStopCapture {
    fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, _request: &CaptureStart) -> Result<(), String> {
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        let meeting = self
            .store
            .get_meeting(&request.meeting_id)
            .map_err(|error| error.to_string())?;
        self.store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: request.meeting_id.clone(),
                batch_id: format!("reconnect-gap-{}", request.run_id),
                base_revision: meeting.transcript_revision,
                source: "native-capture".into(),
                observed_at: NOW.into(),
                marks_final: false,
                changes: vec![TranscriptChange::OpenGap {
                    gap: crate::meetings::TranscriptGapInput {
                        id: "microphone-reconnect-gap".into(),
                        start_ms: 40_000,
                        end_ms: 42_000,
                        reason: crate::meetings::TranscriptGapReason::DeviceChanged,
                        channel_id: Some("microphone".into()),
                        detail: Some(
                            "capture stopped while audio devices were reconnecting".into(),
                        ),
                    },
                }],
            })
            .map_err(|error| error.to_string())?;
        Ok(CaptureStopResult {
            duration_ms: 42_000,
        })
    }

    fn set_microphone_muted(
        &self,
        _meeting_id: &str,
        _run_id: &str,
        _muted: bool,
    ) -> Result<(), String> {
        Ok(())
    }
}

struct PromotingRecoveryCapture {
    store: Arc<MeetingStore>,
}

impl MeetingCapturePort for PromotingRecoveryCapture {
    fn recover(&self, report: &RecoveryReport) -> Result<(), String> {
        for chunk in &report.staged_audio_chunks {
            self.store
                .commit_audio_chunk(&chunk.definition.id, NOW)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn start(&self, _request: &CaptureStart) -> Result<(), String> {
        Ok(())
    }

    fn stop(&self, _request: &CaptureStop) -> Result<CaptureStopResult, String> {
        Ok(CaptureStopResult::default())
    }

    fn set_microphone_muted(
        &self,
        _meeting_id: &str,
        _run_id: &str,
        _muted: bool,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct EndedWorkerCapture {
    starts: Mutex<Vec<CaptureStart>>,
    stops: Mutex<Vec<CaptureStop>>,
}

impl MeetingCapturePort for EndedWorkerCapture {
    fn recover(&self, _report: &RecoveryReport) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, request: &CaptureStart) -> Result<(), String> {
        self.starts.lock().unwrap().push(request.clone());
        Ok(())
    }

    fn stop(&self, request: &CaptureStop) -> Result<CaptureStopResult, String> {
        self.stops.lock().unwrap().push(request.clone());
        Err("capture worker already ended after a durable chunk failure".into())
    }

    fn set_microphone_muted(
        &self,
        _meeting_id: &str,
        _run_id: &str,
        _muted: bool,
    ) -> Result<(), String> {
        Ok(())
    }
}

