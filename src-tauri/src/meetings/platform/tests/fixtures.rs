use super::*;
use crate::meetings::{
    native::EndpointBoundMeetingCredentialResolver, transcriber::MeetingCredentialResolver,
    AudioChannelDraft, AudioChannelKind, MeetingDraft, MeetingOrigin, TranscriptBatch,
    TranscriptChange, TranscriptSegmentInput,
};
use serde_json::json;
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar, Mutex,
    },
    time::Duration as StdDuration,
};
use tempfile::TempDir;

const NOW: &str = "2026-07-30T10:00:00Z";

#[derive(Default)]
struct FakeSecrets {
    value: Mutex<Option<(String, String)>>,
    reads: AtomicUsize,
}

impl MeetingSecretStore for FakeSecrets {
    fn read(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        Ok(self
            .value
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(binding, _)| binding == &endpoint.credential_binding())
            .map(|(_, secret)| secret.clone()))
    }

    fn set(&self, endpoint: &CustomSttEndpoint, secret: &str) -> Result<(), String> {
        *self.value.lock().unwrap() = Some((endpoint.credential_binding(), secret.to_string()));
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

struct FakeEnvironment;

impl MeetingEnvironmentProbe for FakeEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        Ok(MeetingEnvironmentProjection {
            permissions: MeetingPermissions {
                microphone: "granted".into(),
                system_audio: "granted".into(),
            },
            candidates: Vec::new(),
            diagnostic: None,
        })
    }
}

struct TrackingEnvironment {
    detection_updates: Arc<Mutex<Vec<bool>>>,
}

impl MeetingEnvironmentProbe for TrackingEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        FakeEnvironment.projection()
    }

    fn set_detection_enabled(&self, enabled: bool) -> Result<(), String> {
        self.detection_updates.lock().unwrap().push(enabled);
        Ok(())
    }
}

struct FailingDetectionEnvironment;

impl MeetingEnvironmentProbe for FailingDetectionEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        FakeEnvironment.projection()
    }

    fn set_detection_enabled(&self, _enabled: bool) -> Result<(), String> {
        Err(format!(
            "detector unavailable {}",
            "bounded-diagnostic-tail".repeat(100)
        ))
    }
}

struct FakeDisk;

impl MeetingDiskSpaceProbe for FakeDisk {
    fn available_bytes(&self, _path: &Path) -> Result<u64, String> {
        Ok(2 * 1024 * 1024 * 1024)
    }
}

struct FakeDownloader {
    bytes: Vec<u8>,
    completion: Arc<(Mutex<bool>, Condvar)>,
}

impl ModelArtifactDownloader for FakeDownloader {
    fn download(
        &self,
        _manifest: &ModelManifest,
        destination: &mut File,
        progress: &mut dyn FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String> {
        destination.write_all(&self.bytes).unwrap();
        progress(self.bytes.len() as u64)?;
        *self.completion.0.lock().unwrap() = true;
        self.completion.1.notify_all();
        Ok(())
    }
}

fn id(value: &str) -> ConfigIdentifier {
    ConfigIdentifier::new(value, "test id").unwrap()
}

fn manifest(bytes: &[u8]) -> ModelManifest {
    ModelManifest {
        schema_version: super::super::config::MODEL_MANIFEST_SCHEMA_VERSION,
        model_id: id("whisper-small"),
        version: id("test-1"),
        platform: RuntimePlatform::MACOS_AARCH64,
        artifact_bytes: bytes.len() as u64,
        sha256: Sha256Digest::calculate(Cursor::new(bytes)).unwrap(),
        download_url: ModelDownloadUrl::new("https://models.example.com/whisper.bin").unwrap(),
        disk_reserve_bytes: super::super::config::MIN_MODEL_DISK_RESERVE_BYTES,
    }
}

struct Fixture {
    _directory: TempDir,
    paths: MeetingPlatformPaths,
    store: Arc<MeetingStore>,
    platform: NativeMeetingPlatform,
    secrets: Arc<FakeSecrets>,
    completion: Arc<(Mutex<bool>, Condvar)>,
}

fn fixture() -> Fixture {
    fixture_with_environment(Arc::new(FakeEnvironment))
}

fn fixture_with_environment(environment: Arc<dyn MeetingEnvironmentProbe>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
    fs::create_dir_all(&paths.meetings_root).unwrap();
    let store = Arc::new(MeetingStore::open(paths.meetings_root.join("meetings.sqlite")).unwrap());
    let model_bytes = b"verified managed model".to_vec();
    let completion = Arc::new((Mutex::new(false), Condvar::new()));
    let secrets = Arc::new(FakeSecrets::default());
    let platform = NativeMeetingPlatform::new(
        paths.clone(),
        store.clone(),
        vec![MeetingModelCatalogEntry {
            title: "Whisper Small".into(),
            manifest: manifest(&model_bytes),
        }],
        secrets.clone(),
        environment,
        Arc::new(FakeDisk),
        Arc::new(FakeDownloader {
            bytes: model_bytes,
            completion: completion.clone(),
        }),
        Arc::new(NoopMeetingPlatformChangeSink),
    )
    .unwrap();
    Fixture {
        _directory: directory,
        paths,
        store,
        platform,
        secrets,
        completion,
    }
}

fn create_meeting(fixture: &Fixture, id: &str) {
    fixture
        .store
        .create_meeting(
            &MeetingDraft {
                id: id.into(),
                title: "Production review".into(),
                origin: MeetingOrigin::default(),
                channels: vec![AudioChannelDraft {
                    id: "microphone".into(),
                    kind: AudioChannelKind::Microphone,
                    sample_rate_hz: 16_000,
                    channels: 1,
                    sample_format: "f32le".into(),
                    device_id: None,
                }],
                metadata: json!({
                    "workspacePath": "/work",
                    "sourceApp": "Zoom",
                }),
            },
            NOW,
        )
        .unwrap();
}

fn complete_meeting(fixture: &Fixture, id: &str) {
    for status in [
        super::super::MeetingStatus::Recording,
        super::super::MeetingStatus::Stopping,
        super::super::MeetingStatus::Finalizing,
        super::super::MeetingStatus::Completed,
    ] {
        let meeting = fixture.store.get_meeting(id).unwrap();
        fixture
            .store
            .transition_meeting(id, meeting.revision, status, NOW, None)
            .unwrap();
    }
}

