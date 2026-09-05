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
        validate_graph_draft, MeetingCandidate, MeetingConfig, MeetingConfigPatch,
        MeetingContentProjection, MeetingDeleteMode, MeetingExport, MeetingExportFormat,
        MeetingGraphDraft, MeetingHookConfig, MeetingModel, MeetingPermissions,
        MeetingPlatformPort, MeetingPlatformProjection, MeetingUpdatePatch,
    },
    MeetingDeletionMode as StoreDeletionMode, MeetingDeletionStage, MeetingStore,
    TranscriptGapRecord, TranscriptSegmentRecord,
};
use crate::persistence::{
    ensure_private_directory, ensure_private_subdirectory, load_json_optional_quarantining,
    prepare_private_file_path, repair_private_file, repair_private_file_if_exists,
    write_private_bytes_atomic, write_private_json_atomic, QuarantinedLoad,
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

mod content;
mod download;
mod export;
mod filesystem;
mod model_manager;
mod native;
mod port;
mod render;
mod validation;

use filesystem::*;
use render::*;
use validation::*;

pub use download::{HttpsModelArtifactDownloader, ModelArtifactDownloader};
use model_manager::ModelManager;

const CONFIG_SCHEMA_VERSION: u32 = 1;
const CONTENT_SCHEMA_VERSION: u32 = 1;
const MODEL_STATE_SCHEMA_VERSION: u32 = 1;
const KEYCHAIN_BINDING_SCHEMA_VERSION: u32 = 1;
const KEYCHAIN_SERVICE: &str = "com.abundanceds.mimir";
const KEYCHAIN_ACCOUNT: &str = "meetings.custom-stt";
const MAX_API_KEY_BYTES: usize = 64 * 1024;
const MAX_SUMMARY_BYTES: usize = 4 * 1024 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_CHARS: usize = 80;
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

struct CachedMeetingSecret {
    endpoint_binding: String,
    secret: Option<String>,
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
    #[serde(default)]
    microphone_device_id: Option<String>,
    transcription_mode: String,
    custom_url: String,
    custom_model: String,
    local_model: String,
    summary_enabled: bool,
    #[serde(default = "default_summary_template")]
    summary_template: String,
    #[serde(default)]
    summary_prompt: String,
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
            microphone_device_id: config.microphone_device_id,
            transcription_mode: config.transcription_mode,
            custom_url: config.custom_url,
            custom_model: config.custom_model,
            local_model: config.local_model,
            summary_enabled: config.summary_enabled,
            summary_template: config.summary_template,
            summary_prompt: config.summary_prompt,
            summary_preset: config.summary_preset,
            kg_prompt: config.kg_prompt,
            kg_preset: config.kg_preset,
            retention_days: config.retention_days,
        }
    }
}

impl From<StoredMeetingConfig> for MeetingConfig {
    fn from(config: StoredMeetingConfig) -> Self {
        let summary_prompt = if config.summary_prompt.trim().is_empty()
            || replaced_builtin_summary_prompt(config.summary_prompt.trim())
        {
            super::runtime::summary_template_instructions(&config.summary_template)
                .unwrap_or_else(|| {
                    super::runtime::summary_template_instructions("standard")
                        .expect("standard summary instructions must exist")
                })
                .to_string()
        } else {
            config.summary_prompt
        };
        Self {
            detection_enabled: config.detection_enabled,
            auto_record: config.auto_record,
            microphone_device_id: config.microphone_device_id,
            transcription_mode: config.transcription_mode,
            custom_url: config.custom_url,
            custom_model: config.custom_model,
            api_key_configured: false,
            local_model: config.local_model,
            summary_enabled: config.summary_enabled,
            summary_template: config.summary_template,
            summary_prompt,
            summary_preset: config.summary_preset,
            kg_prompt: config.kg_prompt,
            kg_preset: config.kg_preset,
            retention_days: config.retention_days,
        }
    }
}

fn default_summary_template() -> String {
    "standard".into()
}

