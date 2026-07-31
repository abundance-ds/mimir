//! Native persistence, credential, model-install, and artifact services for Scribe.
//!
//! The meeting lifecycle and transcript remain owned by [`MeetingStore`].
//! This adapter owns the smaller native projections required by
//! [`MeetingPlatformPort`]: user configuration, editable meeting content,
//! keychain credentials, managed local-model artifacts, retention, exports,
//! and deletion of external meeting files.

use super::{
    config::{
        ConfigIdentifier, CustomSttEndpoint, ModelDownloadState, ModelDownloadUrl,
        ModelIntegrityError, ModelInvalidReason, ModelManifest, RuntimePlatform, Sha256Digest,
        MIN_MODEL_DISK_RESERVE_BYTES, MODEL_MANIFEST_SCHEMA_VERSION,
    },
    runtime::{
        MeetingCandidate, MeetingConfig, MeetingConfigPatch, MeetingContentProjection,
        MeetingDeleteMode, MeetingExport, MeetingExportFormat, MeetingModel, MeetingPermissions,
        MeetingPlatformPort, MeetingPlatformProjection, MeetingUpdatePatch,
    },
    MeetingDeletionMode as StoreDeletionMode, MeetingDeletionStage, MeetingStore,
};
use crate::persistence::{
    ensure_private_directory, ensure_private_subdirectory, load_json_optional_quarantining,
    prepare_private_file_path, repair_private_file, repair_private_file_if_exists,
    repair_private_tree, write_private_bytes_atomic, write_private_json_atomic, QuarantinedLoad,
};
use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt;
use reqwest::{header::LOCATION, redirect::Policy, StatusCode, Url};
use serde::{de, Deserialize, Deserializer, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    net::{SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::UNIX_EPOCH,
};
use uuid::Uuid;

const CONFIG_SCHEMA_VERSION: u32 = 1;
const CONTENT_SCHEMA_VERSION: u32 = 1;
const MODEL_STATE_SCHEMA_VERSION: u32 = 1;
const KEYCHAIN_BINDING_SCHEMA_VERSION: u32 = 1;
const KEYCHAIN_SERVICE: &str = "rs.shoulde.mimir";
const KEYCHAIN_ACCOUNT: &str = "meetings.custom-stt";
const MAX_API_KEY_BYTES: usize = 64 * 1024;
const MAX_SUMMARY_BYTES: usize = 4 * 1024 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_BYTES: usize = 160;
const MODEL_PROGRESS_CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS: usize = 5;
const MAX_DIAGNOSTIC_CHARS: usize = 1_024;

#[derive(Debug, Clone)]
pub struct MeetingPlatformPaths {
    pub config_file: PathBuf,
    pub meetings_root: PathBuf,
    pub content_root: PathBuf,
    pub exports_root: PathBuf,
    pub models_root: PathBuf,
    pub model_state_file: PathBuf,
}

impl MeetingPlatformPaths {
    pub fn from_mimir_root(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        let meetings_root = root.join("meetings");
        let models_root = root.join("models").join("stt");
        Self {
            config_file: root.join("meetings.json"),
            content_root: meetings_root.join(".content"),
            exports_root: meetings_root.join("exports"),
            meetings_root,
            model_state_file: models_root.join("installations.json"),
            models_root,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MeetingEnvironmentProjection {
    pub permissions: MeetingPermissions,
    pub candidates: Vec<MeetingCandidate>,
    pub diagnostic: Option<String>,
}

pub trait MeetingEnvironmentProbe: Send + Sync {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String>;

    /// Keep native detection policy aligned with the durable setting.
    ///
    /// Implementations without an owned detector may retain the default
    /// no-op. The production detector adapter updates an atomic worker flag and
    /// wakes its poll loop immediately.
    fn set_detection_enabled(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    /// Prevent a candidate accepted by the user from being suggested again.
    fn dismiss_candidate(&self, _candidate_id: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Explicitly unavailable environment probe for non-capture builds.
///
/// A production macOS bootstrap should inject the capture subsystem's probe;
/// using this fallback cannot accidentally authorize recording.
pub struct UnavailableMeetingEnvironment;

impl MeetingEnvironmentProbe for UnavailableMeetingEnvironment {
    fn projection(&self) -> Result<MeetingEnvironmentProjection, String> {
        Ok(MeetingEnvironmentProjection {
            permissions: MeetingPermissions {
                microphone: "unavailable".into(),
                system_audio: "unavailable".into(),
            },
            candidates: Vec::new(),
            diagnostic: Some(
                "Native meeting permission and detection services are unavailable in this build"
                    .into(),
            ),
        })
    }
}

pub trait MeetingSecretStore: Send + Sync {
    fn read(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String>;
    fn set(&self, endpoint: &CustomSttEndpoint, secret: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// Release-safe keychain storage. There is intentionally no file or
/// environment fallback in either debug or release builds.
pub struct KeychainMeetingSecretStore;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointBoundKeychainSecret {
    schema_version: u32,
    endpoint_binding: String,
    secret: String,
}

fn encode_endpoint_bound_secret(
    endpoint: &CustomSttEndpoint,
    secret: &str,
) -> Result<String, String> {
    serde_json::to_string(&EndpointBoundKeychainSecret {
        schema_version: KEYCHAIN_BINDING_SCHEMA_VERSION,
        endpoint_binding: endpoint.credential_binding(),
        secret: secret.to_string(),
    })
    .map_err(|_| "Could not encode the endpoint-bound meeting credential".to_string())
}

fn decode_endpoint_bound_secret(encoded: &str, endpoint: &CustomSttEndpoint) -> Option<String> {
    let bound = serde_json::from_str::<EndpointBoundKeychainSecret>(encoded).ok()?;
    if bound.schema_version != KEYCHAIN_BINDING_SCHEMA_VERSION
        || bound.endpoint_binding != endpoint.credential_binding()
        || bound.secret.trim().is_empty()
        || bound.secret.len() > MAX_API_KEY_BYTES
        || bound.secret.chars().any(char::is_control)
    {
        return None;
    }
    Some(bound.secret)
}

impl KeychainMeetingSecretStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|error| {
            format!("Could not access the OS keychain for meeting transcription: {error}")
        })
    }
}

impl MeetingSecretStore for KeychainMeetingSecretStore {
    fn read(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(encoded) => {
                // Pre-binding credentials and malformed values are deliberately
                // treated as unconfigured. They can be overwritten by an
                // explicit re-entry, but are never released to an endpoint.
                Ok(decode_endpoint_bound_secret(&encoded, endpoint))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Could not read the meeting transcription credential from the OS keychain: {error}"
            )),
        }
    }

    fn set(&self, endpoint: &CustomSttEndpoint, secret: &str) -> Result<(), String> {
        let encoded = encode_endpoint_bound_secret(endpoint, secret)?;
        Self::entry()?.set_password(&encoded).map_err(|error| {
            format!(
                "OS keychain is unavailable; refusing to store the meeting transcription credential in plaintext: {error}"
            )
        })
    }

    fn clear(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Could not remove the meeting transcription credential from the OS keychain: {error}"
            )),
        }
    }
}

pub trait MeetingDiskSpaceProbe: Send + Sync {
    fn available_bytes(&self, path: &Path) -> Result<u64, String>;
}

pub struct SystemMeetingDiskSpaceProbe;

impl MeetingDiskSpaceProbe for SystemMeetingDiskSpaceProbe {
    fn available_bytes(&self, path: &Path) -> Result<u64, String> {
        #[cfg(unix)]
        {
            let output = std::process::Command::new("/bin/df")
                .arg("-Pk")
                .arg(path)
                .output()
                .map_err(|error| format!("Could not inspect model disk space: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Could not inspect model disk space: df exited with {}",
                    output.status
                ));
            }
            let stdout = String::from_utf8(output.stdout).map_err(|_| {
                "Could not inspect model disk space: df returned non-UTF-8".to_string()
            })?;
            let row = stdout
                .lines()
                .rfind(|line| !line.trim().is_empty())
                .ok_or_else(|| {
                    "Could not inspect model disk space: df returned no rows".to_string()
                })?;
            let available_kib = row
                .split_whitespace()
                .nth(3)
                .ok_or_else(|| {
                    "Could not inspect model disk space: unexpected df output".to_string()
                })?
                .parse::<u64>()
                .map_err(|_| {
                    "Could not inspect model disk space: invalid byte count".to_string()
                })?;
            available_kib.checked_mul(1024).ok_or_else(|| {
                "Could not inspect model disk space: byte count overflow".to_string()
            })
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err("Managed model disk-space checks are unavailable on this platform".into())
        }
    }
}

pub trait ModelArtifactDownloader: Send + Sync {
    fn download(
        &self,
        manifest: &ModelManifest,
        destination: &mut File,
        progress: &mut dyn FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String>;
}

/// HTTPS-only downloader with bounded redirects and DNS pinning per hop.
///
/// Every connection resolves the hostname before the request, rejects private
/// and special-purpose addresses through `ModelDownloadUrl`, and pins reqwest
/// to those exact addresses. This closes the usual validate-then-resolve DNS
/// rebinding gap while retaining TLS hostname validation.
pub struct HttpsModelArtifactDownloader;

impl ModelArtifactDownloader for HttpsModelArtifactDownloader {
    fn download(
        &self,
        manifest: &ModelManifest,
        destination: &mut File,
        progress: &mut dyn FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String> {
        let manifest_url = manifest.download_url.as_str().to_string();
        let expected_bytes = manifest.artifact_bytes;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Could not start the managed model downloader: {error}"))?;
        runtime.block_on(async {
            let mut current = Url::parse(&manifest_url)
                .map_err(|_| "Managed model manifest contains an invalid URL".to_string())?;
            for redirect_count in 0..=MAX_DOWNLOAD_REDIRECTS {
                let (host, addresses) = validated_download_destination(&current)?;
                let client = reqwest::Client::builder()
                    .redirect(Policy::none())
                    .https_only(true)
                    .user_agent("Mimir-Scribe/0.1")
                    .resolve_to_addrs(&host, &addresses)
                    .build()
                    .map_err(|error| {
                        redacted_reqwest_error("Could not configure model download TLS", &error)
                    })?;
                let response = client
                    .get(current.clone())
                    .send()
                    .await
                    .map_err(|error| {
                        redacted_reqwest_error("Managed model download failed", &error)
                    })?;

                if is_redirect(response.status()) {
                    if redirect_count == MAX_DOWNLOAD_REDIRECTS {
                        return Err("Managed model download exceeded the redirect limit".into());
                    }
                    let location = response
                        .headers()
                        .get(LOCATION)
                        .ok_or_else(|| {
                            "Managed model server returned a redirect without a destination"
                                .to_string()
                        })?
                        .to_str()
                        .map_err(|_| {
                            "Managed model server returned an invalid redirect destination"
                                .to_string()
                        })?;
                    current = current.join(location).map_err(|_| {
                        "Managed model server returned an invalid redirect destination".to_string()
                    })?;
                    continue;
                }

                if !response.status().is_success() {
                    return Err(format!(
                        "Managed model server returned HTTP {}",
                        response.status()
                    ));
                }
                if let Some(length) = response.content_length() {
                    if length != expected_bytes {
                        return Err(format!(
                            "Managed model server declared {length} bytes; expected {expected_bytes}"
                        ));
                    }
                }

                let mut received = 0_u64;
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|error| {
                        redacted_reqwest_error("Managed model download was interrupted", &error)
                    })?;
                    received = received
                        .checked_add(chunk.len() as u64)
                        .ok_or_else(|| "Managed model download size overflow".to_string())?;
                    if received > expected_bytes {
                        return Err("Managed model download exceeded its declared size".into());
                    }
                    destination
                        .write_all(&chunk)
                        .map_err(|error| format!("Could not write the managed model: {error}"))?;
                    progress(chunk.len() as u64)?;
                }
                if received != expected_bytes {
                    return Err(format!(
                        "Managed model download ended at {received} bytes; expected {expected_bytes}"
                    ));
                }
                return Ok(());
            }
            Err("Managed model download exceeded the redirect limit".into())
        })
    }
}

fn redacted_reqwest_error(context: &str, error: &reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "network timeout"
    } else if error.is_connect() {
        "connection failure"
    } else if error.is_body() {
        "response body failure"
    } else if error.is_decode() {
        "response decode failure"
    } else if error.is_request() {
        "request failure"
    } else {
        "network failure"
    };
    // reqwest's Display representation can include the complete request URL,
    // including a signed redirect query. Only a stable category may cross into
    // diagnostics or durable job state.
    format!("{context}: {category}")
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn validated_download_destination(url: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Managed model redirects must remain HTTPS and cannot contain credentials or fragments"
                .into(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Managed model URL has no hostname".to_string())?
        .to_ascii_lowercase();
    // Reuse config.rs's public-DNS validation without accepting the redirect's
    // (possibly signed) query string as a persisted manifest URL.
    ModelDownloadUrl::new(&format!("https://{host}/"))
        .map_err(|error| format!("Unsafe managed model destination: {error}"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Managed model URL has no HTTPS port".to_string())?;
    let mut addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve managed model host: {error}"))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    ModelDownloadUrl::new(&format!("https://{host}/"))
        .and_then(|validated| {
            validated.validate_resolved_addresses(addresses.iter().map(SocketAddr::ip))
        })
        .map_err(|error| format!("Unsafe managed model destination: {error}"))?;
    if addresses.is_empty() {
        return Err("Managed model hostname resolved to no addresses".into());
    }
    Ok((host, addresses))
}

pub trait MeetingPlatformChangeSink: Send + Sync {
    fn changed(&self, kind: &'static str);
}

pub struct NoopMeetingPlatformChangeSink;

impl MeetingPlatformChangeSink for NoopMeetingPlatformChangeSink {
    fn changed(&self, _kind: &'static str) {}
}

#[derive(Debug, Clone)]
pub struct MeetingModelCatalogEntry {
    pub title: String,
    pub manifest: ModelManifest,
}

/// Mimir-owned, immutable manifest for the default local Whisper model.
///
/// The Hugging Face revision, byte length, and SHA-256 are pinned together;
/// model installation never resolves a mutable `main` branch. Updating this
/// catalog is a supply-chain change that must update all three values.
pub fn builtin_model_catalog() -> Result<Vec<MeetingModelCatalogEntry>, String> {
    const REVISION: &str = "c521a4b02f422512d734391fdf08bb08c0862f68";
    const ARTIFACT_BYTES: u64 = 487_601_967;
    const SHA256: &str = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
    let model_id = ConfigIdentifier::new("whisper-small", "managed model id")
        .map_err(|error| error.to_string())?;
    let version = ConfigIdentifier::new(format!("hf-{REVISION}"), "managed model version")
        .map_err(|error| error.to_string())?;
    let sha256 = SHA256
        .parse()
        .map_err(|error: ModelIntegrityError| error.to_string())?;
    let download_url = ModelDownloadUrl::new(&format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/ggml-small.bin"
    ))
    .map_err(|error| error.to_string())?;
    let manifest = ModelManifest {
        schema_version: MODEL_MANIFEST_SCHEMA_VERSION,
        model_id,
        version,
        platform: RuntimePlatform::MACOS_AARCH64,
        artifact_bytes: ARTIFACT_BYTES,
        sha256,
        download_url,
        disk_reserve_bytes: MIN_MODEL_DISK_RESERVE_BYTES,
    };
    manifest.validate().map_err(|error| error.to_string())?;
    Ok(vec![MeetingModelCatalogEntry {
        title: "Whisper Small · multilingual".into(),
        manifest,
    }])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMeetingConfig {
    schema_version: u32,
    config: StoredMeetingConfig,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMeetingConfig {
    detection_enabled: bool,
    auto_record: bool,
    transcription_mode: String,
    custom_url: String,
    custom_model: String,
    local_model: String,
    summary_enabled: bool,
    summary_preset: String,
    kg_prompt: String,
    kg_preset: String,
    retention_days: Option<u32>,
}

impl From<MeetingConfig> for StoredMeetingConfig {
    fn from(config: MeetingConfig) -> Self {
        Self {
            detection_enabled: config.detection_enabled,
            auto_record: config.auto_record,
            transcription_mode: config.transcription_mode,
            custom_url: config.custom_url,
            custom_model: config.custom_model,
            local_model: config.local_model,
            summary_enabled: config.summary_enabled,
            summary_preset: config.summary_preset,
            kg_prompt: config.kg_prompt,
            kg_preset: config.kg_preset,
            retention_days: config.retention_days,
        }
    }
}

impl From<StoredMeetingConfig> for MeetingConfig {
    fn from(config: StoredMeetingConfig) -> Self {
        Self {
            detection_enabled: config.detection_enabled,
            auto_record: config.auto_record,
            transcription_mode: config.transcription_mode,
            custom_url: config.custom_url,
            custom_model: config.custom_model,
            api_key_configured: false,
            local_model: config.local_model,
            summary_enabled: config.summary_enabled,
            summary_preset: config.summary_preset,
            kg_prompt: config.kg_prompt,
            kg_preset: config.kg_preset,
            retention_days: config.retention_days,
        }
    }
}

impl<'de> Deserialize<'de> for PersistedMeetingConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            schema_version: u32,
            config: StoredMeetingConfig,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(de::Error::custom("unsupported meeting config schema"));
        }
        let config = MeetingConfig::from(wire.config);
        validate_meeting_config(&config).map_err(de::Error::custom)?;
        Ok(Self {
            schema_version: wire.schema_version,
            config: StoredMeetingConfig::from(config),
        })
    }
}

impl PersistedMeetingConfig {
    fn new(mut config: MeetingConfig) -> Result<Self, String> {
        config.api_key_configured = false;
        validate_meeting_config(&config)?;
        Ok(Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            config: StoredMeetingConfig::from(config),
        })
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMeetingContent {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kg_decision: Option<String>,
    #[serde(default)]
    deleted: bool,
}

impl<'de> Deserialize<'de> for PersistedMeetingContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            schema_version: u32,
            title: Option<String>,
            summary: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
            workspace_path: Option<String>,
            source_app: Option<String>,
            kg_decision: Option<String>,
            #[serde(default)]
            deleted: bool,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.schema_version != CONTENT_SCHEMA_VERSION {
            return Err(de::Error::custom("unsupported meeting content schema"));
        }
        validate_content_fields(
            wire.title.as_deref(),
            wire.summary.as_deref(),
            &wire.tags,
            wire.kg_decision.as_deref(),
        )
        .map_err(de::Error::custom)?;
        Ok(Self {
            schema_version: wire.schema_version,
            title: wire.title,
            summary: wire.summary,
            tags: wire.tags,
            workspace_path: wire.workspace_path,
            source_app: wire.source_app,
            kg_decision: wire.kg_decision,
            deleted: wire.deleted,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedModelState {
    schema_version: u32,
    #[serde(default)]
    models: BTreeMap<String, ModelDownloadState>,
}

impl<'de> Deserialize<'de> for PersistedModelState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            schema_version: u32,
            #[serde(default)]
            models: BTreeMap<String, ModelDownloadState>,
        }
        let wire = Wire::deserialize(deserializer)?;
        if wire.schema_version != MODEL_STATE_SCHEMA_VERSION {
            return Err(de::Error::custom("unsupported managed model state schema"));
        }
        for id in wire.models.keys() {
            validate_component(id, "persisted model id").map_err(de::Error::custom)?;
        }
        Ok(Self {
            schema_version: wire.schema_version,
            models: wire.models,
        })
    }
}

impl Default for PersistedModelState {
    fn default() -> Self {
        Self {
            schema_version: MODEL_STATE_SCHEMA_VERSION,
            models: BTreeMap::new(),
        }
    }
}

struct ModelManager {
    paths: MeetingPlatformPaths,
    catalog: BTreeMap<String, MeetingModelCatalogEntry>,
    disk: Arc<dyn MeetingDiskSpaceProbe>,
    downloader: Arc<dyn ModelArtifactDownloader>,
    changes: Arc<dyn MeetingPlatformChangeSink>,
    operation: Mutex<()>,
    active: Mutex<HashSet<String>>,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

impl ModelManager {
    fn new(
        paths: MeetingPlatformPaths,
        catalog: Vec<MeetingModelCatalogEntry>,
        disk: Arc<dyn MeetingDiskSpaceProbe>,
        downloader: Arc<dyn ModelArtifactDownloader>,
        changes: Arc<dyn MeetingPlatformChangeSink>,
        diagnostics: Arc<Mutex<Vec<String>>>,
    ) -> Result<Arc<Self>, String> {
        ensure_private_directory(&paths.models_root)
            .map_err(|error| format!("Could not secure managed model directory: {error}"))?;
        repair_private_tree(&paths.models_root)
            .map_err(|error| format!("Could not repair managed model storage: {error}"))?;
        let mut indexed = BTreeMap::new();
        for entry in catalog {
            entry
                .manifest
                .validate()
                .map_err(|error| format!("Invalid managed model manifest: {error}"))?;
            let id = entry.manifest.model_id.as_str().to_string();
            if indexed.insert(id.clone(), entry).is_some() {
                return Err(format!("Duplicate managed model manifest '{id}'"));
            }
        }
        let manager = Arc::new(Self {
            paths,
            catalog: indexed,
            disk,
            downloader,
            changes,
            operation: Mutex::new(()),
            active: Mutex::new(HashSet::new()),
            diagnostics,
        });
        manager.recover_interrupted_installs()?;
        Ok(manager)
    }

    fn recover_interrupted_installs(&self) -> Result<(), String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let mut changed = false;
        for (model_id, entry) in &self.catalog {
            if let Ok(directory) = self.model_version_dir(&entry.manifest) {
                collect_model_partials(&directory);
            }
            let Some(model) = state.models.get_mut(model_id) else {
                continue;
            };
            if !matches!(
                model,
                ModelDownloadState::Downloading { .. } | ModelDownloadState::Verifying { .. }
            ) {
                continue;
            }
            let recovered = RuntimePlatform::current()
                .filter(|runtime| runtime == &entry.manifest.platform)
                .and_then(|runtime| {
                    let path = self.model_artifact_path(&entry.manifest).ok()?;
                    reject_symlink(&path).ok()?;
                    let mut artifact = File::open(path).ok()?;
                    let bytes = artifact.metadata().ok()?.len();
                    let digest = Sha256Digest::calculate(&mut artifact).ok()?;
                    let mut ready = ModelDownloadState::Verifying {
                        artifact_bytes: bytes,
                    };
                    ready
                        .finish_verification(&entry.manifest, runtime, bytes, digest)
                        .ok()?;
                    Some(ready)
                });
            *model = recovered.unwrap_or(ModelDownloadState::Invalid {
                reason: ModelInvalidReason::Incomplete,
            });
            changed = true;
        }
        if changed {
            self.save_state(&state)?;
        }
        Ok(())
    }

    fn projection(&self) -> Result<Vec<MeetingModel>, String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let mut changed = false;
        let models = self
            .catalog
            .iter()
            .map(|(id, entry)| {
                let installation = state.models.entry(id.clone()).or_default();
                let before = installation.clone();
                installation.invalidate_if_manifest_changed(&entry.manifest);
                if matches!(installation, ModelDownloadState::Ready { .. }) {
                    let artifact_valid = self
                        .model_artifact_path(&entry.manifest)
                        .ok()
                        .and_then(|path| fs::metadata(path).ok())
                        .is_some_and(|metadata| {
                            metadata.is_file() && metadata.len() == entry.manifest.artifact_bytes
                        });
                    if !artifact_valid {
                        *installation = ModelDownloadState::Invalid {
                            reason: ModelInvalidReason::Unreadable,
                        };
                    }
                }
                changed |= *installation != before;
                model_projection(id, entry, installation.clone())
            })
            .collect();
        if changed {
            self.save_state(&state)?;
        }
        Ok(models)
    }

    fn install(self: &Arc<Self>, model_id: &str) -> Result<(), String> {
        validate_component(model_id, "model id")?;
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        ensure_private_directory(&self.paths.models_root)
            .map_err(|error| format!("Could not secure managed model directory: {error}"))?;
        {
            let mut active = lock(&self.active)?;
            if !active.insert(model_id.to_string()) {
                return Ok(());
            }
        }
        let already_ready = (|| {
            let _operation = lock(&self.operation)?;
            let mut state = self.load_state()?;
            self.verified_ready(&entry.manifest, state.models.get_mut(model_id))
        })();
        let already_ready = match already_ready {
            Ok(value) => value,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(error);
            }
        };
        if already_ready {
            lock(&self.active)?.remove(model_id);
            return Ok(());
        }
        let free = match self.disk.available_bytes(&self.paths.models_root) {
            Ok(free) => free,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(error);
            }
        };
        let initial = match ModelDownloadState::begin(&entry.manifest, runtime, free) {
            Ok(state) => state,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(format!(
                    "Cannot install managed model '{model_id}': {error}"
                ));
            }
        };
        let prepare_result = (|| {
            let _operation = lock(&self.operation)?;
            let mut state = self.load_state()?;
            state.models.insert(model_id.into(), initial);
            self.save_state(&state)
        })();
        if let Err(error) = prepare_result {
            lock(&self.active)?.remove(model_id);
            return Err(error);
        }

        let manager = self.clone();
        let model_id = model_id.to_string();
        let worker_model_id = model_id.clone();
        let spawn = thread::Builder::new()
            .name(format!("scribe-model-{model_id}"))
            .spawn(move || {
                if let Err(error) = manager.perform_install(&worker_model_id) {
                    manager.record_install_failure(&worker_model_id, &error);
                }
                if let Ok(mut active) = manager.active.lock() {
                    active.remove(&worker_model_id);
                }
                manager.changes.changed("model");
            });
        if let Err(error) = spawn {
            lock(&self.active)?.remove(&model_id);
            let message = format!("Could not start managed model download: {error}");
            self.record_install_failure(&model_id, &message);
            return Err(message);
        }
        self.changes.changed("model");
        Ok(())
    }

    fn perform_install(&self, model_id: &str) -> Result<(), String> {
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' disappeared from the catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        let model_dir = self.model_version_dir(&entry.manifest)?;
        let final_path = model_dir.join("model.bin");
        let pending_path = model_dir.join(format!(".model-{}.part", Uuid::new_v4()));
        let mut pending_guard = PendingPath::file(pending_path.clone());
        let mut pending = create_private_new_file(&pending_path)?;
        let mut download_state = ModelDownloadState::begin(
            &entry.manifest,
            runtime,
            self.disk.available_bytes(&self.paths.models_root)?,
        )
        .map_err(|error| error.to_string())?;
        let mut checkpoint = 0_u64;
        let download = self
            .downloader
            .download(&entry.manifest, &mut pending, &mut |additional| {
                download_state
                    .record_downloaded(additional)
                    .map_err(|error| error.to_string())?;
                let received = match download_state {
                    ModelDownloadState::Downloading { received_bytes, .. } => received_bytes,
                    _ => 0,
                };
                if received.saturating_sub(checkpoint) >= MODEL_PROGRESS_CHECKPOINT_BYTES {
                    self.persist_model_state(model_id, download_state.clone())?;
                    checkpoint = received;
                    self.changes.changed("model");
                }
                Ok(())
            });
        if let Err(error) = download {
            drop(pending);
            return Err(error);
        }
        pending
            .flush()
            .and_then(|_| pending.sync_all())
            .map_err(|error| format!("Could not durably flush the managed model: {error}"))?;
        drop(pending);

        download_state
            .begin_verification()
            .map_err(|error| error.to_string())?;
        self.persist_model_state(model_id, download_state.clone())?;
        let mut artifact = File::open(&pending_path)
            .map_err(|error| format!("Could not reopen managed model for verification: {error}"))?;
        let metadata = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model: {error}"))?;
        let digest = Sha256Digest::calculate(&mut artifact)
            .map_err(|error| format!("Could not verify managed model checksum: {error}"))?;
        download_state
            .finish_verification(&entry.manifest, runtime, metadata.len(), digest)
            .map_err(|error| format!("Managed model verification failed: {error}"))?;

        repair_private_file_if_exists(&final_path)
            .map_err(|error| format!("Could not secure managed model destination: {error}"))?;
        fs::rename(&pending_path, &final_path)
            .map_err(|error| format!("Could not atomically install the managed model: {error}"))?;
        pending_guard.disarm();
        repair_private_file(&final_path)
            .map_err(|error| format!("Could not secure installed model: {error}"))?;
        sync_directory(&model_dir)?;
        self.persist_model_state(model_id, download_state)?;
        Ok(())
    }

    fn verified_ready(
        &self,
        manifest: &ModelManifest,
        state: Option<&mut ModelDownloadState>,
    ) -> Result<bool, String> {
        let Some(state) = state else {
            return Ok(false);
        };
        let Some(runtime) = RuntimePlatform::current() else {
            return Ok(false);
        };
        if !state.selectable_for(manifest, runtime) {
            return Ok(false);
        }
        let path = self.model_artifact_path(manifest)?;
        let mut artifact = match File::open(&path) {
            Ok(file) => file,
            Err(_) => {
                *state = ModelDownloadState::Invalid {
                    reason: ModelInvalidReason::Unreadable,
                };
                return Ok(false);
            }
        };
        let bytes = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model: {error}"))?
            .len();
        match state.verify_for_use(manifest, runtime, bytes, &mut artifact) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    fn delete(&self, model_id: &str) -> Result<(), String> {
        validate_component(model_id, "model id")?;
        if lock(&self.active)?.contains(model_id) {
            return Err(format!(
                "Managed model '{model_id}' is still downloading; wait for it to finish before deleting it"
            ));
        }
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let _operation = lock(&self.operation)?;
        let model_root = safe_direct_child(&self.paths.models_root, model_id)?;
        if model_root.exists() {
            reject_symlink(&model_root)?;
            fs::remove_dir_all(&model_root)
                .map_err(|error| format!("Could not delete managed model '{model_id}': {error}"))?;
            sync_directory(&self.paths.models_root)?;
        }
        let mut state = self.load_state()?;
        state.models.remove(entry.manifest.model_id.as_str());
        self.save_state(&state)?;
        self.changes.changed("model");
        Ok(())
    }

    fn artifact_for_use(&self, model_id: &str) -> Result<PathBuf, String> {
        validate_component(model_id, "model id")?;
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let installation = state
            .models
            .get_mut(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not installed"))?;
        let path = self.model_artifact_path(&entry.manifest)?;
        reject_symlink(&path)?;
        let mut artifact = File::open(&path)
            .map_err(|error| format!("Could not open managed model '{model_id}': {error}"))?;
        let bytes = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model '{model_id}': {error}"))?
            .len();
        if let Err(error) =
            installation.verify_for_use(&entry.manifest, runtime, bytes, &mut artifact)
        {
            self.save_state(&state)?;
            return Err(format!(
                "Managed model '{model_id}' failed its pre-launch integrity check: {error}"
            ));
        }
        Ok(path)
    }

    fn model_version_dir(&self, manifest: &ModelManifest) -> Result<PathBuf, String> {
        let relative = PathBuf::from(manifest.model_id.as_str()).join(manifest.version.as_str());
        ensure_private_subdirectory(&self.paths.models_root, relative)
            .map_err(|error| format!("Could not secure managed model version directory: {error}"))
    }

    fn model_artifact_path(&self, manifest: &ModelManifest) -> Result<PathBuf, String> {
        let relative = PathBuf::from(manifest.model_id.as_str())
            .join(manifest.version.as_str())
            .join("model.bin");
        prepare_private_file_path(&self.paths.models_root, relative)
            .map_err(|error| format!("Could not resolve managed model artifact: {error}"))
    }

    fn persist_model_state(
        &self,
        model_id: &str,
        model_state: ModelDownloadState,
    ) -> Result<(), String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        state.models.insert(model_id.into(), model_state);
        self.save_state(&state)
    }

    fn load_state(&self) -> Result<PersistedModelState, String> {
        repair_private_file_if_exists(&self.paths.model_state_file)
            .map_err(|error| format!("Could not secure managed model state: {error}"))?;
        let outcome =
            load_json_optional_quarantining::<PersistedModelState>(&self.paths.model_state_file)
                .map_err(|error| error.to_string())?;
        match outcome {
            QuarantinedLoad::Missing => Ok(PersistedModelState::default()),
            QuarantinedLoad::Loaded(state)
                if state.schema_version == MODEL_STATE_SCHEMA_VERSION =>
            {
                Ok(state)
            }
            QuarantinedLoad::Loaded(_) => Err("Unsupported managed model state schema".into()),
            QuarantinedLoad::Quarantined { path, reason } => {
                push_diagnostic(
                    &self.diagnostics,
                    format!(
                        "Invalid managed model state was moved to {}: {reason}",
                        path.display()
                    ),
                );
                Ok(PersistedModelState::default())
            }
        }
    }

    fn save_state(&self, state: &PersistedModelState) -> Result<(), String> {
        write_private_json_atomic(&self.paths.model_state_file, state)
            .map_err(|error| error.to_string())
    }

    fn record_install_failure(&self, model_id: &str, error: &str) {
        let state = classify_model_failure(error);
        let summary = model_failure_summary(&state);
        if self.persist_model_state(model_id, state).is_err() {
            push_diagnostic(
                &self.diagnostics,
                format!(
                    "Managed model '{model_id}' failed: {summary}; its failure state could not be saved"
                ),
            );
        } else {
            push_diagnostic(
                &self.diagnostics,
                format!("Managed model '{model_id}' failed: {summary}"),
            );
        }
    }
}

fn classify_model_failure(error: &str) -> ModelDownloadState {
    let lowercase = error.to_ascii_lowercase();
    let reason = if lowercase.contains("checksum") {
        ModelInvalidReason::ChecksumMismatch
    } else if lowercase.contains("size") || lowercase.contains("byte") {
        ModelInvalidReason::SizeMismatch
    } else if lowercase.contains("platform") {
        ModelInvalidReason::PlatformMismatch
    } else {
        ModelInvalidReason::Incomplete
    };
    ModelDownloadState::Invalid { reason }
}

fn model_failure_summary(state: &ModelDownloadState) -> &'static str {
    match state {
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::SizeMismatch,
        } => "artifact size verification failed",
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::ChecksumMismatch,
        } => "artifact checksum verification failed",
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::PlatformMismatch,
        } => "platform verification failed",
        ModelDownloadState::Invalid { .. } => "download did not complete",
        _ => "installation did not complete",
    }
}

