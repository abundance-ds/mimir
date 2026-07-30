//! Tauri IPC boundary for the meeting runtime.
//!
//! Command names and camel-cased arguments intentionally mirror
//! `src/services/meetings.js`. Potentially blocking native work is moved off
//! Tauri's command task before entering the serialized runtime.

use super::runtime::{
    MeetingConfigPatch, MeetingDeleteMode, MeetingEvent, MeetingEventSink, MeetingExport,
    MeetingExportFormat, MeetingRuntime, MeetingSnapshot, MeetingUpdatePatch, StartMeetingRequest,
    MEETING_EVENT,
};
use std::sync::Arc;
use tauri::Emitter;

pub struct TauriMeetingEventSink {
    app: tauri::AppHandle,
}

impl TauriMeetingEventSink {
    pub fn new(app: &tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app: app.clone() })
    }
}

impl MeetingEventSink for TauriMeetingEventSink {
    fn publish(&self, event: &MeetingEvent) -> Result<(), String> {
        self.app
            .emit(MEETING_EVENT, event)
            .map_err(|error| format!("could not emit {MEETING_EVENT}: {error}"))
    }
}

async fn run_blocking<T, F>(operation: &'static str, callback: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(callback)
        .await
        .map_err(|error| format!("{operation} task failed: {error}"))?
}

#[tauri::command]
pub async fn meetings_snapshot(
    runtime: tauri::State<'_, MeetingRuntime>,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting snapshot", move || {
        runtime.snapshot().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_start(
    runtime: tauri::State<'_, MeetingRuntime>,
    request: StartMeetingRequest,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting start", move || {
        runtime.start(request).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_stop(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting stop", move || {
        runtime.stop(&meeting_id).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_set_mic_muted(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    muted: bool,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting microphone mute", move || {
        runtime
            .set_microphone_muted(&meeting_id, muted)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_update(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    patch: MeetingUpdatePatch,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting update", move || {
        runtime
            .update_meeting(&meeting_id, patch)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_decide_kg(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    decision: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting knowledge-graph decision", move || {
        runtime
            .decide_kg(&meeting_id, &decision)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_retry_job(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    job_kind: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting job retry", move || {
        runtime
            .retry_job(&meeting_id, &job_kind)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_delete(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    mode: String,
) -> Result<MeetingSnapshot, String> {
    let mode = MeetingDeleteMode::parse(&mode).map_err(|error| error.to_string())?;
    let runtime = runtime.inner().clone();
    run_blocking("meeting deletion", move || {
        runtime
            .delete(&meeting_id, mode)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_export(
    runtime: tauri::State<'_, MeetingRuntime>,
    meeting_id: String,
    format: String,
) -> Result<MeetingExport, String> {
    let format = MeetingExportFormat::parse(&format).map_err(|error| error.to_string())?;
    let runtime = runtime.inner().clone();
    run_blocking("meeting export", move || {
        runtime
            .export(&meeting_id, format)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_update_config(
    runtime: tauri::State<'_, MeetingRuntime>,
    patch: MeetingConfigPatch,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting config update", move || {
        runtime
            .update_config(patch)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_set_api_key(
    runtime: tauri::State<'_, MeetingRuntime>,
    api_key: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting API key update", move || {
        runtime
            .set_api_key(&api_key)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_clear_api_key(
    runtime: tauri::State<'_, MeetingRuntime>,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting API key removal", move || {
        runtime.clear_api_key().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_install_model(
    runtime: tauri::State<'_, MeetingRuntime>,
    model_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting model install", move || {
        runtime
            .install_model(&model_id)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn meetings_delete_model(
    runtime: tauri::State<'_, MeetingRuntime>,
    model_id: String,
) -> Result<MeetingSnapshot, String> {
    let runtime = runtime.inner().clone();
    run_blocking("meeting model deletion", move || {
        runtime
            .delete_model(&model_id)
            .map_err(|error| error.to_string())
    })
    .await
}
