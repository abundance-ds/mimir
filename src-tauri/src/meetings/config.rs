//! Security-sensitive configuration and managed-model state for meeting STT.
//!
//! There are deliberately only two provider modes:
//!
//! - [`TranscriptionProviderConfig::LocalManaged`] selects a model whose
//!   artifact has passed the manifest checks in this module. The sidecar
//!   endpoint is runtime-owned and cannot be supplied through persisted user
//!   configuration.
//! - [`TranscriptionProviderConfig::CustomUrl`] connects to one user-approved
//!   `wss://` destination speaking the versioned `mimir.stt.v1` contract.
//!
//! Neither mode contains a fallback provider. A caller must surface validation
//! or capability failures and let the user make an explicit configuration
//! change.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    io::{self, Read},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    str::FromStr,
};
use thiserror::Error;
use url::{Host, Url};

pub const CUSTOM_STT_SUBPROTOCOL: &str = "mimir.stt.v1";
pub const MANAGED_SIDECAR_PATH: &str = "/mimir-stt/v1/stream";
pub const MODEL_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MAX_MODEL_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024 * 1024;
pub const MIN_MODEL_DISK_RESERVE_BYTES: u64 = 512 * 1024 * 1024;

const MAX_IDENTIFIER_BYTES: usize = 160;
const MAX_KEYCHAIN_COMPONENT_BYTES: usize = 255;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{0} cannot be empty")]
    Empty(&'static str),
    #[error("{0} is too long")]
    TooLong(&'static str),
    #[error("{0} contains unsupported characters")]
    InvalidCharacters(&'static str),
    #[error("custom STT endpoint is not a valid absolute URL")]
    InvalidCustomUrl,
    #[error("custom STT endpoint must use secure WebSocket (wss)")]
    CustomUrlMustUseWss,
    #[error("custom STT endpoint must not contain credentials, query parameters, or a fragment")]
    CustomUrlContainsSensitiveComponents,
    #[error("custom STT endpoint must use a public DNS hostname")]
    CustomUrlHostNotPublicDns,
    #[error("custom STT endpoint host does not match the user-approved host")]
    CustomUrlHostNotApproved,
    #[error("custom STT endpoint resolved to a non-public address")]
    CustomUrlResolvedToNonPublicAddress,
    #[error("managed sidecar endpoint is not a valid absolute URL")]
    InvalidManagedUrl,
    #[error("managed sidecar endpoint must use ws on a numeric loopback address")]
    ManagedUrlNotLoopback,
    #[error("managed sidecar endpoint must include an explicit non-zero port")]
    ManagedUrlMissingPort,
    #[error("managed sidecar endpoint must use the fixed Mimir STT path")]
    ManagedUrlWrongPath,
    #[error(
        "managed sidecar endpoint must not contain credentials, query parameters, or a fragment"
    )]
    ManagedUrlContainsSensitiveComponents,
    #[error("managed sidecar ownership proof is invalid")]
    InvalidSidecarOwnership,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConfigIdentifier(String);

impl ConfigIdentifier {
    pub fn new(value: impl Into<String>, label: &'static str) -> Result<Self, ConfigError> {
        let value = value.into();
        validate_identifier(&value, label)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ConfigIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ConfigIdentifier")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for ConfigIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for ConfigIdentifier {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ConfigIdentifier {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value, "identifier").map_err(de::Error::custom)
    }
}

fn validate_identifier(value: &str, label: &'static str) -> Result<(), ConfigError> {
    if value.is_empty() {
        return Err(ConfigError::Empty(label));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(ConfigError::TooLong(label));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ConfigError::InvalidCharacters(label));
    }
    Ok(())
}

/// A Keychain locator, never credential material.
///
/// Debug output intentionally omits the account name because it may reveal an
/// email address or tenant identifier. Runtime code should resolve this
/// locator inside the native process and inject the resulting secret directly
/// into the WebSocket handshake.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainCredentialRef {
    service: String,
    account: String,
}

impl KeychainCredentialRef {
    pub fn new(
        service: impl Into<String>,
        account: impl Into<String>,
    ) -> Result<Self, ConfigError> {
        let service = service.into();
        let account = account.into();
        validate_keychain_component(&service, "keychain service")?;
        validate_keychain_component(&account, "keychain account")?;
        Ok(Self { service, account })
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn account(&self) -> &str {
        &self.account
    }
}

impl fmt::Debug for KeychainCredentialRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeychainCredentialRef")
            .field("service", &self.service)
            .field("account", &"[redacted]")
            .finish()
    }
}

impl<'de> Deserialize<'de> for KeychainCredentialRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            service: String,
            account: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(wire.service, wire.account).map_err(de::Error::custom)
    }
}