fn model_projection(
    id: &str,
    entry: &MeetingModelCatalogEntry,
    state: ModelDownloadState,
) -> MeetingModel {
    let (status, downloaded_bytes, checksum, error) = match state {
        ModelDownloadState::Missing => ("available", 0, None, None),
        ModelDownloadState::Downloading { received_bytes, .. } => {
            ("downloading", received_bytes, None, None)
        }
        ModelDownloadState::Verifying { artifact_bytes } => {
            ("verifying", artifact_bytes, None, None)
        }
        ModelDownloadState::Ready {
            artifact_bytes,
            sha256,
            ..
        } => ("installed", artifact_bytes, Some(sha256.to_string()), None),
        ModelDownloadState::Invalid { reason } => (
            "error",
            0,
            None,
            Some(format!("Managed model is invalid: {reason:?}")),
        ),
    };
    MeetingModel {
        id: id.into(),
        title: entry.title.clone(),
        status: status.into(),
        bytes: entry.manifest.artifact_bytes,
        downloaded_bytes,
        checksum,
        error,
    }
}

struct NativeMeetingPlatformInner {
    paths: MeetingPlatformPaths,
    store: Arc<MeetingStore>,
    secrets: Arc<dyn MeetingSecretStore>,
    environment: Arc<dyn MeetingEnvironmentProbe>,
    models: Arc<ModelManager>,
    changes: Arc<dyn MeetingPlatformChangeSink>,
    operation: Mutex<()>,
    diagnostics: Arc<Mutex<Vec<String>>>,
    #[cfg(test)]
    content_loads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    deletion_fault: Mutex<Option<&'static str>>,
}

