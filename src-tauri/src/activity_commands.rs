use crate::activities::{
    ActivityEvent, ActivityEventSink, ActivityRecord, ActivitySnapshot, ActivitySupervisor,
    SpawnActivityRequest,
};
use std::sync::Arc;
use tauri::Emitter;

const ACTIVITY_EVENT: &str = "mim://activity-event";

pub struct TauriActivitySink {
    app: tauri::AppHandle,
}

impl TauriActivitySink {
    pub fn install(app: &tauri::AppHandle, supervisor: &ActivitySupervisor) -> u64 {
        supervisor.subscribe(Arc::new(Self { app: app.clone() }))
    }
}

impl ActivityEventSink for TauriActivitySink {
    fn publish(&self, event: &ActivityEvent) {
        let _ = self.app.emit(ACTIVITY_EVENT, event);
    }
}

#[tauri::command]
pub fn activity_list(supervisor: tauri::State<'_, ActivitySupervisor>) -> Vec<ActivityRecord> {
    supervisor.list()
}

#[tauri::command]
pub async fn activity_spawn(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    record: ActivityRecord,
    cols: u16,
    rows: u16,
) -> Result<ActivitySnapshot, String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .spawn(SpawnActivityRequest::new(record, cols, rows))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity spawn task failed: {error}"))?
}

#[tauri::command]
pub fn activity_snapshot(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
    after_sequence: Option<u64>,
) -> Result<ActivitySnapshot, String> {
    supervisor
        .snapshot(&activity_id, after_sequence)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn activity_write(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .write(&activity_id, bytes)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity input task failed: {error}"))?
}

#[tauri::command]
pub async fn activity_resize(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .resize(&activity_id, cols, rows)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity resize task failed: {error}"))?
}

#[tauri::command]
pub async fn activity_stop(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
) -> Result<(), String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .stop(&activity_id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity stop task failed: {error}"))?
}

#[tauri::command]
pub fn activity_interrupt_all(supervisor: tauri::State<'_, ActivitySupervisor>) -> usize {
    supervisor.interrupt_all()
}

#[tauri::command]
pub async fn activity_flush(
    supervisor: tauri::State<'_, ActivitySupervisor>,
) -> Result<(), String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .flush_persistence()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity persistence task failed: {error}"))?
}