fn validate_keychain_component(value: &str, label: &'static str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::Empty(label));
    }
    if value.len() > MAX_KEYCHAIN_COMPONENT_BYTES {
        return Err(ConfigError::TooLong(label));
    }
    if value.chars().any(char::is_control) {
        return Err(ConfigError::InvalidCharacters(label));
    }
    Ok(())
}

/// A validated user-approved custom STT WebSocket endpoint.
///
/// IP literals, localhost-style names, URL credentials, queries, and fragments
/// are rejected. The connector must additionally call
/// [`Self::validate_resolved_addresses`] after DNS resolution and before every
/// connection to close DNS-rebinding and stale-DNS gaps.
#[derive(Clone, PartialEq, Eq)]
pub struct CustomSttEndpoint {
    canonical: String,
    approved_host: String,
}

impl CustomSttEndpoint {
    pub fn new(raw_url: &str, approved_host: &str) -> Result<Self, ConfigError> {
        let parsed = Url::parse(raw_url).map_err(|_| ConfigError::InvalidCustomUrl)?;
        if parsed.scheme() != "wss" {
            return Err(ConfigError::CustomUrlMustUseWss);
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ConfigError::CustomUrlContainsSensitiveComponents);
        }

        let host = match parsed.host() {
            Some(Host::Domain(host)) if is_public_dns_name(host) => host.to_ascii_lowercase(),
            _ => return Err(ConfigError::CustomUrlHostNotPublicDns),
        };
        let approved_host = normalize_approved_host(approved_host)?;
        if host != approved_host {
            return Err(ConfigError::CustomUrlHostNotApproved);
        }

        Ok(Self {
            canonical: parsed.to_string(),
            approved_host,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    pub fn approved_host(&self) -> &str {
        &self.approved_host
    }

    pub fn disclosed_destination(&self) -> &str {
        &self.canonical
    }

    pub fn validate_resolved_addresses(
        &self,
        addresses: impl IntoIterator<Item = IpAddr>,
    ) -> Result<(), ConfigError> {
        let mut found = false;
        for address in addresses {
            found = true;
            if !is_public_ip(address) {
                return Err(ConfigError::CustomUrlResolvedToNonPublicAddress);
            }
        }
        if !found {
            return Err(ConfigError::CustomUrlResolvedToNonPublicAddress);
        }
        Ok(())
    }
}

impl fmt::Debug for CustomSttEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomSttEndpoint")
            .field("approved_host", &self.approved_host)
            .field("url", &"[approved wss destination]")
            .finish()
    }
}

impl Serialize for CustomSttEndpoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            url: &'a str,
            approved_host: &'a str,
        }
        Wire {
            url: &self.canonical,
            approved_host: &self.approved_host,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CustomSttEndpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            url: String,
            approved_host: String,
        }
        let wire = Wire::deserialize(deserializer)?;
        Self::new(&wire.url, &wire.approved_host).map_err(de::Error::custom)
    }
}

fn normalize_approved_host(value: &str) -> Result<String, ConfigError> {
    let normalized = value.trim().trim_end_matches('.').to_ascii_lowercase();
    if !is_public_dns_name(&normalized) {
        return Err(ConfigError::CustomUrlHostNotPublicDns);
    }
    Ok(normalized)
}

fn is_public_dns_name(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    if host.is_empty()
        || host.len() > 253
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.to_ascii_lowercase().ends_with(".local")
        || IpAddr::from_str(host).is_ok()
    {
        return false;
    }
    let mut labels = host.split('.');
    let Some(first) = labels.next() else {
        return false;
    };
    let remaining = labels.collect::<Vec<_>>();
    if remaining.is_empty() {
        return false;
    }
    let valid_label = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    valid_label(first) && remaining.into_iter().all(valid_label)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip == Ipv4Addr::BROADCAST
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalManagedConfig {
    pub model_id: ConfigIdentifier,
}

impl fmt::Debug for LocalManagedConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalManagedConfig")
            .field("model_id", &self.model_id)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomUrlConfig {
    pub endpoint: CustomSttEndpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<KeychainCredentialRef>,
}

impl fmt::Debug for CustomUrlConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomUrlConfig")
            .field("endpoint", &self.endpoint)
            .field(
                "credential_ref",
                &self.credential_ref.as_ref().map(|_| "[keychain-reference]"),
            )
            .field("contract", &CUSTOM_STT_SUBPROTOCOL)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TranscriptionProviderConfig {
    LocalManaged(LocalManagedConfig),
    CustomUrl(CustomUrlConfig),
}

impl TranscriptionProviderConfig {
    pub fn redacted(&self) -> RedactedTranscriptionConfig<'_> {
        match self {
            Self::LocalManaged(config) => RedactedTranscriptionConfig {
                mode: "local-managed",
                model_id: Some(config.model_id.as_str()),
                destination_host: None,
                contract: None,
                credential_configured: false,
            },
            Self::CustomUrl(config) => RedactedTranscriptionConfig {
                mode: "custom-url",
                model_id: None,
                destination_host: Some(config.endpoint.approved_host()),
                contract: Some(CUSTOM_STT_SUBPROTOCOL),
                credential_configured: config.credential_ref.is_some(),
            },
        }
    }
}