#[derive(Clone)]
pub struct NativeMeetingPlatform {
    inner: Arc<NativeMeetingPlatformInner>,
}

impl NativeMeetingPlatform {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        paths: MeetingPlatformPaths,
        store: Arc<MeetingStore>,
        model_catalog: Vec<MeetingModelCatalogEntry>,
        secrets: Arc<dyn MeetingSecretStore>,
        environment: Arc<dyn MeetingEnvironmentProbe>,
        disk: Arc<dyn MeetingDiskSpaceProbe>,
        downloader: Arc<dyn ModelArtifactDownloader>,
        changes: Arc<dyn MeetingPlatformChangeSink>,
    ) -> Result<Self, String> {
        secure_platform_paths(&paths)?;
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let models = ModelManager::new(
            paths.clone(),
            model_catalog,
            disk,
            downloader,
            Arc::clone(&changes),
            diagnostics.clone(),
        )?;
        let platform = Self {
            inner: Arc::new(NativeMeetingPlatformInner {
                paths,
                store,
                secrets,
                environment,
                models,
                changes,
                operation: Mutex::new(()),
                diagnostics,
                #[cfg(test)]
                content_loads: std::sync::atomic::AtomicUsize::new(0),
                #[cfg(test)]
                deletion_fault: Mutex::new(None),
            }),
        };
        // Load once during construction so corruption is quarantined before
        // runtime projection and diagnostics are stable.
        platform.reconcile_content_search()?;
        let config = platform.load_config()?;
        if let Err(error) = platform
            .inner
            .environment
            .set_detection_enabled(config.detection_enabled)
        {
            // Detection is assistive. A monitor that cannot apply its startup
            // policy must remain visible, but cannot take manual capture down
            // with it. Explicit later settings mutations still return errors.
            push_diagnostic(
                &platform.inner.diagnostics,
                format!(
                    "Meeting detection could not start; manual recording remains available: {}",
                    bounded_diagnostic(&error)
                ),
            );
        }
        Ok(platform)
    }

    pub fn production(
        paths: MeetingPlatformPaths,
        store: Arc<MeetingStore>,
        model_catalog: Vec<MeetingModelCatalogEntry>,
        environment: Arc<dyn MeetingEnvironmentProbe>,
        changes: Arc<dyn MeetingPlatformChangeSink>,
    ) -> Result<Self, String> {
        Self::new(
            paths,
            store,
            model_catalog,
            Arc::new(KeychainMeetingSecretStore),
            environment,
            Arc::new(SystemMeetingDiskSpaceProbe),
            Arc::new(HttpsModelArtifactDownloader),
            changes,
        )
    }

    /// Resolve a custom-provider credential only when the requested endpoint is
    /// still the exact route selected in native configuration. Configuration
    /// comparison and Keychain access share the platform operation lock so an
    /// endpoint switch cannot race credential release.
    pub fn custom_api_key_for(
        &self,
        endpoint: &CustomSttEndpoint,
    ) -> Result<Option<String>, String> {
        let _operation = lock(&self.inner.operation)?;
        let config = self.load_config()?;
        let configured = configured_custom_stt_endpoint(&config)?.ok_or_else(|| {
            "Custom meeting transcription is not selected; refusing credential access".to_string()
        })?;
        if &configured != endpoint {
            return Err(
                "Custom meeting transcription endpoint changed; refusing credential access".into(),
            );
        }
        self.inner.secrets.read(endpoint)
    }

    /// Resolve the redacted persisted custom route into the WebSocket endpoint
    /// type required by the native STT connector.
    pub fn custom_stt_endpoint(&self) -> Result<Option<CustomSttEndpoint>, String> {
        let config = self.load_config()?;
        configured_custom_stt_endpoint(&config)
    }

    /// Return a managed model only after re-hashing it immediately before
    /// launch. The local STT sidecar must use this method, not construct model
    /// paths itself.
    pub fn managed_model_artifact(&self, model_id: &str) -> Result<PathBuf, String> {
        self.inner.models.artifact_for_use(model_id)
    }

    /// Apply configured retention to source audio for terminal meetings whose
    /// durable transcript and dependent work no longer need it.
    pub fn enforce_retention(&self, now: DateTime<Utc>) -> Result<Vec<String>, String> {
        let _operation = lock(&self.inner.operation)?;
        let config = self.load_config()?;
        let Some(days) = config.retention_days else {
            return Ok(Vec::new());
        };
        let cutoff = now - Duration::days(i64::from(days));
        let mut removed = Vec::new();
        let mut before = None;
        loop {
            let page = self
                .inner
                .store
                .list_meetings_page(before.as_ref(), 250)
                .map_err(|error| error.to_string())?;
            for meeting in &page.meetings {
                if matches!(
                    meeting.status,
                    super::MeetingStatus::Detected
                        | super::MeetingStatus::Recording
                        | super::MeetingStatus::Stopping
                        | super::MeetingStatus::Finalizing
                ) || self
                    .inner
                    .store
                    .has_retention_hold(&meeting.id)
                    .map_err(|error| error.to_string())?
                {
                    continue;
                }
                let transcript = self
                    .inner
                    .store
                    .transcript_overview(&meeting.id, 1)
                    .map_err(|error| error.to_string())?;
                if !transcript.is_final
                    || transcript.segment_count == 0
                    || transcript.non_final_segment_count != 0
                {
                    continue;
                }
                let observed = meeting
                    .finalized_at
                    .as_deref()
                    .or(meeting.stopped_at.as_deref())
                    .unwrap_or(&meeting.updated_at);
                let timestamp = DateTime::parse_from_rfc3339(observed)
                    .map_err(|error| {
                        format!("Meeting '{}' has an invalid timestamp: {error}", meeting.id)
                    })?
                    .with_timezone(&Utc);
                if timestamp <= cutoff {
                    self.inner
                        .store
                        .begin_deletion(&meeting.id, StoreDeletionMode::Audio, &now.to_rfc3339())
                        .map_err(|error| error.to_string())?;
                    self.delete_meeting_files(&meeting.id, MeetingDeleteMode::Audio)?;
                    removed.push(meeting.id.clone());
                }
            }
            if !page.has_more {
                break;
            }
            before = page.next_before;
        }
        Ok(removed)
    }

    /// Replay every incomplete privacy deletion. The independent SQLite
    /// journal survives both file removal and the meeting-row cascade, so an
    /// ordinary launch can resume at the first unfinished durable boundary.
    pub fn recover_pending_deletions(&self) -> Result<Vec<String>, String> {
        let _operation = lock(&self.inner.operation)?;
        let deletions = self
            .inner
            .store
            .pending_deletions()
            .map_err(|error| error.to_string())?;
        let mut completed = Vec::new();
        for deletion in deletions {
            let refreshed = self
                .inner
                .store
                .refresh_deletion(&deletion.meeting_id, &Utc::now().to_rfc3339())
                .map_err(|error| error.to_string())?;
            if refreshed.stage == MeetingDeletionStage::WaitingForJobs {
                continue;
            }
            self.drive_deletion_locked(
                &deletion.meeting_id,
                match deletion.mode {
                    StoreDeletionMode::Audio => MeetingDeleteMode::Audio,
                    StoreDeletionMode::All => MeetingDeleteMode::All,
                },
            )?;
            completed.push(deletion.meeting_id);
        }
        Ok(completed)
    }

    fn load_config(&self) -> Result<MeetingConfig, String> {
        repair_private_file_if_exists(&self.inner.paths.config_file)
            .map_err(|error| format!("Could not secure meeting settings: {error}"))?;
        match load_json_optional_quarantining::<PersistedMeetingConfig>(
            &self.inner.paths.config_file,
        )
        .map_err(|error| error.to_string())?
        {
            QuarantinedLoad::Loaded(config) => Ok(config.config.into()),
            QuarantinedLoad::Missing => Ok(MeetingConfig::default()),
            QuarantinedLoad::Quarantined { path, reason } => {
                push_diagnostic(
                    &self.inner.diagnostics,
                    format!(
                        "Invalid meeting settings were moved to {}: {reason}",
                        path.display()
                    ),
                );
                Ok(MeetingConfig::default())
            }
        }
    }

    fn save_config(&self, config: MeetingConfig) -> Result<(), String> {
        let persisted = PersistedMeetingConfig::new(config)?;
        write_private_json_atomic(&self.inner.paths.config_file, &persisted)
            .map_err(|error| error.to_string())
    }

    fn content_path(&self, meeting_id: &str) -> Result<PathBuf, String> {
        validate_component(meeting_id, "meeting id")?;
        prepare_private_file_path(&self.inner.paths.content_root, format!("{meeting_id}.json"))
            .map_err(|error| format!("Could not resolve private meeting content path: {error}"))
    }

    fn load_content(&self, meeting_id: &str) -> Result<PersistedMeetingContent, String> {
        #[cfg(test)]
        self.inner
            .content_loads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = self.content_path(meeting_id)?;
        match load_json_optional_quarantining::<PersistedMeetingContent>(&path)
            .map_err(|error| error.to_string())?
        {
            QuarantinedLoad::Loaded(content) => Ok(content),
            QuarantinedLoad::Missing => self.default_content(meeting_id),
            QuarantinedLoad::Quarantined {
                path: quarantined,
                reason,
            } => {
                push_diagnostic(
                    &self.inner.diagnostics,
                    format!(
                        "Invalid meeting content was moved to {}: {reason}",
                        quarantined.display()
                    ),
                );
                self.default_content(meeting_id)
            }
        }
    }

    #[cfg(test)]
    fn content_load_count(&self) -> usize {
        self.inner
            .content_loads
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn default_content(&self, meeting_id: &str) -> Result<PersistedMeetingContent, String> {
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        Ok(PersistedMeetingContent {
            schema_version: CONTENT_SCHEMA_VERSION,
            title: Some(meeting.title),
            workspace_path: meeting
                .metadata
                .get("workspacePath")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            source_app: meeting
                .metadata
                .get("sourceApp")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            ..PersistedMeetingContent::default()
        })
    }

    fn save_content(
        &self,
        meeting_id: &str,
        content: &PersistedMeetingContent,
    ) -> Result<(), String> {
        let content_path = self.content_path(meeting_id)?;
        write_private_json_atomic(&content_path, content).map_err(|error| error.to_string())?;
        if content.deleted
            && self
                .inner
                .store
                .deletion(meeting_id)
                .map_err(|error| error.to_string())?
                .is_some_and(|deletion| deletion.mode == StoreDeletionMode::All)
        {
            // The durable deletion journal already hides this content from
            // every indexed reader; the imminent meeting-row cascade scrubs
            // the FTS copy. Do not ask a tombstoned row to accept an update.
            return Ok(());
        }
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        let fingerprint = content_file_fingerprint(&content_path)?;
        self.inner
            .store
            .sync_content_search(
                meeting_id,
                content.title.as_deref().unwrap_or(&meeting.title),
                content.summary.as_deref(),
                &content.tags,
                content.deleted,
                &fingerprint,
            )
            .map_err(|error| format!("Could not synchronize private meeting search: {error}"))
    }

    fn reconcile_content_search(&self) -> Result<(), String> {
        let mut before = None;
        loop {
            let page = self
                .inner
                .store
                .list_meetings_page(before.as_ref(), 250)
                .map_err(|error| {
                    format!("Could not page meetings for private content indexing: {error}")
                })?;
            for meeting in &page.meetings {
                let content_path = self.content_path(&meeting.id)?;
                let observed_fingerprint = content_file_fingerprint(&content_path)?;
                let indexed_fingerprint = self
                    .inner
                    .store
                    .content_search_fingerprint(&meeting.id)
                    .map_err(|error| {
                        format!(
                            "Could not inspect the reviewed-content index for meeting '{}': {error}",
                            meeting.id
                        )
                    })?;
                if indexed_fingerprint.as_deref() == Some(observed_fingerprint.as_str()) {
                    continue;
                }
                let content = self.load_content(&meeting.id)?;
                // A corrupt file may have been quarantined while loading, so
                // fingerprint the post-recovery authority rather than the
                // stale path state observed above.
                let reconciled_fingerprint = content_file_fingerprint(&content_path)?;
                self.inner
                    .store
                    .sync_content_search(
                        &meeting.id,
                        content.title.as_deref().unwrap_or(&meeting.title),
                        content.summary.as_deref(),
                        &content.tags,
                        content.deleted,
                        &reconciled_fingerprint,
                    )
                    .map_err(|error| {
                        format!(
                            "Could not index reviewed content for meeting '{}': {error}",
                            meeting.id
                        )
                    })?;
            }
            if !page.has_more {
                return Ok(());
            }
            before = page.next_before;
        }
    }

    fn delete_meeting_files(
        &self,
        meeting_id: &str,
        mode: MeetingDeleteMode,
    ) -> Result<(), String> {
        let result = self.drive_deletion_locked(meeting_id, mode);
        if let Err(error) = &result {
            if self
                .inner
                .store
                .deletion(meeting_id)
                .ok()
                .flatten()
                .is_some()
            {
                let _ = self.inner.store.record_deletion_error(
                    meeting_id,
                    error,
                    &Utc::now().to_rfc3339(),
                );
            }
        }
        result
    }

    fn drive_deletion_locked(
        &self,
        meeting_id: &str,
        mode: MeetingDeleteMode,
    ) -> Result<(), String> {
        validate_component(meeting_id, "meeting id")?;
        let expected_mode = match mode {
            MeetingDeleteMode::Audio => StoreDeletionMode::Audio,
            MeetingDeleteMode::All => StoreDeletionMode::All,
        };
        let mut deletion = self
            .inner
            .store
            .deletion(meeting_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                "Meeting deletion must be registered in the durable journal before files are removed"
                    .to_string()
            })?;
        if deletion.mode != expected_mode {
            return Err(format!(
                "Meeting deletion mode changed from {} to {}",
                match deletion.mode {
                    StoreDeletionMode::Audio => "audio",
                    StoreDeletionMode::All => "all",
                },
                match expected_mode {
                    StoreDeletionMode::Audio => "audio",
                    StoreDeletionMode::All => "all",
                }
            ));
        }
        deletion = self
            .inner
            .store
            .refresh_deletion(meeting_id, &Utc::now().to_rfc3339())
            .map_err(|error| error.to_string())?;
        if deletion.stage == MeetingDeletionStage::WaitingForJobs {
            return Err(format!(
                "Meeting deletion is waiting for {} running follow-up job(s) to finish",
                deletion.running_jobs
            ));
        }

        let meeting_root = safe_direct_child(&self.inner.paths.meetings_root, meeting_id)?;
        if deletion.stage == MeetingDeletionStage::FilesPending {
            if mode == MeetingDeleteMode::All {
                self.persist_deleted_content_marker(meeting_id)?;
                self.maybe_fail_deletion("after-content-hidden")?;
                remove_path_without_following(&meeting_root)?;
                sync_directory(&self.inner.paths.meetings_root)?;
            } else {
                for name in ["audio", "microphone", "system"] {
                    remove_path_without_following(&meeting_root.join(name))?;
                }
                for name in [
                    "recording.wav",
                    "recording.flac",
                    "recording.m4a",
                    "recording.aac",
                ] {
                    remove_path_without_following(&meeting_root.join(name))?;
                }
                if meeting_root.exists() {
                    sync_directory(&meeting_root)?;
                }
            }
            self.maybe_fail_deletion("after-files-removed")?;
            deletion = self
                .inner
                .store
                .mark_deletion_files_removed(meeting_id, &Utc::now().to_rfc3339())
                .map_err(|error| error.to_string())?;
            self.maybe_fail_deletion("after-files-stage")?;
        }

        if deletion.stage == MeetingDeletionStage::DatabasePending {
            deletion = self
                .inner
                .store
                .remove_deletion_database_authority(meeting_id, &Utc::now().to_rfc3339())
                .map_err(|error| error.to_string())?;
            self.maybe_fail_deletion("after-database-removed")?;
        }

        if deletion.stage == MeetingDeletionStage::MarkerCleanupPending {
            if mode == MeetingDeleteMode::All {
                remove_path_without_following(&self.content_path(meeting_id)?)?;
                sync_directory(&self.inner.paths.content_root)?;
            }
            self.maybe_fail_deletion("after-marker-cleanup")?;
            self.inner
                .store
                .complete_deletion(meeting_id)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn persist_deleted_content_marker(&self, meeting_id: &str) -> Result<(), String> {
        let path = self.content_path(meeting_id)?;
        let mut content = match load_json_optional_quarantining::<PersistedMeetingContent>(&path)
            .map_err(|error| error.to_string())?
        {
            QuarantinedLoad::Loaded(content) => content,
            QuarantinedLoad::Missing | QuarantinedLoad::Quarantined { .. } => {
                PersistedMeetingContent::default()
            }
        };
        content.deleted = true;
        self.save_content(meeting_id, &content)?;
        sync_directory(&self.inner.paths.content_root)
    }

    fn maybe_fail_deletion(&self, point: &'static str) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut fault = lock(&self.inner.deletion_fault)?;
            if fault
                .as_ref()
                .is_some_and(|configured| *configured == point)
            {
                fault.take();
                return Err(format!("injected deletion fault at {point}"));
            }
        }
        #[cfg(not(test))]
        let _ = point;
        Ok(())
    }

    #[cfg(test)]
    fn inject_deletion_fault(&self, point: &'static str) {
        *self.inner.deletion_fault.lock().unwrap() = Some(point);
    }

    fn export_markdown(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        let transcript = self
            .inner
            .store
            .transcript_snapshot(meeting_id, None)
            .map_err(|error| error.to_string())?;
        let content = self.load_content(meeting_id)?;
        let title = content.title.as_deref().unwrap_or(&meeting.title);
        let mut markdown = format!("# {}\n\n", escape_markdown_heading(title));
        if let Some(summary) = content.summary.as_deref() {
            markdown.push_str("## Summary\n\n");
            markdown.push_str(summary.trim());
            markdown.push_str("\n\n");
        }
        if !content.tags.is_empty() {
            markdown.push_str("Tags: ");
            markdown.push_str(
                &content
                    .tags
                    .iter()
                    .map(|tag| format!("`{}`", tag.replace('`', "\\`")))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            markdown.push_str("\n\n");
        }
        markdown.push_str("## Transcript\n\n");
        for segment in transcript.segments {
            let speaker = segment
                .segment
                .speaker
                .as_deref()
                .or(segment.segment.channel_id.as_deref())
                .unwrap_or("Speaker");
            markdown.push_str(&format!(
                "**{} · {}**  \n{}\n\n",
                format_timestamp(segment.segment.start_ms),
                speaker,
                segment.segment.text.trim()
            ));
        }
        if !transcript.gaps.is_empty() {
            markdown.push_str("## Recording gaps\n\n");
            for gap in transcript.gaps {
                markdown.push_str(&format!(
                    "- {}–{}: {}\n",
                    format_timestamp(gap.gap.start_ms),
                    format_timestamp(gap.gap.end_ms),
                    gap.gap.reason
                ));
            }
        }
        let path = self.unique_export_path(meeting_id, "md")?;
        write_private_bytes_atomic(&path, markdown.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(MeetingExport {
            format: "markdown".into(),
            path: path.to_string_lossy().into_owned(),
        })
    }

    fn export_json(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        let transcript = self
            .inner
            .store
            .transcript_snapshot(meeting_id, None)
            .map_err(|error| error.to_string())?;
        let content = self.load_content(meeting_id)?;
        let document = serde_json::json!({
            "schemaVersion": 1,
            "meeting": meeting,
            "content": content,
            "transcript": transcript,
        });
        let path = self.unique_export_path(meeting_id, "json")?;
        write_private_json_atomic(&path, &document).map_err(|error| error.to_string())?;
        Ok(MeetingExport {
            format: "json".into(),
            path: path.to_string_lossy().into_owned(),
        })
    }

    fn export_audio(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        validate_component(meeting_id, "meeting id")?;
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        if matches!(
            meeting.status,
            super::MeetingStatus::Detected
                | super::MeetingStatus::Recording
                | super::MeetingStatus::Stopping
                | super::MeetingStatus::Finalizing
        ) {
            return Err(
                "Audio export requires the meeting recording to be stopped and finalized".into(),
            );
        }
        let source_root = safe_direct_child(&self.inner.paths.meetings_root, meeting_id)?;
        if !source_root.exists() {
            return Err(format!(
                "Meeting '{meeting_id}' has no recorded audio artifacts to export"
            ));
        }
        reject_symlink(&source_root)?;
        let export_name = format!("{meeting_id}-audio-{}", Uuid::new_v4());
        let final_path = safe_direct_child(&self.inner.paths.exports_root, &export_name)?;
        let pending_path = safe_direct_child(
            &self.inner.paths.exports_root,
            &format!(".{export_name}.part"),
        )?;
        create_private_new_directory(&pending_path)?;
        let mut pending_guard = PendingPath::directory(pending_path.clone());
        let mut copied = 0_u64;
        for name in ["audio", "microphone", "system"] {
            copied +=
                copy_path_without_symlinks(&source_root.join(name), &pending_path.join(name))?;
        }
        for name in [
            "recording.wav",
            "recording.flac",
            "recording.m4a",
            "recording.aac",
        ] {
            copied +=
                copy_path_without_symlinks(&source_root.join(name), &pending_path.join(name))?;
        }
        if copied == 0 {
            let _ = fs::remove_dir_all(&pending_path);
            return Err(format!(
                "Meeting '{meeting_id}' has no recorded audio artifacts to export"
            ));
        }
        sync_tree(&pending_path)?;
        fs::rename(&pending_path, &final_path)
            .map_err(|error| format!("Could not atomically publish audio export: {error}"))?;
        pending_guard.disarm();
        sync_directory(&self.inner.paths.exports_root)?;
        Ok(MeetingExport {
            format: "audio".into(),
            path: final_path.to_string_lossy().into_owned(),
        })
    }

    fn unique_export_path(&self, meeting_id: &str, extension: &str) -> Result<PathBuf, String> {
        validate_component(meeting_id, "meeting id")?;
        validate_component(extension, "export extension")?;
        let name = format!("{meeting_id}-{}.{}", Uuid::new_v4(), extension);
        prepare_private_file_path(&self.inner.paths.exports_root, name)
            .map_err(|error| format!("Could not resolve private meeting export path: {error}"))
    }
}

impl MeetingPlatformPort for NativeMeetingPlatform {
    fn projection(&self) -> Result<MeetingPlatformProjection, String> {
        let mut config = self.load_config()?;
        config.api_key_configured = configured_custom_stt_endpoint(&config)?
            .map(|endpoint| self.inner.secrets.read(&endpoint))
            .transpose()?
            .flatten()
            .is_some();
        let environment = self.inner.environment.projection()?;
        let mut diagnostics = lock(&self.inner.diagnostics)?.clone();
        if let Some(diagnostic) = environment.diagnostic {
            diagnostics.push(diagnostic);
        }
        diagnostics.sort();
        diagnostics.dedup();
        Ok(MeetingPlatformProjection {
            config,
            permissions: environment.permissions,
            candidates: environment.candidates,
            models: self.inner.models.projection()?,
            diagnostic: (!diagnostics.is_empty()).then(|| diagnostics.join("\n")),
        })
    }

    fn dismiss_candidate(&self, candidate_id: &str) -> Result<(), String> {
        self.inner.environment.dismiss_candidate(candidate_id)?;
        self.inner.changes.changed("detection");
        Ok(())
    }

    fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String> {
        let content = self.load_content(meeting_id)?;
        Ok(MeetingContentProjection {
            title: content.title,
            summary: content.summary,
            tags: content.tags,
            workspace_path: content.workspace_path,
            source_app: content.source_app,
            kg_decision: content.kg_decision,
            deleted: content.deleted,
        })
    }

    fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        let previous_config = self.load_config()?;
        let mut config = previous_config.clone();
        let previous_endpoint = stored_custom_stt_endpoint(&previous_config)?;
        if let Some(value) = patch.detection_enabled {
            config.detection_enabled = value;
        }
        if let Some(value) = patch.auto_record {
            config.auto_record = value;
        }
        if let Some(value) = &patch.transcription_mode {
            config.transcription_mode = value.trim().to_string();
        }
        if let Some(value) = &patch.custom_url {
            config.custom_url = value.trim().to_string();
        }
        if let Some(value) = &patch.custom_model {
            config.custom_model = value.trim().to_string();
        }
        if let Some(value) = &patch.local_model {
            config.local_model = value.trim().to_string();
        }
        if let Some(value) = patch.summary_enabled {
            config.summary_enabled = value;
        }
        if let Some(value) = &patch.summary_preset {
            config.summary_preset = value.trim().to_string();
        }
        if let Some(value) = &patch.kg_prompt {
            config.kg_prompt = value.trim().to_string();
        }
        if let Some(value) = &patch.kg_preset {
            config.kg_preset = value.trim().to_string();
        }
        if let Some(value) = patch.retention_days {
            config.retention_days = value;
        }
        validate_meeting_config(&config)?;
        let next_endpoint = stored_custom_stt_endpoint(&config)?;
        let detection_changed = previous_config.detection_enabled != config.detection_enabled;
        if detection_changed {
            self.inner
                .environment
                .set_detection_enabled(config.detection_enabled)
                .map_err(|error| bounded_diagnostic(&error))?;
        }
        let persist = (|| {
            if previous_endpoint != next_endpoint {
                // Clear before publishing the route. If Keychain access
                // fails, the old configuration remains authoritative and no
                // new endpoint can receive the old secret. Losing a secret
                // after a later atomic config-write failure is safe and
                // explicit re-entry repairs it.
                self.inner.secrets.clear()?;
            }
            self.save_config(config)
        })();
        if let Err(error) = persist {
            if detection_changed {
                if let Err(rollback) = self
                    .inner
                    .environment
                    .set_detection_enabled(previous_config.detection_enabled)
                {
                    return Err(bounded_diagnostic(&format!(
                        "{error}; meeting detection rollback also failed: {rollback}"
                    )));
                }
            }
            return Err(error);
        }
        Ok(())
    }

    fn set_api_key(&self, api_key: &str) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        let secret = api_key.trim();
        if secret.is_empty() {
            return Err("Meeting transcription API key cannot be empty".into());
        }
        if secret.len() > MAX_API_KEY_BYTES || secret.chars().any(char::is_control) {
            return Err("Meeting transcription API key is invalid or too large".into());
        }
        let config = self.load_config()?;
        let endpoint = configured_custom_stt_endpoint(&config)?.ok_or_else(|| {
            "Select a valid custom transcription endpoint before saving its API key".to_string()
        })?;
        self.inner.secrets.set(&endpoint, secret)
    }

    fn clear_api_key(&self) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        self.inner.secrets.clear()
    }

    fn install_model(&self, model_id: &str) -> Result<(), String> {
        self.inner.models.install(model_id)
    }

    fn delete_model(&self, model_id: &str) -> Result<(), String> {
        self.inner.models.delete(model_id)
    }

    fn update_content(&self, meeting_id: &str, patch: &MeetingUpdatePatch) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        if self
            .inner
            .store
            .deletion(meeting_id)
            .map_err(|error| error.to_string())?
            .is_some_and(|deletion| deletion.mode == StoreDeletionMode::All)
        {
            return Err(format!(
                "Meeting '{meeting_id}' is being permanently deleted"
            ));
        }
        let mut content = self.load_content(meeting_id)?;
        if content.deleted {
            return Err(format!("Meeting '{meeting_id}' has been deleted"));
        }
        if let Some(value) = &patch.title {
            content.title = Some(value.trim().to_string());
        }
        if let Some(value) = &patch.summary {
            content.summary = Some(value.trim().to_string());
        }
        if let Some(value) = &patch.tags {
            content.tags = value.iter().map(|tag| tag.trim().to_string()).collect();
        }
        validate_content_fields(
            content.title.as_deref(),
            content.summary.as_deref(),
            &content.tags,
            content.kg_decision.as_deref(),
        )?;
        self.save_content(meeting_id, &content)
    }

    fn set_kg_decision(&self, meeting_id: &str, decision: &str) -> Result<(), String> {
        if !matches!(decision, "create-draft" | "not-now" | "never") {
            return Err("Knowledge-graph decision must be create-draft, not-now, or never".into());
        }
        let _operation = lock(&self.inner.operation)?;
        if self
            .inner
            .store
            .deletion(meeting_id)
            .map_err(|error| error.to_string())?
            .is_some_and(|deletion| deletion.mode == StoreDeletionMode::All)
        {
            return Err(format!(
                "Meeting '{meeting_id}' is being permanently deleted"
            ));
        }
        let mut content = self.load_content(meeting_id)?;
        if content.deleted {
            return Err(format!("Meeting '{meeting_id}' has been deleted"));
        }
        content.kg_decision = Some(decision.into());
        self.save_content(meeting_id, &content)
    }

    fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        self.delete_meeting_files(meeting_id, mode)
    }

    fn export_meeting(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, String> {
        let _operation = lock(&self.inner.operation)?;
        match format {
            MeetingExportFormat::Markdown => self.export_markdown(meeting_id),
            MeetingExportFormat::Json => self.export_json(meeting_id),
            MeetingExportFormat::Audio => self.export_audio(meeting_id),
        }
    }
}

