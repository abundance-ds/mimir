use super::*;

impl MeetingPlatformPort for NativeMeetingPlatform {
    fn projection(&self) -> Result<MeetingPlatformProjection, String> {
        let mut config = self.load_config()?;
        config.api_key_configured = configured_custom_stt_endpoint(&config)?
            .map(|endpoint| self.cached_custom_secret(&endpoint))
            .transpose()?
            .flatten()
            .is_some();
        let mut environment = self.inner.environment.projection()?;
        // Native consent checks use this projection, including while the worker
        // is processing an exclusion update.
        environment.candidates.retain(|candidate| {
            !config
                .ignored_apps
                .iter()
                .any(|app| app.app_id.eq_ignore_ascii_case(&candidate.app_id))
        });
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

    fn hook_config(&self) -> Result<MeetingHookConfig, String> {
        self.load_config()
            .map(|config| MeetingHookConfig::from(&config))
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
            notes: content.notes,
            tags: content.tags,
            workspace_path: content.workspace_path,
            source_app: content.source_app,
            kg_decision: content.kg_decision,
            graph_node_id: content.graph_node_id,
            graph_draft: content.graph_draft,
            deleted: content.deleted,
        })
    }

    fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        let previous_config = self.load_config()?;
        let mut config = previous_config.clone();
        let previous_endpoint = stored_custom_stt_endpoint(&previous_config)?;
        if let Some(value) = &patch.ignored_apps {
            config.ignored_apps = value.clone();
        }
        if let Some(value) = patch.detection_enabled {
            config.detection_enabled = value;
        }
        if let Some(value) = patch.auto_record {
            config.auto_record = value;
        }
        if let Some(value) = &patch.microphone_device_id {
            config.microphone_device_id = value.clone();
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
        if let Some(value) = &patch.summary_template {
            config.summary_template = value.trim().to_string();
        }
        if let Some(value) = &patch.summary_prompt {
            config.summary_prompt = value.clone();
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
        let ignored_apps = config.ignored_apps.clone();
        let persist = (|| {
            if previous_endpoint != next_endpoint {
                // Clear before publishing the route. If Keychain access
                // fails, the old configuration remains authoritative and no
                // new endpoint can receive the old secret. Losing a secret
                // after a later atomic config-write failure is safe and
                // explicit re-entry repairs it.
                self.inner.secrets.clear()?;
                self.invalidate_credential_cache()?;
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
        if ignored_apps != previous_config.ignored_apps {
            self.inner.environment.set_ignored_apps(&ignored_apps);
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
        self.invalidate_credential_cache()?;
        store_and_verify_secret(self.inner.secrets.as_ref(), &endpoint, secret)?;
        self.cache_custom_secret(&endpoint, Some(secret.to_string()))
    }

    fn clear_api_key(&self) -> Result<(), String> {
        let _operation = lock(&self.inner.operation)?;
        let endpoint = configured_custom_stt_endpoint(&self.load_config()?)?;
        self.inner.secrets.clear()?;
        match endpoint {
            Some(endpoint) => self.cache_custom_secret(&endpoint, None),
            None => self.invalidate_credential_cache(),
        }
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
            content.title_user_set = true;
        } else if let Some(value) = &patch.generated_title {
            if !content.title_user_set {
                content.title = Some(value.trim().to_string());
            }
        }
        if let Some(value) = &patch.summary {
            content.summary = Some(value.trim().to_string());
        }
        if let Some(value) = &patch.notes {
            content.notes = value.clone();
        }
        if let Some(value) = &patch.tags {
            content.tags = value.iter().map(|tag| tag.trim().to_string()).collect();
        }
        if let Some(value) = &patch.graph_node_id {
            content.graph_node_id = Some(value.trim().to_string());
        }
        if let Some(value) = &patch.graph_draft {
            content.graph_draft = value.clone();
        }
        validate_content_fields(
            content.title.as_deref(),
            content.summary.as_deref(),
            &content.notes,
            &content.tags,
            content.kg_decision.as_deref(),
            content.graph_node_id.as_deref(),
            &content.graph_draft,
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
            MeetingExportFormat::Files => self.export_files(meeting_id),
        }
    }
}