impl fmt::Debug for TranscriptionProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.redacted().fmt(formatter)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedTranscriptionConfig<'a> {
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_host: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<&'static str>,
    pub credential_configured: bool,
}

impl fmt::Debug for RedactedTranscriptionConfig<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptionProviderConfig")
            .field("mode", &self.mode)
            .field("model_id", &self.model_id)
            .field("destination_host", &self.destination_host)
            .field("contract", &self.contract)
            .field("credential_configured", &self.credential_configured)
            .finish()
    }
}

/// Proof that a loopback address came from a Mimir-spawned child, not from
/// persisted or renderer-controlled configuration.
#[derive(Clone, PartialEq, Eq)]
pub struct ManagedSidecarOwnership {
    child_pid: u32,
    launch_id: ConfigIdentifier,
}

impl ManagedSidecarOwnership {
    pub fn from_spawned_child(
        child_pid: u32,
        launch_id: impl Into<String>,
    ) -> Result<Self, ConfigError> {
        if child_pid == 0 {
            return Err(ConfigError::InvalidSidecarOwnership);
        }
        Ok(Self {
            child_pid,
            launch_id: ConfigIdentifier::new(launch_id, "sidecar launch id")?,
        })
    }

    pub fn child_pid(&self) -> u32 {
        self.child_pid
    }

    pub fn launch_id(&self) -> &str {
        self.launch_id.as_str()
    }
}

impl fmt::Debug for ManagedSidecarOwnership {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedSidecarOwnership")
            .field("child_pid", &self.child_pid)
            .field("launch_id", &"[redacted]")
            .finish()
    }
}

/// Runtime-only endpoint for the Mimir-owned local sidecar.
///
/// This type is intentionally not serializable, keeping arbitrary loopback
/// URLs out of settings and IPC.
#[derive(Clone, PartialEq, Eq)]
pub struct ManagedSidecarEndpoint {
    canonical: String,
    ownership: ManagedSidecarOwnership,
}