fn validate_meeting_config(config: &MeetingConfig) -> Result<(), String> {
    if config.auto_record {
        return Err(
            "Automatic meeting recording is disabled; every recording requires explicit human consent"
                .into(),
        );
    }
    if config.local_model.trim() != config.local_model || config.local_model.is_empty() {
        return Err("Local meeting model cannot be empty or padded with whitespace".into());
    }
    ConfigIdentifier::new(config.local_model.clone(), "local model id")
        .map_err(|error| error.to_string())?;
    match config.transcription_mode.as_str() {
        "local" => {}
        "custom" => {
            if config.custom_url.is_empty() {
                return Err("Custom meeting transcription URL cannot be empty".into());
            }
            validate_custom_https_url(&config.custom_url)?;
            ConfigIdentifier::new(config.custom_model.clone(), "custom model id")
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("Meeting transcription mode must be local or custom".into()),
    }
    if !config.custom_url.is_empty() {
        validate_custom_https_url(&config.custom_url)?;
    }
    if !config.custom_model.is_empty() {
        ConfigIdentifier::new(config.custom_model.clone(), "custom model id")
            .map_err(|error| error.to_string())?;
    }
    for (label, value) in [
        ("summary preset", config.summary_preset.as_str()),
        ("knowledge-graph preset", config.kg_preset.as_str()),
    ] {
        if !value.is_empty() {
            ConfigIdentifier::new(value.to_string(), label).map_err(|error| error.to_string())?;
        }
    }
    if !matches!(config.kg_prompt.as_str(), "ask" | "always-draft" | "never") {
        return Err("Knowledge-graph follow-up must be ask, always-draft, or never".into());
    }
    if config
        .retention_days
        .is_some_and(|days| !(1..=3_650).contains(&days))
    {
        return Err("Meeting retention must be between 1 and 3650 days".into());
    }
    Ok(())
}

fn validate_custom_https_url(raw: &str) -> Result<(), String> {
    custom_stt_endpoint_from_https_url(raw).map(|_| ())
}

fn configured_custom_stt_endpoint(
    config: &MeetingConfig,
) -> Result<Option<CustomSttEndpoint>, String> {
    if config.transcription_mode != "custom" {
        return Ok(None);
    }
    stored_custom_stt_endpoint(config)
}

fn stored_custom_stt_endpoint(config: &MeetingConfig) -> Result<Option<CustomSttEndpoint>, String> {
    if config.custom_url.is_empty() {
        return Ok(None);
    }
    custom_stt_endpoint_from_https_url(&config.custom_url).map(Some)
}

fn custom_stt_endpoint_from_https_url(raw: &str) -> Result<CustomSttEndpoint, String> {
    let parsed = Url::parse(raw)
        .map_err(|_| "Custom meeting transcription URL is not a valid absolute URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Custom meeting transcription URL must use HTTPS".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Custom meeting transcription URL requires a public hostname".to_string())?
        .to_string();
    let mut websocket = parsed;
    websocket
        .set_scheme("wss")
        .map_err(|_| "Custom meeting transcription URL must use HTTPS".to_string())?;
    CustomSttEndpoint::new(websocket.as_str(), &host)
        .map_err(|error| format!("Unsafe custom meeting transcription URL: {error}"))
}

fn validate_content_fields(
    title: Option<&str>,
    summary: Option<&str>,
    tags: &[String],
    kg_decision: Option<&str>,
) -> Result<(), String> {
    if let Some(title) = title {
        if title.trim().is_empty() || title.chars().count() > 512 {
            return Err("Meeting title must contain 1 to 512 characters".into());
        }
    }
    if summary.is_some_and(|value| value.len() > MAX_SUMMARY_BYTES) {
        return Err("Meeting summary exceeds the 4 MiB safety limit".into());
    }
    if tags.len() > MAX_TAGS
        || tags.iter().any(|tag| {
            tag.trim().is_empty() || tag.len() > MAX_TAG_BYTES || tag.chars().any(char::is_control)
        })
    {
        return Err("Meeting tags exceed the count, length, or character safety limit".into());
    }
    if kg_decision.is_some_and(|decision| !matches!(decision, "create-draft" | "not-now" | "never"))
    {
        return Err("Invalid persisted knowledge-graph decision".into());
    }
    Ok(())
}

fn validate_component(value: &str, label: &'static str) -> Result<(), String> {
    ConfigIdentifier::new(value.to_string(), label)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn secure_platform_paths(paths: &MeetingPlatformPaths) -> Result<(), String> {
    let config_root = paths
        .config_file
        .parent()
        .ok_or_else(|| "Meeting settings path has no private parent directory".to_string())?;
    ensure_private_directory(config_root)
        .map_err(|error| format!("Could not secure Mimir's private data directory: {error}"))?;

    for directory in [
        &paths.meetings_root,
        &paths.content_root,
        &paths.exports_root,
        &paths.models_root,
    ] {
        let relative = directory.strip_prefix(config_root).map_err(|_| {
            format!(
                "Managed Scribe directory {} is outside its private root",
                directory.display()
            )
        })?;
        ensure_private_subdirectory(config_root, relative).map_err(|error| {
            format!(
                "Could not secure managed Scribe directory {}: {error}",
                directory.display()
            )
        })?;
    }

    repair_private_file_if_exists(&paths.config_file)
        .map_err(|error| format!("Could not repair meeting settings permissions: {error}"))?;
    repair_private_tree(&paths.meetings_root)
        .map_err(|error| format!("Could not repair private meeting storage: {error}"))?;
    repair_private_tree(&paths.models_root)
        .map_err(|error| format!("Could not repair private model storage: {error}"))?;
    Ok(())
}

fn safe_direct_child(root: &Path, child: &str) -> Result<PathBuf, String> {
    validate_component(child, "path component")?;
    reject_symlink(root)?;
    // ConfigIdentifier permits no separators or traversal components, so this
    // is exactly one lexical child of the already checked managed root.
    Ok(root.join(child))
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to use symbolic link at managed meeting path {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

fn remove_path_without_following(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to delete symbolic link at managed meeting path {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|error| format!("Could not delete {}: {error}", path.display()))
}

fn collect_model_partials(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".model-") || !name.ends_with(".part") {
            continue;
        }
        if entry
            .file_type()
            .map(|kind| kind.is_file() || kind.is_symlink())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn copy_path_without_symlinks(source: &Path, destination: &Path) -> Result<u64, String> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not inspect {}: {error}", source.display())),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to export symbolic link from managed meeting path {}",
            source.display()
        ));
    }
    if metadata.is_file() {
        repair_private_file(source)
            .map_err(|error| format!("Could not secure source audio artifact: {error}"))?;
        if let Some(parent) = destination.parent() {
            ensure_private_directory(parent).map_err(|error| {
                format!("Could not secure private audio export directory: {error}")
            })?;
        }
        let mut input =
            File::open(source).map_err(|error| format!("Could not read audio export: {error}"))?;
        let mut output = create_private_new_file(destination)?;
        let copied = io::copy(&mut input, &mut output)
            .map_err(|error| format!("Could not copy audio export: {error}"))?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("Could not durably flush audio export: {error}"))?;
        return Ok(copied);
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Unsupported file type in meeting audio export: {}",
            source.display()
        ));
    }
    create_private_new_directory(destination)?;
    let mut copied = 0_u64;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("Could not read meeting audio directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read meeting audio directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        if Path::new(&name).components().count() != 1 {
            return Err("Invalid filename in meeting audio directory".into());
        }
        copied += copy_path_without_symlinks(&entry.path(), &destination.join(name))?;
    }
    Ok(copied)
}

