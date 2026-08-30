use super::*;

/// A selected provider. The runtime route is resolved once per recording and
/// reconnects are constrained to the resulting variant.
#[derive(Clone)]
pub enum ResolvedTranscriptionProvider {
    Local {
        model_id: String,
    },
    Custom {
        endpoint: CustomSttEndpoint,
        model: String,
    },
}

impl std::fmt::Debug for ResolvedTranscriptionProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local { model_id } => formatter
                .debug_struct("Local")
                .field("model_id", model_id)
                .finish(),
            Self::Custom { endpoint, model } => formatter
                .debug_struct("Custom")
                .field("endpoint", endpoint)
                .field("model", model)
                .finish(),
        }
    }
}

pub trait TranscriptionProviderResolver: Send + Sync {
    fn resolve(
        &self,
        request: &TranscriptionStart,
    ) -> Result<ResolvedTranscriptionProvider, String>;
}

/// Resolves the current runtime's compact `route` contract. `https://` is
/// accepted as a UI-friendly spelling and converted to `wss://` before the
/// strict endpoint validator runs.
pub struct RuntimeRouteResolver;

impl TranscriptionProviderResolver for RuntimeRouteResolver {
    fn resolve(
        &self,
        request: &TranscriptionStart,
    ) -> Result<ResolvedTranscriptionProvider, String> {
        if request.route == "local" {
            if request.model.trim().is_empty() {
                return Err("the selected local transcription model is empty".into());
            }
            return Ok(ResolvedTranscriptionProvider::Local {
                model_id: request.model.clone(),
            });
        }

        let mut parsed = Url::parse(&request.route)
            .map_err(|_| "the custom transcription URL is invalid".to_string())?;
        if parsed.scheme() == "https" {
            parsed
                .set_scheme("wss")
                .map_err(|_| "the custom transcription URL cannot be converted to wss")?;
        }
        let approved_host = parsed
            .host_str()
            .ok_or_else(|| "the custom transcription URL has no host".to_string())?
            .to_string();
        let endpoint = CustomSttEndpoint::new(parsed.as_str(), &approved_host)
            .map_err(|error| error.to_string())?;
        if request.model.trim().is_empty() {
            return Err("the custom transcription model is empty".into());
        }
        Ok(ResolvedTranscriptionProvider::Custom {
            endpoint,
            model: request.model.clone(),
        })
    }
}

/// Resolves a credential inside the native process. Implementations must never
/// put the returned value into diagnostics, IPC, or persisted configuration.
pub trait MeetingCredentialResolver: Send + Sync {
    fn bearer_token(&self, endpoint: &CustomSttEndpoint) -> Result<Option<String>, String>;
}

/// Notification seam for durable live transcript revisions. Capture and STT
/// remain renderer-independent; the Tauri adapter coalesces this signal into
/// an authoritative snapshot refresh.
pub trait TranscriptionChangeSink: Send + Sync {
    fn changed(&self, meeting_id: &str);

    fn state_changed(&self, meeting_id: &str) {
        self.changed(meeting_id);
    }
}

pub struct NoopTranscriptionChangeSink;

impl TranscriptionChangeSink for NoopTranscriptionChangeSink {
    fn changed(&self, _meeting_id: &str) {}
}

pub struct NoMeetingCredential;

impl MeetingCredentialResolver for NoMeetingCredential {
    fn bearer_token(&self, _endpoint: &CustomSttEndpoint) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// Evidence returned only after a local runner verifies an owned executable,
/// its version, and the exact model artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedLocalRuntime {
    pub runtime_id: String,
    pub runtime_version: String,
    pub model_sha256: String,
}

/// Context for a real local runner. The runner reads the same durable chunks
/// as the custom transport and emits only normalized provider batches.
pub struct LocalTranscriptionContext<'a> {
    pub meeting_id: &'a str,
    pub run_id: &'a str,
    pub model_id: &'a str,
    pub first_sequence: u64,
    pub audio: &'a PersistedAudioSource,
    pub finalize: &'a Receiver<LocalFinalizeCommand>,
    pub sink: &'a mut dyn NormalizedBatchSink,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFinalizeCommand {
    pub observed_at: String,
}

pub trait LocalTranscriber: Send + Sync {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String>;

    /// Runs until `context.finalize` receives a command. A successful silent
    /// run may emit no segments; any emitted partial must still be resolved.
    fn run(&self, context: LocalTranscriptionContext<'_>) -> Result<(), String>;
}

/// Honest default when no verified whisper runtime is installed.
pub struct UnavailableLocalTranscriber;

impl LocalTranscriber for UnavailableLocalTranscriber {
    fn verify(&self, model_id: &str) -> Result<VerifiedLocalRuntime, String> {
        Err(format!(
            "local transcription model '{model_id}' is unavailable or its runtime has not been verified"
        ))
    }

    fn run(&self, _context: LocalTranscriptionContext<'_>) -> Result<(), String> {
        Err("local transcription cannot run without a verified owned runtime".into())
    }
}

pub trait NormalizedBatchSink {
    fn ingest(&mut self, batch: NormalizedTranscriptBatch) -> Result<(), String>;
    fn final_segment_count(&self) -> u64;
}
