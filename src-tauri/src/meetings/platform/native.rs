use super::*;

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
                credential_cache: Mutex::new(None),
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
        platform
            .inner
            .environment
            .set_ignored_apps(&config.ignored_apps);
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
        self.cached_custom_secret(endpoint)
    }

    pub(super) fn cached_custom_secret(
        &self,
        endpoint: &CustomSttEndpoint,
    ) -> Result<Option<String>, String> {
        let binding = endpoint.credential_binding();
        let mut cache = lock(&self.inner.credential_cache)?;
        if let Some(cached) = cache.as_ref() {
            if cached.endpoint_binding == binding {
                return Ok(cached.secret.clone());
            }
        }

        // Keychain reads can display a macOS authorization dialog. Cache both
        // presence and absence for this process so snapshots and transcript
        // events never turn one user action into repeated password prompts.
        let secret = self.inner.secrets.read(endpoint)?;
        *cache = Some(CachedMeetingSecret {
            endpoint_binding: binding,
            secret: secret.clone(),
        });
        Ok(secret)
    }

    pub(super) fn cache_custom_secret(
        &self,
        endpoint: &CustomSttEndpoint,
        secret: Option<String>,
    ) -> Result<(), String> {
        *lock(&self.inner.credential_cache)? = Some(CachedMeetingSecret {
            endpoint_binding: endpoint.credential_binding(),
            secret,
        });
        Ok(())
    }

    pub(super) fn invalidate_credential_cache(&self) -> Result<(), String> {
        *lock(&self.inner.credential_cache)? = None;
        Ok(())
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
                    crate::meetings::MeetingStatus::Detected
                        | crate::meetings::MeetingStatus::Recording
                        | crate::meetings::MeetingStatus::Stopping
                        | crate::meetings::MeetingStatus::Finalizing
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

    pub(super) fn load_config(&self) -> Result<MeetingConfig, String> {
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

    pub(super) fn save_config(&self, config: MeetingConfig) -> Result<(), String> {
        let persisted = PersistedMeetingConfig::new(config)?;
        write_private_json_atomic(&self.inner.paths.config_file, &persisted)
            .map_err(|error| error.to_string())
    }
}