struct PendingPath {
    path: PathBuf,
    directory: bool,
    armed: bool,
}

impl PendingPath {
    fn file(path: PathBuf) -> Self {
        Self {
            path,
            directory: false,
            armed: true,
        }
    }

    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            directory: true,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingPath {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if self.directory {
            let _ = fs::remove_dir_all(&self.path);
        } else {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn create_private_new_file(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Private file {} has no parent directory", path.display()))?;
    ensure_private_directory(parent)
        .map_err(|error| format!("Could not secure private file parent: {error}"))?;
    repair_private_file_if_exists(path)
        .map_err(|error| format!("Refusing unsafe private file path: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

fn create_private_new_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Private directory {} has no parent", path.display()))?;
    ensure_private_directory(parent)
        .map_err(|error| format!("Could not secure private directory parent: {error}"))?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| {
        format!(
            "Could not create private directory {}: {error}",
            path.display()
        )
    })?;
    ensure_private_directory(path).map_err(|error| {
        format!(
            "Could not secure private directory {}: {error}",
            path.display()
        )
    })
}

fn sync_tree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Could not inspect export staging directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect export staging entry: {error}"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| format!("Could not inspect export staging entry: {error}"))?;
        if metadata.is_symlink() {
            return Err("Symbolic link appeared in audio export staging directory".into());
        }
        if metadata.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            File::open(entry.path())
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Could not sync audio export file: {error}"))?;
        }
    }
    sync_directory(path)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync directory {}: {error}", path.display()))
}

fn escape_markdown_heading(value: &str) -> String {
    value.replace(['\n', '\r'], " ").trim().to_string()
}

fn format_timestamp(milliseconds: i64) -> String {
    let milliseconds = milliseconds.max(0) as u64;
    let seconds = milliseconds / 1_000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn content_file_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => {
            return Err(format!(
                "Could not inspect private meeting content: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Private meeting content must be a regular file".into());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("Could not inspect private meeting content timestamp: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Private meeting content has an invalid timestamp".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "v1:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos()
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(format!(
            "v1:{}:{}:{}",
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos()
        ))
    }
}

fn push_diagnostic(diagnostics: &Mutex<Vec<String>>, diagnostic: String) {
    if let Ok(mut values) = diagnostics.lock() {
        if !values.contains(&diagnostic) {
            values.push(diagnostic);
        }
    }
}

fn bounded_diagnostic(value: &str) -> String {
    let mut characters = value.chars();
    let mut bounded = characters
        .by_ref()
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        bounded.push('…');
    }
    bounded
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Meeting platform mutex was poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::{
        native::EndpointBoundMeetingCredentialResolver, transcriber::MeetingCredentialResolver,
        AudioChannelDraft, AudioChannelKind, MeetingDraft, MeetingOrigin, TranscriptBatch,
        TranscriptChange, TranscriptSegmentInput,
    };
    use serde_json::json;
    use std::{
        io::Cursor,
        sync::{Condvar, Mutex},
        time::Duration as StdDuration,
    };
    use tempfile::TempDir;

    const NOW: &str = "2026-07-30T10:00:00Z";

    #[derive(Default)]
    struct FakeSecrets(Mutex<Option<(String, String)>>);

    impl MeetingSecretStore for FakeSecrets {
        fn read(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .as_ref()
                .filter(|(binding, _)| binding == &endpoint.credential_binding())
                .map(|(_, secret)| secret.clone()))
        }

        fn set(&self, endpoint: &CustomSttEndpoint, secret: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some((endpoint.credential_binding(), secret.to_string()));
            Ok(())
        }

        fn clear(&self) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
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
        completion: Arc<(Mutex<bool>, Condvar)>,
    }

    fn fixture() -> Fixture {
        fixture_with_environment(Arc::new(FakeEnvironment))
    }

    fn fixture_with_environment(environment: Arc<dyn MeetingEnvironmentProbe>) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
        fs::create_dir_all(&paths.meetings_root).unwrap();
        let store =
            Arc::new(MeetingStore::open(paths.meetings_root.join("meetings.sqlite")).unwrap());
        let model_bytes = b"verified managed model".to_vec();
        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        let platform = NativeMeetingPlatform::new(
            paths.clone(),
            store.clone(),
            vec![MeetingModelCatalogEntry {
                title: "Whisper Small".into(),
                manifest: manifest(&model_bytes),
            }],
            Arc::new(FakeSecrets::default()),
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

    #[cfg(unix)]
    #[test]
    fn platform_startup_repairs_legacy_private_trees_and_refuses_symlink_components() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
        let content_nested = paths.content_root.join("legacy");
        let export_nested = paths.exports_root.join("legacy");
        let model_nested = paths.models_root.join("whisper-small/test-1");
        for path in [&content_nested, &export_nested, &model_nested] {
            fs::create_dir_all(path).unwrap();
        }
        let config = PersistedMeetingConfig::new(MeetingConfig::default()).unwrap();
        fs::write(&paths.config_file, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::write(content_nested.join("meeting.json"), b"legacy content").unwrap();
        fs::write(export_nested.join("transcript.md"), b"legacy export").unwrap();
        fs::write(model_nested.join("model.bin"), b"legacy model").unwrap();
        fs::write(
            &paths.model_state_file,
            serde_json::to_vec(&PersistedModelState::default()).unwrap(),
        )
        .unwrap();

        for path in [
            directory.path(),
            &paths.meetings_root,
            &paths.content_root,
            &content_nested,
            &paths.exports_root,
            &export_nested,
            paths.models_root.parent().unwrap(),
            &paths.models_root,
            model_nested.parent().unwrap(),
            &model_nested,
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        for path in [
            &paths.config_file,
            &content_nested.join("meeting.json"),
            &export_nested.join("transcript.md"),
            &paths.model_state_file,
            &model_nested.join("model.bin"),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
        }

        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        NativeMeetingPlatform::new(
            paths.clone(),
            Arc::new(MeetingStore::open_in_memory().unwrap()),
            Vec::new(),
            Arc::new(FakeSecrets::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeDisk),
            Arc::new(FakeDownloader {
                bytes: Vec::new(),
                completion,
            }),
            Arc::new(NoopMeetingPlatformChangeSink),
        )
        .unwrap();

        for path in [
            directory.path(),
            &paths.meetings_root,
            &paths.content_root,
            &content_nested,
            &paths.exports_root,
            &export_nested,
            paths.models_root.parent().unwrap(),
            &paths.models_root,
            model_nested.parent().unwrap(),
            &model_nested,
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700,
                "{} was not repaired owner-only",
                path.display()
            );
        }
        for path in [
            &paths.config_file,
            &content_nested.join("meeting.json"),
            &export_nested.join("transcript.md"),
            &paths.model_state_file,
            &model_nested.join("model.bin"),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600,
                "{} was not repaired owner-only",
                path.display()
            );
        }

        let unsafe_root = directory.path().join("unsafe-profile");
        fs::create_dir(&unsafe_root).unwrap();
        fs::create_dir(unsafe_root.join("models")).unwrap();
        let outside = directory.path().join("outside-models");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, unsafe_root.join("models/stt")).unwrap();
        let unsafe_paths = MeetingPlatformPaths::from_mimir_root(&unsafe_root);
        let error = NativeMeetingPlatform::new(
            unsafe_paths,
            Arc::new(MeetingStore::open_in_memory().unwrap()),
            Vec::new(),
            Arc::new(FakeSecrets::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeDisk),
            Arc::new(FakeDownloader {
                bytes: Vec::new(),
                completion: Arc::new((Mutex::new(false), Condvar::new())),
            }),
            Arc::new(NoopMeetingPlatformChangeSink),
        )
        .err()
        .expect("a symlinked managed model root must be refused");
        assert!(error.contains("symbolic link") || error.contains("private managed path"));
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn config_is_atomic_quarantined_and_custom_urls_are_strict() {
        let fixture = fixture();
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                transcription_mode: Some("custom".into()),
                custom_url: Some("https://stt.example.com/v1/listen".into()),
                custom_model: Some("nova-2".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        let stored = fs::read_to_string(&fixture.paths.config_file).unwrap();
        assert!(!stored.contains("apiKey"));
        assert_eq!(
            fixture.platform.projection().unwrap().config.custom_model,
            "nova-2"
        );
        assert_eq!(
            fixture
                .platform
                .custom_stt_endpoint()
                .unwrap()
                .unwrap()
                .as_str(),
            "wss://stt.example.com/v1/listen"
        );

        assert!(fixture
            .platform
            .update_config(&MeetingConfigPatch {
                custom_url: Some("https://127.0.0.1/listen".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap_err()
            .contains("Unsafe"));

        fs::write(&fixture.paths.config_file, b"{not json").unwrap();
        let projection = fixture.platform.projection().unwrap();
        assert_eq!(projection.config.transcription_mode, "local");
        assert!(projection.diagnostic.unwrap().contains("moved"));
        let quarantined = fs::read_dir(fixture.paths.config_file.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined);
    }

    #[test]
    fn durable_detection_setting_is_applied_at_startup_and_after_updates() {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let fixture = fixture_with_environment(Arc::new(TrackingEnvironment {
            detection_updates: Arc::clone(&updates),
        }));

        assert_eq!(*updates.lock().unwrap(), vec![false]);
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                detection_enabled: Some(true),
                ..MeetingConfigPatch::default()
            })
            .unwrap();

        assert_eq!(*updates.lock().unwrap(), vec![false, true]);
    }

    #[test]
    fn builtin_model_manifest_pins_revision_size_and_sha256() {
        let catalog = builtin_model_catalog().unwrap();
        assert_eq!(catalog.len(), 1);
        let manifest = &catalog[0].manifest;
        assert_eq!(manifest.model_id.as_str(), "whisper-small");
        assert_eq!(manifest.artifact_bytes, 487_601_967);
        assert_eq!(
            manifest.sha256.to_string(),
            "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
        );
        assert!(manifest
            .download_url
            .as_str()
            .contains("/c521a4b02f422512d734391fdf08bb08c0862f68/"));
        assert!(!manifest.download_url.as_str().contains("/main/"));
    }

    #[test]
    fn credentials_never_enter_config_or_content_files() {
        let fixture = fixture();
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                transcription_mode: Some("custom".into()),
                custom_url: Some("https://stt.example.com/v1/listen".into()),
                custom_model: Some("nova-2".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        fixture.platform.set_api_key("secret-value").unwrap();
        assert!(
            fixture
                .platform
                .projection()
                .unwrap()
                .config
                .api_key_configured
        );
        for path in [&fixture.paths.config_file, &fixture.paths.model_state_file] {
            if let Ok(bytes) = fs::read(path) {
                assert!(!String::from_utf8_lossy(&bytes).contains("secret-value"));
            }
        }
        fixture.platform.clear_api_key().unwrap();
        assert!(
            !fixture
                .platform
                .projection()
                .unwrap()
                .config
                .api_key_configured
        );
    }

    #[test]
    fn endpoint_bound_keychain_payload_rejects_legacy_and_mismatched_authority() {
        let endpoint_a =
            custom_stt_endpoint_from_https_url("https://a.example.com/v1/listen").unwrap();
        let endpoint_b =
            custom_stt_endpoint_from_https_url("https://b.example.com/v1/listen").unwrap();
        let encoded = encode_endpoint_bound_secret(&endpoint_a, "native-secret").unwrap();

        assert_eq!(
            decode_endpoint_bound_secret(&encoded, &endpoint_a).as_deref(),
            Some("native-secret")
        );
        assert_eq!(decode_endpoint_bound_secret(&encoded, &endpoint_b), None);
        assert_eq!(
            decode_endpoint_bound_secret("legacy-unbound-secret", &endpoint_a),
            None
        );
        assert!(!encoded.contains(endpoint_a.as_str()));
    }

    #[test]
    fn changing_custom_endpoint_invalidates_keychain_secret() {
        let fixture = fixture();
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                transcription_mode: Some("custom".into()),
                custom_url: Some("https://STT.example.com:443/v1/listen".into()),
                custom_model: Some("nova-2".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        fixture.platform.set_api_key("endpoint-a-secret").unwrap();
        let endpoint_a = fixture.platform.custom_stt_endpoint().unwrap().unwrap();

        // A spelling-only change preserves the same canonical authority.
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                custom_url: Some("https://stt.example.com/v1/listen".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        assert_eq!(
            fixture
                .platform
                .custom_api_key_for(&endpoint_a)
                .unwrap()
                .as_deref(),
            Some("endpoint-a-secret")
        );

        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                custom_url: Some("https://other.example.com/v1/listen".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        assert!(
            !fixture
                .platform
                .projection()
                .unwrap()
                .config
                .api_key_configured
        );
        assert!(fixture
            .platform
            .custom_api_key_for(&endpoint_a)
            .unwrap_err()
            .contains("changed"));
    }

    #[test]
    fn endpoint_b_receives_no_authorization_before_key_reentry() {
        let fixture = fixture();
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                transcription_mode: Some("custom".into()),
                custom_url: Some("https://a.example.com/v1/listen".into()),
                custom_model: Some("nova-2".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        fixture.platform.set_api_key("endpoint-a-secret").unwrap();
        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                custom_url: Some("https://b.example.com/v1/listen".into()),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        let endpoint_b = fixture.platform.custom_stt_endpoint().unwrap().unwrap();
        let resolver =
            EndpointBoundMeetingCredentialResolver::new(Arc::new(fixture.platform.clone()));

        assert_eq!(resolver.bearer_token(&endpoint_b).unwrap(), None);
        fixture.platform.set_api_key("endpoint-b-secret").unwrap();
        assert_eq!(
            resolver.bearer_token(&endpoint_b).unwrap().as_deref(),
            Some("endpoint-b-secret")
        );
    }

    #[test]
    fn auto_record_true_is_rejected_by_native_configuration() {
        let fixture = fixture();
        let error = fixture
            .platform
            .update_config(&MeetingConfigPatch {
                auto_record: Some(true),
                ..MeetingConfigPatch::default()
            })
            .unwrap_err();
        assert!(error.contains("explicit human consent"));
        assert!(!fixture.platform.projection().unwrap().config.auto_record);
    }

    #[test]
    fn model_download_diagnostics_redact_signed_redirect_queries() {
        let fixture = fixture();
        fixture.platform.inner.models.record_install_failure(
            "whisper-small",
            "Managed model download failed for https://cdn.example/model?token=SECRET_QUERY",
        );

        let diagnostic = fixture.platform.projection().unwrap().diagnostic.unwrap();
        assert!(diagnostic.contains("download did not complete"));
        assert!(!diagnostic.contains("SECRET_QUERY"));
        assert!(!diagnostic.contains("token="));
        assert!(!diagnostic.contains("https://"));
    }

    #[test]
    fn content_round_trips_and_export_uses_authoritative_transcript() {
        let fixture = fixture();
        create_meeting(&fixture, "meeting-1");
        fixture
            .store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: "meeting-1".into(),
                batch_id: "batch-1".into(),
                base_revision: 0,
                source: "test".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "segment-1".into(),
                        start_ms: 1_000,
                        end_ms: 2_000,
                        text: "Ship it carefully.".into(),
                        channel_id: Some("microphone".into()),
                        speaker: Some("Alex".into()),
                        confidence: Some(0.99),
                        is_final: true,
                        metadata: json!({}),
                    },
                }],
            })
            .unwrap();
        complete_meeting(&fixture, "meeting-1");
        fixture
            .platform
            .update_content(
                "meeting-1",
                &MeetingUpdatePatch {
                    summary: Some("A release decision was made.".into()),
                    tags: Some(vec!["release".into()]),
                    ..MeetingUpdatePatch::default()
                },
            )
            .unwrap();
        let exported = fixture
            .platform
            .export_meeting("meeting-1", MeetingExportFormat::Markdown)
            .unwrap();
        let markdown = fs::read_to_string(exported.path).unwrap();
        assert!(markdown.contains("A release decision was made."));
        assert!(markdown.contains("Ship it carefully."));
        assert!(markdown.contains("00:00:01 · Alex"));
        let summary_hits = fixture
            .store
            .search_content("release decision", 10)
            .unwrap();
        assert_eq!(summary_hits.len(), 1);
        assert!(summary_hits[0].summary_match);
        let tag_hits = fixture.store.search_content("lea", 10).unwrap();
        assert_eq!(tag_hits.len(), 1);
        assert!(tag_hits[0].tags_match);
    }

    #[test]
    fn startup_reconciles_existing_reviewed_content_into_private_search() {
        let directory = tempfile::tempdir().unwrap();
        let paths = MeetingPlatformPaths::from_mimir_root(directory.path());
        fs::create_dir_all(&paths.content_root).unwrap();
        let store =
            Arc::new(MeetingStore::open(paths.meetings_root.join("meetings.sqlite")).unwrap());
        let created = store
            .create_meeting(
                &MeetingDraft {
                    id: "meeting-before-index".into(),
                    title: "Original title".into(),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                NOW,
            )
            .unwrap();
        store
            .transition_meeting(
                &created.id,
                created.revision,
                super::super::MeetingStatus::Failed,
                "2026-07-30T10:01:00Z",
                Some(&super::super::MeetingFailure {
                    code: "fixture".into(),
                    message: "terminal fixture".into(),
                    retryable: false,
                }),
            )
            .unwrap();
        write_private_json_atomic(
            paths.content_root.join("meeting-before-index.json"),
            &PersistedMeetingContent {
                schema_version: CONTENT_SCHEMA_VERSION,
                title: Some("Reviewed startup title".into()),
                summary: Some(format!(
                    "{} startup-full-summary-sentinel",
                    "reviewed context ".repeat(180)
                )),
                tags: vec!["startup-index-tag".into()],
                ..PersistedMeetingContent::default()
            },
        )
        .unwrap();

        let model_bytes = b"verified managed model".to_vec();
        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        let platform = NativeMeetingPlatform::new(
            paths.clone(),
            Arc::clone(&store),
            vec![MeetingModelCatalogEntry {
                title: "Whisper Small".into(),
                manifest: manifest(&model_bytes),
            }],
            Arc::new(FakeSecrets::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeDisk),
            Arc::new(FakeDownloader {
                bytes: model_bytes,
                completion,
            }),
            Arc::new(NoopMeetingPlatformChangeSink),
        )
        .unwrap();
        assert_eq!(
            platform.content_load_count(),
            1,
            "the dirty legacy content file should be loaded exactly once"
        );
        let indexed_fingerprint = store
            .content_search_fingerprint("meeting-before-index")
            .unwrap()
            .unwrap();
        assert_ne!(indexed_fingerprint, "missing");

        for (query, field) in [
            ("startup title", "title"),
            ("full-summary-sentinel", "summary"),
            ("index-tag", "tags"),
        ] {
            let hits = store.search_content(query, 10).unwrap();
            assert_eq!(hits.len(), 1, "startup missed {field}");
            assert_eq!(hits[0].meeting_id, "meeting-before-index");
            assert!(match field {
                "title" => hits[0].title_match,
                "summary" => hits[0].summary_match,
                "tags" => hits[0].tags_match,
                _ => false,
            });
        }

        let model_bytes = b"verified managed model".to_vec();
        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        let restarted = NativeMeetingPlatform::new(
            paths,
            Arc::clone(&store),
            vec![MeetingModelCatalogEntry {
                title: "Whisper Small".into(),
                manifest: manifest(&model_bytes),
            }],
            Arc::new(FakeSecrets::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeDisk),
            Arc::new(FakeDownloader {
                bytes: model_bytes,
                completion,
            }),
            Arc::new(NoopMeetingPlatformChangeSink),
        )
        .unwrap();
        assert_eq!(
            restarted.content_load_count(),
            0,
            "an unchanged library restart must not re-read reviewed content bodies"
        );
    }

    #[test]
    fn detector_policy_failure_degrades_startup_but_settings_still_surface_it() {
        let fixture = fixture_with_environment(Arc::new(FailingDetectionEnvironment));
        let diagnostic = fixture.platform.projection().unwrap().diagnostic.unwrap();
        assert!(diagnostic.contains("manual recording remains available"));
        assert!(diagnostic.chars().count() <= MAX_DIAGNOSTIC_CHARS + 100);
        assert!(
            !diagnostic.ends_with("bounded-diagnostic-tail"),
            "unbounded detector error reached the public projection"
        );

        fixture
            .platform
            .update_config(&MeetingConfigPatch {
                detection_enabled: Some(false),
                ..MeetingConfigPatch::default()
            })
            .unwrap();
        assert!(
            !fixture
                .platform
                .projection()
                .unwrap()
                .config
                .detection_enabled
        );

        let error = fixture
            .platform
            .update_config(&MeetingConfigPatch {
                detection_enabled: Some(true),
                ..MeetingConfigPatch::default()
            })
            .unwrap_err();
        assert!(error.contains("detector unavailable"));
        assert!(
            !fixture
                .platform
                .projection()
                .unwrap()
                .config
                .detection_enabled,
            "a rejected detector policy must not mutate durable configuration"
        );
    }

    #[test]
    fn delete_and_audio_export_never_follow_symlinks() {
        let fixture = fixture();
        create_meeting(&fixture, "meeting-1");
        complete_meeting(&fixture, "meeting-1");
        let audio = fixture
            .paths
            .meetings_root
            .join("meeting-1")
            .join("microphone");
        fs::create_dir_all(&audio).unwrap();
        fs::write(audio.join("0001.raw"), b"audio").unwrap();
        let hook_input = fixture
            .paths
            .meetings_root
            .join("meeting-1/followups/summary-job/transcript.jsonl");
        fs::create_dir_all(hook_input.parent().unwrap()).unwrap();
        fs::write(
            &hook_input,
            b"{\"type\":\"segment\",\"text\":\"private\"}\n",
        )
        .unwrap();
        let export = fixture
            .platform
            .export_meeting("meeting-1", MeetingExportFormat::Audio)
            .unwrap();
        assert_eq!(
            fs::read(Path::new(&export.path).join("microphone/0001.raw")).unwrap(),
            b"audio"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = fixture._directory.path().join("outside");
            fs::write(&outside, b"preserve").unwrap();
            symlink(&outside, audio.join("escape")).unwrap();
            assert!(fixture
                .platform
                .export_meeting("meeting-1", MeetingExportFormat::Audio)
                .is_err());
            assert_eq!(fs::read(&outside).unwrap(), b"preserve");
        }

        fixture
            .store
            .begin_deletion(
                "meeting-1",
                StoreDeletionMode::All,
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        fixture
            .platform
            .delete_meeting("meeting-1", MeetingDeleteMode::All)
            .unwrap();
        assert!(matches!(
            fixture.store.get_meeting("meeting-1"),
            Err(crate::meetings::MeetingStoreError::NotFound { .. })
        ));
        assert!(!fixture.paths.content_root.join("meeting-1.json").exists());
        assert!(
            !hook_input.exists(),
            "whole-record deletion must remove managed hook transcript inputs"
        );
    }

    #[cfg(unix)]
    #[test]
    fn content_fingerprint_errors_never_disclose_private_paths() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let private_path = directory.path().join("meeting-secret.json");
        let outside = directory.path().join("outside.json");
        fs::write(&outside, b"private content").unwrap();
        symlink(&outside, &private_path).unwrap();

        let error = content_file_fingerprint(&private_path).unwrap_err();
        assert!(error.contains("regular file"));
        assert!(!error.contains(&directory.path().display().to_string()));
        assert!(!error.contains("meeting-secret"));
        assert!(!error.contains("outside.json"));
    }

    #[test]
    fn mtg_153_permanent_deletion_replays_every_fault_boundary_without_orphans() {
        for fault in [
            "after-content-hidden",
            "after-files-removed",
            "after-files-stage",
            "after-database-removed",
            "after-marker-cleanup",
        ] {
            let fixture = fixture();
            create_meeting(&fixture, "meeting-1");
            complete_meeting(&fixture, "meeting-1");
            let meeting_root = fixture.paths.meetings_root.join("meeting-1");
            fs::create_dir_all(meeting_root.join("audio")).unwrap();
            fs::write(meeting_root.join("audio/0001.raw"), b"private audio").unwrap();
            fixture
                .platform
                .update_content(
                    "meeting-1",
                    &MeetingUpdatePatch {
                        summary: Some("private summary".into()),
                        ..MeetingUpdatePatch::default()
                    },
                )
                .unwrap();
            fixture
                .store
                .begin_deletion("meeting-1", StoreDeletionMode::All, NOW)
                .unwrap();
            fixture.platform.inject_deletion_fault(fault);

            let error = fixture
                .platform
                .delete_meeting("meeting-1", MeetingDeleteMode::All)
                .unwrap_err();
            assert!(error.contains(fault), "{fault}: {error}");
            assert!(
                fixture.store.deletion("meeting-1").unwrap().is_some(),
                "{fault} erased the recovery journal"
            );

            assert_eq!(
                fixture.platform.recover_pending_deletions().unwrap(),
                ["meeting-1"]
            );
            assert!(fixture.store.deletion("meeting-1").unwrap().is_none());
            assert!(matches!(
                fixture.store.get_meeting("meeting-1"),
                Err(crate::meetings::MeetingStoreError::NotFound { .. })
            ));
            assert!(!meeting_root.exists());
            assert!(!fixture.paths.content_root.join("meeting-1.json").exists());
        }
    }

    #[test]
    fn mtg_153_audio_only_deletion_replays_files_database_and_cleanup_faults() {
        for fault in [
            "after-files-removed",
            "after-files-stage",
            "after-database-removed",
            "after-marker-cleanup",
        ] {
            let fixture = fixture();
            create_meeting(&fixture, "meeting-1");
            let detected = fixture.store.get_meeting("meeting-1").unwrap();
            let recording = fixture
                .store
                .transition_meeting(
                    "meeting-1",
                    detected.revision,
                    super::super::MeetingStatus::Recording,
                    NOW,
                    None,
                )
                .unwrap();
            let meeting_root = fixture.paths.meetings_root.join("meeting-1");
            fs::create_dir_all(meeting_root.join("audio")).unwrap();
            let audio_path = meeting_root.join("audio/0001.f32le");
            fs::write(&audio_path, b"private audio").unwrap();
            let bytes = fs::read(&audio_path).unwrap();
            let chunk = crate::meetings::AudioChunkDraft {
                id: "audio-delete-chunk".into(),
                meeting_id: "meeting-1".into(),
                channel_id: "microphone".into(),
                sequence: 0,
                start_ms: 0,
                end_ms: 1_000,
                sample_count: 16_000,
                byte_len: bytes.len() as u64,
                sha256: Sha256Digest::calculate(Cursor::new(&bytes))
                    .unwrap()
                    .to_string(),
                relative_path: "meeting-1/audio/0001.f32le".into(),
            };
            fixture.store.stage_audio_chunk(&chunk, NOW).unwrap();
            fixture.store.commit_audio_chunk(&chunk.id, NOW).unwrap();
            let mut meeting = recording;
            for status in [
                super::super::MeetingStatus::Stopping,
                super::super::MeetingStatus::Finalizing,
                super::super::MeetingStatus::Completed,
            ] {
                meeting = fixture
                    .store
                    .transition_meeting("meeting-1", meeting.revision, status, NOW, None)
                    .unwrap();
            }
            fixture
                .store
                .begin_deletion("meeting-1", StoreDeletionMode::Audio, NOW)
                .unwrap();
            fixture.platform.inject_deletion_fault(fault);
            assert!(fixture
                .platform
                .delete_meeting("meeting-1", MeetingDeleteMode::Audio)
                .unwrap_err()
                .contains(fault));

            assert_eq!(
                fixture.platform.recover_pending_deletions().unwrap(),
                ["meeting-1"]
            );
            assert!(!audio_path.exists());
            assert!(fixture.store.deletion("meeting-1").unwrap().is_none());
            assert_eq!(
                fixture.store.get_meeting("meeting-1").unwrap().status,
                super::super::MeetingStatus::Completed
            );
        }
    }

    #[test]
    fn model_install_is_background_verified_fsynced_and_atomically_published() {
        let fixture = fixture();
        if RuntimePlatform::current().is_none() {
            assert!(fixture
                .platform
                .install_model("whisper-small")
                .unwrap_err()
                .contains("macOS arm64"));
            return;
        }
        fixture.platform.install_model("whisper-small").unwrap();
        let (done, condition) = &*fixture.completion;
        let guard = done.lock().unwrap();
        let _ = condition
            .wait_timeout_while(guard, StdDuration::from_secs(5), |value| !*value)
            .unwrap();
        for _ in 0..100 {
            if fixture
                .platform
                .projection()
                .unwrap()
                .models
                .iter()
                .any(|model| model.status == "installed")
            {
                break;
            }
            thread::sleep(StdDuration::from_millis(10));
        }
        let model = fixture.platform.projection().unwrap().models.remove(0);
        assert_eq!(model.status, "installed");
        let artifact = fixture
            .paths
            .models_root
            .join("whisper-small/test-1/model.bin");
        assert_eq!(fs::read(&artifact).unwrap(), b"verified managed model");
        assert_eq!(
            fixture
                .platform
                .managed_model_artifact("whisper-small")
                .unwrap(),
            artifact
        );
        assert!(!fs::read_dir(artifact.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".part")));
    }

    #[test]
    fn retention_skips_active_work_and_removes_only_expired_source_audio() {
        let fixture = fixture();
        create_meeting(&fixture, "meeting-old");
        let old = fixture.store.get_meeting("meeting-old").unwrap();
        fixture
            .store
            .transition_meeting(
                "meeting-old",
                old.revision,
                super::super::MeetingStatus::Recording,
                NOW,
                None,
            )
            .unwrap();
        let recording = fixture.store.get_meeting("meeting-old").unwrap();
        fixture
            .store
            .transition_meeting(
                "meeting-old",
                recording.revision,
                super::super::MeetingStatus::Stopping,
                NOW,
                None,
            )
            .unwrap();
        let stopping = fixture.store.get_meeting("meeting-old").unwrap();
        fixture
            .store
            .transition_meeting(
                "meeting-old",
                stopping.revision,
                super::super::MeetingStatus::Finalizing,
                NOW,
                None,
            )
            .unwrap();
        fixture
            .store
            .apply_transcript_batch(&TranscriptBatch {
                meeting_id: "meeting-old".into(),
                batch_id: "retention-terminal".into(),
                base_revision: 0,
                source: "test".into(),
                observed_at: NOW.into(),
                marks_final: true,
                changes: vec![TranscriptChange::UpsertSegment {
                    segment: TranscriptSegmentInput {
                        id: "retention-segment".into(),
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "Durable transcript".into(),
                        channel_id: Some("microphone".into()),
                        speaker: None,
                        confidence: Some(1.0),
                        is_final: true,
                        metadata: json!({}),
                    },
                }],
            })
            .unwrap();
        fixture
            .store
            .transition_meeting(
                "meeting-old",
                fixture.store.get_meeting("meeting-old").unwrap().revision,
                super::super::MeetingStatus::Completed,
                NOW,
                None,
            )
            .unwrap();
        let removed = fixture
            .platform
            .enforce_retention(
                DateTime::parse_from_rfc3339("2026-09-30T10:00:00Z")
                    .unwrap()
                    .into(),
            )
            .unwrap();
        assert_eq!(removed, vec!["meeting-old"]);
        assert!(!fixture.platform.content("meeting-old").unwrap().deleted);
        assert!(fixture.store.get_meeting("meeting-old").is_ok());
        assert_eq!(
            fixture
                .store
                .transcript_snapshot("meeting-old", None)
                .unwrap()
                .segments
                .len(),
            1
        );
    }
}