impl ManagedSidecarEndpoint {
    pub fn from_spawned_child(
        raw_url: &str,
        ownership: ManagedSidecarOwnership,
    ) -> Result<Self, ConfigError> {
        let parsed = Url::parse(raw_url).map_err(|_| ConfigError::InvalidManagedUrl)?;
        if parsed.scheme() != "ws" {
            return Err(ConfigError::ManagedUrlNotLoopback);
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ConfigError::ManagedUrlContainsSensitiveComponents);
        }
        match parsed.host() {
            Some(Host::Ipv4(ip)) if ip.is_loopback() => {}
            Some(Host::Ipv6(ip)) if ip.is_loopback() => {}
            _ => return Err(ConfigError::ManagedUrlNotLoopback),
        }
        if parsed.port().is_none() || parsed.port() == Some(0) {
            return Err(ConfigError::ManagedUrlMissingPort);
        }
        if parsed.path() != MANAGED_SIDECAR_PATH {
            return Err(ConfigError::ManagedUrlWrongPath);
        }
        Ok(Self {
            canonical: parsed.to_string(),
            ownership,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    pub fn ownership(&self) -> &ManagedSidecarOwnership {
        &self.ownership
    }
}

impl fmt::Debug for ManagedSidecarEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedSidecarEndpoint")
            .field("address", &"[owned loopback]")
            .field("ownership", &self.ownership)
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum ModelIntegrityError {
    #[error("model checksum must be exactly 64 hexadecimal characters")]
    InvalidChecksum,
    #[error("could not read model artifact: {0}")]
    Io(#[from] io::Error),
    #[error("unsupported model manifest schema")]
    UnsupportedManifestSchema,
    #[error("model artifact size is outside supported bounds")]
    InvalidArtifactSize,
    #[error("model disk reserve is below the safety minimum")]
    InvalidDiskReserve,
    #[error("model download URL must be HTTPS with a public DNS host and no credentials")]
    InvalidDownloadUrl,
    #[error("model manifest does not support this runtime platform")]
    PlatformMismatch,
    #[error("insufficient free disk space for model download and safety reserve")]
    InsufficientDiskSpace,
    #[error("model download progress exceeds the declared artifact size")]
    DownloadOverflow,
    #[error("model download is incomplete")]
    DownloadIncomplete,
    #[error("model artifact size does not match its manifest")]
    SizeMismatch,
    #[error("model artifact checksum does not match its manifest")]
    ChecksumMismatch,
    #[error("invalid model download state transition")]
    InvalidStateTransition,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn calculate(mut reader: impl Read) -> Result<Self, ModelIntegrityError> {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(Self(hasher.finalize().into()))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl FromStr for Sha256Digest {
    type Err = ModelIntegrityError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ModelIntegrityError::InvalidChecksum);
        }
        let mut bytes = [0_u8; 32];
        for (index, target) in bytes.iter_mut().enumerate() {
            *target = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| ModelIntegrityError::InvalidChecksum)?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("Sha256Digest")
            .field(&self.to_string())
            .finish()
    }
}

impl Serialize for Sha256Digest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperatingSystem {
    Macos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CpuArchitecture {
    Aarch64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlatform {
    pub operating_system: OperatingSystem,
    pub architecture: CpuArchitecture,
}

impl RuntimePlatform {
    pub const MACOS_AARCH64: Self = Self {
        operating_system: OperatingSystem::Macos,
        architecture: CpuArchitecture::Aarch64,
    };

    pub fn current() -> Option<Self> {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some(Self::MACOS_AARCH64)
        } else {
            None
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelDownloadUrl(String);

impl ModelDownloadUrl {
    pub fn new(raw_url: &str) -> Result<Self, ModelIntegrityError> {
        let parsed = Url::parse(raw_url).map_err(|_| ModelIntegrityError::InvalidDownloadUrl)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ModelIntegrityError::InvalidDownloadUrl);
        }
        match parsed.host() {
            Some(Host::Domain(host)) if is_public_dns_name(host) => {}
            _ => return Err(ModelIntegrityError::InvalidDownloadUrl),
        }
        Ok(Self(parsed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn validate_resolved_addresses(
        &self,
        addresses: impl IntoIterator<Item = IpAddr>,
    ) -> Result<(), ModelIntegrityError> {
        let mut found = false;
        for address in addresses {
            found = true;
            if !is_public_ip(address) {
                return Err(ModelIntegrityError::InvalidDownloadUrl);
            }
        }
        if !found {
            return Err(ModelIntegrityError::InvalidDownloadUrl);
        }
        Ok(())
    }
}

impl fmt::Debug for ModelDownloadUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ModelDownloadUrl([https destination])")
    }
}

impl Serialize for ModelDownloadUrl {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ModelDownloadUrl {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(&value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelManifest {
    pub schema_version: u32,
    pub model_id: ConfigIdentifier,
    pub version: ConfigIdentifier,
    pub platform: RuntimePlatform,
    pub artifact_bytes: u64,
    pub sha256: Sha256Digest,
    pub download_url: ModelDownloadUrl,
    pub disk_reserve_bytes: u64,
}

impl<'de> Deserialize<'de> for ModelManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            schema_version: u32,
            model_id: ConfigIdentifier,
            version: ConfigIdentifier,
            platform: RuntimePlatform,
            artifact_bytes: u64,
            sha256: Sha256Digest,
            download_url: ModelDownloadUrl,
            disk_reserve_bytes: u64,
        }
        let wire = Wire::deserialize(deserializer)?;
        let manifest = Self {
            schema_version: wire.schema_version,
            model_id: wire.model_id,
            version: wire.version,
            platform: wire.platform,
            artifact_bytes: wire.artifact_bytes,
            sha256: wire.sha256,
            download_url: wire.download_url,
            disk_reserve_bytes: wire.disk_reserve_bytes,
        };
        manifest.validate().map_err(de::Error::custom)?;
        Ok(manifest)
    }
}

impl ModelManifest {
    pub fn validate(&self) -> Result<(), ModelIntegrityError> {
        if self.schema_version != MODEL_MANIFEST_SCHEMA_VERSION {
            return Err(ModelIntegrityError::UnsupportedManifestSchema);
        }
        if self.artifact_bytes == 0 || self.artifact_bytes > MAX_MODEL_ARTIFACT_BYTES {
            return Err(ModelIntegrityError::InvalidArtifactSize);
        }
        if self.disk_reserve_bytes < MIN_MODEL_DISK_RESERVE_BYTES {
            return Err(ModelIntegrityError::InvalidDiskReserve);
        }
        Ok(())
    }

    pub fn required_free_bytes(&self) -> Result<u64, ModelIntegrityError> {
        self.validate()?;
        self.artifact_bytes
            .checked_add(self.disk_reserve_bytes)
            .ok_or(ModelIntegrityError::InvalidArtifactSize)
    }

    pub fn validate_install_preconditions(
        &self,
        runtime: RuntimePlatform,
        free_bytes: u64,
    ) -> Result<(), ModelIntegrityError> {
        self.validate()?;
        if self.platform != runtime {
            return Err(ModelIntegrityError::PlatformMismatch);
        }
        if free_bytes < self.required_free_bytes()? {
            return Err(ModelIntegrityError::InsufficientDiskSpace);
        }
        Ok(())
    }
}

/// Durable download state. Only `Ready` is selectable, and its complete
/// identity is compared with the current manifest at selection time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ModelDownloadState {
    #[default]
    Missing,
    Downloading {
        received_bytes: u64,
        expected_bytes: u64,
    },
    Verifying {
        artifact_bytes: u64,
    },
    Ready {
        model_id: ConfigIdentifier,
        version: ConfigIdentifier,
        platform: RuntimePlatform,
        artifact_bytes: u64,
        sha256: Sha256Digest,
    },
    Invalid {
        reason: ModelInvalidReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelInvalidReason {
    Incomplete,
    SizeMismatch,
    ChecksumMismatch,
    PlatformMismatch,
    ManifestChanged,
    DownloadOverflow,
    Unreadable,
}

impl ModelDownloadState {
    pub fn begin(
        manifest: &ModelManifest,
        runtime: RuntimePlatform,
        free_bytes: u64,
    ) -> Result<Self, ModelIntegrityError> {
        manifest.validate_install_preconditions(runtime, free_bytes)?;
        Ok(Self::Downloading {
            received_bytes: 0,
            expected_bytes: manifest.artifact_bytes,
        })
    }

    pub fn record_downloaded(&mut self, additional_bytes: u64) -> Result<(), ModelIntegrityError> {
        let Self::Downloading {
            received_bytes,
            expected_bytes,
        } = self
        else {
            return Err(ModelIntegrityError::InvalidStateTransition);
        };
        let Some(next) = received_bytes.checked_add(additional_bytes) else {
            *self = Self::Invalid {
                reason: ModelInvalidReason::DownloadOverflow,
            };
            return Err(ModelIntegrityError::DownloadOverflow);
        };
        if next > *expected_bytes {
            *self = Self::Invalid {
                reason: ModelInvalidReason::DownloadOverflow,
            };
            return Err(ModelIntegrityError::DownloadOverflow);
        }
        *received_bytes = next;
        Ok(())
    }

    pub fn begin_verification(&mut self) -> Result<(), ModelIntegrityError> {
        let Self::Downloading {
            received_bytes,
            expected_bytes,
        } = self
        else {
            return Err(ModelIntegrityError::InvalidStateTransition);
        };
        if received_bytes != expected_bytes {
            *self = Self::Invalid {
                reason: ModelInvalidReason::Incomplete,
            };
            return Err(ModelIntegrityError::DownloadIncomplete);
        }
        *self = Self::Verifying {
            artifact_bytes: *received_bytes,
        };
        Ok(())
    }

    pub fn finish_verification(
        &mut self,
        manifest: &ModelManifest,
        runtime: RuntimePlatform,
        observed_bytes: u64,
        observed_sha256: Sha256Digest,
    ) -> Result<(), ModelIntegrityError> {
        let Self::Verifying { artifact_bytes } = self else {
            return Err(ModelIntegrityError::InvalidStateTransition);
        };
        manifest.validate()?;
        if manifest.platform != runtime {
            *self = Self::Invalid {
                reason: ModelInvalidReason::PlatformMismatch,
            };
            return Err(ModelIntegrityError::PlatformMismatch);
        }
        if observed_bytes != *artifact_bytes || observed_bytes != manifest.artifact_bytes {
            *self = Self::Invalid {
                reason: ModelInvalidReason::SizeMismatch,
            };
            return Err(ModelIntegrityError::SizeMismatch);
        }
        if observed_sha256 != manifest.sha256 {
            *self = Self::Invalid {
                reason: ModelInvalidReason::ChecksumMismatch,
            };
            return Err(ModelIntegrityError::ChecksumMismatch);
        }
        *self = Self::Ready {
            model_id: manifest.model_id.clone(),
            version: manifest.version.clone(),
            platform: runtime,
            artifact_bytes: observed_bytes,
            sha256: observed_sha256,
        };
        Ok(())
    }

    pub fn selectable_for(&self, manifest: &ModelManifest, runtime: RuntimePlatform) -> bool {
        matches!(
            self,
            Self::Ready {
                model_id,
                version,
                platform,
                artifact_bytes,
                sha256,
            } if model_id == &manifest.model_id
                && version == &manifest.version
                && platform == &runtime
                && platform == &manifest.platform
                && artifact_bytes == &manifest.artifact_bytes
                && sha256 == &manifest.sha256
                && manifest.validate().is_ok()
        )
    }

    /// Re-hashes the artifact immediately before model launch.
    ///
    /// `selectable_for` is suitable for presenting a verified installation in
    /// settings, but runtime launch must also call this method so a file
    /// changed after installation cannot be executed.
    pub fn verify_for_use(
        &mut self,
        manifest: &ModelManifest,
        runtime: RuntimePlatform,
        observed_bytes: u64,
        reader: impl Read,
    ) -> Result<(), ModelIntegrityError> {
        if !self.selectable_for(manifest, runtime) {
            return Err(ModelIntegrityError::InvalidStateTransition);
        }
        if observed_bytes != manifest.artifact_bytes {
            *self = Self::Invalid {
                reason: ModelInvalidReason::SizeMismatch,
            };
            return Err(ModelIntegrityError::SizeMismatch);
        }
        let observed_sha256 = match Sha256Digest::calculate(reader) {
            Ok(digest) => digest,
            Err(error) => {
                *self = Self::Invalid {
                    reason: ModelInvalidReason::Unreadable,
                };
                return Err(error);
            }
        };
        if observed_sha256 != manifest.sha256 {
            *self = Self::Invalid {
                reason: ModelInvalidReason::ChecksumMismatch,
            };
            return Err(ModelIntegrityError::ChecksumMismatch);
        }
        Ok(())
    }

    pub fn invalidate_if_manifest_changed(&mut self, manifest: &ModelManifest) {
        let still_valid = match self {
            Self::Ready {
                model_id,
                version,
                platform,
                artifact_bytes,
                sha256,
            } => {
                model_id == &manifest.model_id
                    && version == &manifest.version
                    && platform == &manifest.platform
                    && artifact_bytes == &manifest.artifact_bytes
                    && sha256 == &manifest.sha256
                    && manifest.validate().is_ok()
            }
            _ => return,
        };
        if !still_valid {
            *self = Self::Invalid {
                reason: ModelInvalidReason::ManifestChanged,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::io::Cursor;

    fn id(value: &str) -> ConfigIdentifier {
        ConfigIdentifier::new(value, "test id").unwrap()
    }

    fn manifest(bytes: u64, digest: Sha256Digest) -> ModelManifest {
        ModelManifest {
            schema_version: MODEL_MANIFEST_SCHEMA_VERSION,
            model_id: id("whisper-large-v3"),
            version: id("2026.07.1"),
            platform: RuntimePlatform::MACOS_AARCH64,
            artifact_bytes: bytes,
            sha256: digest,
            download_url: ModelDownloadUrl::new(
                "https://models.example.com/mimir/whisper-large-v3.bin",
            )
            .unwrap(),
            disk_reserve_bytes: MIN_MODEL_DISK_RESERVE_BYTES,
        }
    }

    #[test]
    fn custom_endpoint_is_secure_exact_host_and_disclosable() {
        let endpoint =
            CustomSttEndpoint::new("wss://STT.Example.com:443/mimir/v1", "stt.example.com")
                .unwrap();
        assert_eq!(endpoint.approved_host(), "stt.example.com");
        assert_eq!(
            endpoint.disclosed_destination(),
            "wss://stt.example.com/mimir/v1"
        );
        assert!(endpoint
            .validate_resolved_addresses(["8.8.8.8".parse().unwrap()])
            .is_ok());
    }

    #[test]
    fn custom_endpoint_rejects_url_secret_and_ssrf_shapes() {
        for (url, host) in [
            ("https://stt.example.com/v1", "stt.example.com"),
            ("ws://stt.example.com/v1", "stt.example.com"),
            ("wss://user:secret@stt.example.com/v1", "stt.example.com"),
            ("wss://stt.example.com/v1?key=secret", "stt.example.com"),
            ("wss://stt.example.com/v1#secret", "stt.example.com"),
            ("wss://localhost:9000/v1", "localhost"),
            ("wss://api.local/v1", "api.local"),
            ("wss://127.0.0.1:9000/v1", "127.0.0.1"),
            ("wss://[::1]:9000/v1", "::1"),
        ] {
            assert!(
                CustomSttEndpoint::new(url, host).is_err(),
                "{url} must fail"
            );
        }
        assert!(
            CustomSttEndpoint::new("wss://stt.example.com.evil.test/v1", "stt.example.com")
                .is_err()
        );
    }

    #[test]
    fn custom_endpoint_rechecks_dns_addresses() {
        let endpoint =
            CustomSttEndpoint::new("wss://stt.example.com/v1", "stt.example.com").unwrap();
        for address in [
            "127.0.0.1",
            "10.0.0.2",
            "169.254.1.2",
            "192.0.2.4",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(
                endpoint
                    .validate_resolved_addresses([address.parse().unwrap()])
                    .is_err(),
                "{address} must fail"
            );
        }
        assert!(endpoint
            .validate_resolved_addresses(Vec::<IpAddr>::new())
            .is_err());
    }

    #[test]
    fn deserialization_cannot_bypass_endpoint_policy() {
        let invalid = serde_json::json!({
            "mode": "custom-url",
            "endpoint": {
                "url": "wss://127.0.0.1:9000/v1",
                "approvedHost": "127.0.0.1"
            }
        });
        assert!(serde_json::from_value::<TranscriptionProviderConfig>(invalid).is_err());

        let invalid_keychain = serde_json::json!({
            "mode": "custom-url",
            "endpoint": {
                "url": "wss://stt.example.com/v1",
                "approvedHost": "stt.example.com"
            },
            "credentialRef": {
                "service": "mimir.stt",
                "account": "\n"
            }
        });
        assert!(serde_json::from_value::<TranscriptionProviderConfig>(invalid_keychain).is_err());
    }

    #[test]
    fn configuration_has_only_explicit_local_or_custom_modes() {
        let local = serde_json::json!({
            "mode": "local-managed",
            "modelId": "whisper-large-v3"
        });
        assert!(matches!(
            serde_json::from_value::<TranscriptionProviderConfig>(local).unwrap(),
            TranscriptionProviderConfig::LocalManaged(_)
        ));

        let custom = serde_json::json!({
            "mode": "custom-url",
            "endpoint": {
                "url": "wss://stt.example.com/v1",
                "approvedHost": "stt.example.com"
            }
        });
        assert!(matches!(
            serde_json::from_value::<TranscriptionProviderConfig>(custom).unwrap(),
            TranscriptionProviderConfig::CustomUrl(_)
        ));

        let invented_fallback = serde_json::json!({
            "mode": "automatic",
            "providers": ["local", "cloud"]
        });
        assert!(serde_json::from_value::<TranscriptionProviderConfig>(invented_fallback).is_err());
    }

    #[test]
    fn debug_and_redacted_configuration_do_not_leak_url_path_or_account() {
        let config = TranscriptionProviderConfig::CustomUrl(CustomUrlConfig {
            endpoint: CustomSttEndpoint::new(
                "wss://stt.example.com/customer/acme",
                "stt.example.com",
            )
            .unwrap(),
            credential_ref: Some(
                KeychainCredentialRef::new("mimir.stt", "person@example.com").unwrap(),
            ),
        });
        let debug = format!("{config:?}");
        assert!(debug.contains("stt.example.com"));
        assert!(!debug.contains("customer"));
        assert!(!debug.contains("person@example.com"));
        assert!(!debug.contains("acme"));

        let diagnostic = serde_json::to_string(&config.redacted()).unwrap();
        assert!(diagnostic.contains("credentialConfigured"));
        assert!(!diagnostic.contains("person@example.com"));
    }

    #[test]
    fn managed_endpoint_requires_owned_numeric_loopback_and_fixed_path() {
        let ownership = ManagedSidecarOwnership::from_spawned_child(1234, "launch-123").unwrap();
        let endpoint = ManagedSidecarEndpoint::from_spawned_child(
            "ws://127.0.0.1:43123/mimir-stt/v1/stream",
            ownership.clone(),
        )
        .unwrap();
        assert_eq!(endpoint.ownership().child_pid(), 1234);
        for url in [
            "ws://localhost:43123/mimir-stt/v1/stream",
            "ws://0.0.0.0:43123/mimir-stt/v1/stream",
            "wss://127.0.0.1:43123/mimir-stt/v1/stream",
            "ws://127.0.0.1/mimir-stt/v1/stream",
            "ws://127.0.0.1:43123/other",
            "ws://127.0.0.1:43123/mimir-stt/v1/stream?token=x",
        ] {
            assert!(
                ManagedSidecarEndpoint::from_spawned_child(url, ownership.clone()).is_err(),
                "{url} must fail"
            );
        }
    }

    #[test]
    fn sha256_has_canonical_encoding_and_streaming_calculation() {
        let digest = Sha256Digest::calculate(Cursor::new(b"abc")).unwrap();
        assert_eq!(
            digest.to_string(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest,
            digest.to_string().to_ascii_uppercase().parse().unwrap()
        );
        assert!("0".repeat(63).parse::<Sha256Digest>().is_err());
        assert!("z".repeat(64).parse::<Sha256Digest>().is_err());
    }

    #[test]
    fn model_preflight_checks_platform_disk_and_manifest_bounds() {
        let digest = Sha256Digest::calculate(Cursor::new([1_u8; 4])).unwrap();
        let manifest = manifest(4, digest);
        let required = manifest.required_free_bytes().unwrap();
        assert!(manifest
            .validate_install_preconditions(RuntimePlatform::MACOS_AARCH64, required)
            .is_ok());
        assert_eq!(
            manifest
                .validate_install_preconditions(RuntimePlatform::MACOS_AARCH64, required - 1)
                .unwrap_err()
                .to_string(),
            ModelIntegrityError::InsufficientDiskSpace.to_string()
        );
        assert!(ModelDownloadUrl::new("https://models.example.com/model?token=secret").is_err());
        assert!(manifest
            .download_url
            .validate_resolved_addresses(["::ffff:127.0.0.1".parse().unwrap()])
            .is_err());

        let mut invalid_json = serde_json::to_value(&manifest).unwrap();
        invalid_json["schemaVersion"] = serde_json::json!(99);
        assert!(serde_json::from_value::<ModelManifest>(invalid_json).is_err());
    }

    #[test]
    fn model_is_selectable_only_after_exact_size_and_checksum_verification() {
        let bytes = b"model";
        let digest = Sha256Digest::calculate(Cursor::new(bytes)).unwrap();
        let manifest = manifest(bytes.len() as u64, digest);
        let mut state = ModelDownloadState::begin(
            &manifest,
            RuntimePlatform::MACOS_AARCH64,
            manifest.required_free_bytes().unwrap(),
        )
        .unwrap();
        assert!(!state.selectable_for(&manifest, RuntimePlatform::MACOS_AARCH64));
        state.record_downloaded(bytes.len() as u64).unwrap();
        assert!(!state.selectable_for(&manifest, RuntimePlatform::MACOS_AARCH64));
        state.begin_verification().unwrap();
        assert!(!state.selectable_for(&manifest, RuntimePlatform::MACOS_AARCH64));
        state
            .finish_verification(
                &manifest,
                RuntimePlatform::MACOS_AARCH64,
                bytes.len() as u64,
                digest,
            )
            .unwrap();
        assert!(state.selectable_for(&manifest, RuntimePlatform::MACOS_AARCH64));
        state
            .verify_for_use(
                &manifest,
                RuntimePlatform::MACOS_AARCH64,
                bytes.len() as u64,
                Cursor::new(bytes),
            )
            .unwrap();
    }

    #[test]
    fn invalid_or_changed_model_never_becomes_selectable() {
        let bytes = b"model";
        let digest = Sha256Digest::calculate(Cursor::new(bytes)).unwrap();
        let manifest = manifest(bytes.len() as u64, digest);
        let mut incomplete = ModelDownloadState::begin(
            &manifest,
            RuntimePlatform::MACOS_AARCH64,
            manifest.required_free_bytes().unwrap(),
        )
        .unwrap();
        incomplete.record_downloaded(1).unwrap();
        assert_eq!(
            incomplete.begin_verification().unwrap_err().to_string(),
            ModelIntegrityError::DownloadIncomplete.to_string()
        );
        assert!(matches!(
            incomplete,
            ModelDownloadState::Invalid {
                reason: ModelInvalidReason::Incomplete
            }
        ));

        let mut wrong_checksum = ModelDownloadState::Verifying {
            artifact_bytes: bytes.len() as u64,
        };
        let error = wrong_checksum
            .finish_verification(
                &manifest,
                RuntimePlatform::MACOS_AARCH64,
                bytes.len() as u64,
                "0".repeat(64).parse().unwrap(),
            )
            .unwrap_err();
        assert!(matches!(error, ModelIntegrityError::ChecksumMismatch));
        assert!(!wrong_checksum.selectable_for(&manifest, RuntimePlatform::MACOS_AARCH64));

        let mut tampered = ModelDownloadState::Ready {
            model_id: manifest.model_id.clone(),
            version: manifest.version.clone(),
            platform: RuntimePlatform::MACOS_AARCH64,
            artifact_bytes: manifest.artifact_bytes,
            sha256: manifest.sha256,
        };
        assert!(matches!(
            tampered.verify_for_use(
                &manifest,
                RuntimePlatform::MACOS_AARCH64,
                bytes.len() as u64,
                Cursor::new(b"other"),
            ),
            Err(ModelIntegrityError::ChecksumMismatch)
        ));
        assert!(matches!(
            tampered,
            ModelDownloadState::Invalid {
                reason: ModelInvalidReason::ChecksumMismatch
            }
        ));
    }

    proptest! {
        #[test]
        fn arbitrary_url_queries_never_survive_custom_endpoint(
            token in "[A-Za-z0-9_-]{1,64}"
        ) {
            let url = format!("wss://stt.example.com/v1?token={token}");
            prop_assert!(CustomSttEndpoint::new(&url, "stt.example.com").is_err());
        }

        #[test]
        fn model_progress_never_exceeds_manifest(
            expected in 1_u64..1_000_000,
            first in 0_u64..1_000_000,
            second in 0_u64..1_000_000,
        ) {
            let mut state = ModelDownloadState::Downloading {
                received_bytes: 0,
                expected_bytes: expected,
            };
            let _ = state.record_downloaded(first);
            let _ = state.record_downloaded(second);
            if let ModelDownloadState::Downloading {
                received_bytes,
                expected_bytes,
            } = state {
                prop_assert!(received_bytes <= expected_bytes);
            }
        }
    }
}