const LEGACY_BALANCED_SUMMARY_PROMPT: &str = "Write a balanced meeting summary with context, decisions, action items, and open questions. Use short Markdown sections only when they improve scanning.";
const LEGACY_LOOSE_BLUF_SUMMARY_PROMPT: &str = "Use the BLUF approach. Write an ultra-concise meeting brief in Markdown bullets, usually 5 to 8 bullets. Put the bottom line first; keep one useful idea per bullet; use active voice; include owners and dates when known; omit greetings, repetition, obvious background, and discussion that produced no useful result. Read the user notes with judgment: use useful facts, questions, decisions, actions, or context; ignore noise or memory aids that add nothing.";
const LEGACY_FLAT_BLUF_SUMMARY_PROMPT: &str = "Use the BLUF approach. Return one flat Markdown list of 5 to 8 bullets, with no headings, sections, paragraphs, or nested bullets. Put the bottom line first. Keep one useful idea per bullet and use active voice. Include owners and dates only when known. Omit greetings, repetition, obvious background, and discussion that produced no useful result. Read the user notes with judgment: use useful facts, questions, decisions, actions, or context; ignore noise or memory aids that add nothing.";
const LEGACY_LABELED_BLUF_SUMMARY_PROMPT: &str = "Use the BLUF approach. Return one flat Markdown list of 5 to 8 bullets. Start the first bullet with **BLUF:**. Start each later bullet with one short bold cue chosen for its meaning, such as **Decision:**, **Action — Paul:**, **Open:**, **Risk:**, **Blocker:**, or **Context:**. Use only useful cues; do not force categories. Each bullet must contain one sentence and no more than 25 words after its cue. Do not bundle points with semicolons. Prefer concrete nouns and active verbs. Include owners and dates only when known. Use no headings, sections, paragraphs, or nested bullets. Omit greetings, repetition, obvious background, and low-value discussion. Read the user notes with judgment: use useful facts, questions, decisions, actions, or context; ignore noise or memory aids that add nothing.";

fn replaced_builtin_summary_prompt(value: &str) -> bool {
    matches!(
        value,
        LEGACY_BALANCED_SUMMARY_PROMPT
            | LEGACY_LOOSE_BLUF_SUMMARY_PROMPT
            | LEGACY_FLAT_BLUF_SUMMARY_PROMPT
            | LEGACY_LABELED_BLUF_SUMMARY_PROMPT
    )
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
    notes: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kg_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph_node_id: Option<String>,
    #[serde(default)]
    graph_draft: MeetingGraphDraft,
    #[serde(default)]
    title_user_set: bool,
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
            notes: String,
            #[serde(default)]
            tags: Vec<String>,
            workspace_path: Option<String>,
            source_app: Option<String>,
            kg_decision: Option<String>,
            graph_node_id: Option<String>,
            #[serde(default)]
            graph_draft: MeetingGraphDraft,
            #[serde(default)]
            title_user_set: bool,
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
            &wire.notes,
            &wire.tags,
            wire.kg_decision.as_deref(),
            wire.graph_node_id.as_deref(),
            &wire.graph_draft,
        )
        .map_err(de::Error::custom)?;
        Ok(Self {
            schema_version: wire.schema_version,
            title: wire.title,
            summary: wire.summary,
            notes: wire.notes,
            tags: wire.tags,
            workspace_path: wire.workspace_path,
            source_app: wire.source_app,
            kg_decision: wire.kg_decision,
            graph_node_id: wire.graph_node_id,
            graph_draft: wire.graph_draft,
            title_user_set: wire.title_user_set,
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

struct NativeMeetingPlatformInner {
    paths: MeetingPlatformPaths,
    store: Arc<MeetingStore>,
    secrets: Arc<dyn MeetingSecretStore>,
    environment: Arc<dyn MeetingEnvironmentProbe>,
    models: Arc<ModelManager>,
    changes: Arc<dyn MeetingPlatformChangeSink>,
    operation: Mutex<()>,
    credential_cache: Mutex<Option<CachedMeetingSecret>>,
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

#[cfg(test)]
mod tests;
