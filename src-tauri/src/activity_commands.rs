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
pub async fn activity_respawn(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    record: ActivityRecord,
    cols: u16,
    rows: u16,
) -> Result<ActivitySnapshot, String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .respawn(SpawnActivityRequest::new(record, cols, rows))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity respawn task failed: {error}"))?
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
pub fn activity_rename(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
    title: String,
) -> Result<ActivityRecord, String> {
    supervisor
        .rename(&activity_id, title)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn activity_set_archived(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
    archived: bool,
) -> Result<ActivityRecord, String> {
    supervisor
        .set_archived(&activity_id, archived)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn activity_clear(
    supervisor: tauri::State<'_, ActivitySupervisor>,
    activity_id: String,
) -> Result<ActivityRecord, String> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .clear(&activity_id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Activity clear task failed: {error}"))?
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::activities::{
        ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin, ActivityRetention,
        ActivityStatus, ActivitySupervisorConfig,
    };
    use std::{collections::BTreeMap, thread, time::Duration};
    use tauri::Manager;

    fn completed_record(id: &str) -> ActivityRecord {
        ActivityRecord {
            id: id.into(),
            kind: ActivityKind::Agent,
            title: id.into(),
            workspace_path: None,
            status: ActivityStatus::Ready,
            created_at: "2026-07-25T00:00:00Z".into(),
            updated_at: "2026-07-25T00:00:00Z".into(),
            last_viewed_at: None,
            archived_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin::default(),
            host: ActivityHost::pty(None),
            launch: Some(ActivityLaunchSpec {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "true".into()],
                cwd: None,
                env: BTreeMap::new(),
            }),
            session: None,
            error: None,
        }
    }

    #[test]
    fn lifecycle_commands_delegate_to_the_managed_supervisor() {
        let temp = tempfile::tempdir().unwrap();
        let supervisor =
            ActivitySupervisor::new(ActivitySupervisorConfig::new(temp.path())).unwrap();
        supervisor
            .spawn(SpawnActivityRequest::new(
                completed_record("command-lifecycle"),
                80,
                24,
            ))
            .unwrap();
        while !supervisor
            .snapshot("command-lifecycle", None)
            .unwrap()
            .record
            .status
            .is_ended()
        {
            thread::sleep(Duration::from_millis(5));
        }

        let app = tauri::test::mock_app();
        app.manage(supervisor);

        let renamed = activity_rename(
            app.state(),
            "command-lifecycle".into(),
            "Command title".into(),
        )
        .unwrap();
        assert_eq!(renamed.title, "Command title");

        let archived =
            activity_set_archived(app.state(), "command-lifecycle".into(), true).unwrap();
        assert!(archived.archived_at.is_some());

        let cleared =
            tauri::async_runtime::block_on(activity_clear(app.state(), "command-lifecycle".into()))
                .unwrap();
        assert_eq!(cleared.id, "command-lifecycle");
        assert!(activity_list(app.state()).is_empty());
    }
}
