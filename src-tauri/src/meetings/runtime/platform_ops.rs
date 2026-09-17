use super::*;

impl MeetingRuntime {
    pub fn update_meeting(
        &self,
        meeting_id: &str,
        patch: MeetingUpdatePatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner.store.get_meeting(meeting_id)?;
        validate_update_patch(&patch)?;
        self.inner
            .platform
            .update_content(meeting_id, &patch)
            .map_err(|message| port_error("meeting content update", message))?;
        if patch.summary.is_some() {
            self.inner.store.mark_summary_reviewed(meeting_id)?;
        }
        self.publish_unlocked("meeting-updated", Some(meeting_id.into()), None)
    }

    pub(crate) fn apply_generated_summary(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        patch: MeetingUpdatePatch,
    ) -> Result<(), MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if meeting.status != MeetingStatus::Completed
            || meeting.transcript_revision != transcript_revision
            || !self.transcript_is_final(&meeting)?
        {
            return Err(MeetingRuntimeError::Validation(
                "Recording changed while the summary was being created".into(),
            ));
        }
        validate_update_patch(&patch)?;
        self.inner
            .platform
            .update_content(meeting_id, &patch)
            .map_err(|message| port_error("meeting summary update", message))?;
        self.inner.store.mark_summary_reviewed(meeting_id)?;
        self.publish_unlocked("meeting-updated", Some(meeting_id.into()), None)?;
        Ok(())
    }

    pub(crate) fn filing_source(
        &self,
        meeting_id: &str,
    ) -> Result<MeetingFilingSource, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        if record.status != MeetingStatus::Completed {
            return Err(MeetingRuntimeError::Validation(
                "only a completed meeting can be filed to Graph".into(),
            ));
        }
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        let summary = content
            .summary
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "the meeting summary must finish before filing to Graph".into(),
                )
            })?;
        Ok(MeetingFilingSource {
            id: record.id.clone(),
            title: content.title.unwrap_or_else(|| record.title.clone()),
            summary,
            started_at: record.started_at.clone(),
            duration_ms: duration_ms(&record),
            graph_node_id: content.graph_node_id,
        })
    }

    pub(crate) fn link_graph_node(
        &self,
        meeting_id: &str,
        graph_node_id: &str,
    ) -> Result<(), MeetingRuntimeError> {
        let source = self.filing_source(meeting_id)?;
        if source
            .graph_node_id
            .as_deref()
            .is_some_and(|existing| existing != graph_node_id)
        {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is already linked to Graph item '{}'",
                source.graph_node_id.unwrap_or_default()
            )));
        }
        self.inner
            .platform
            .update_content(
                meeting_id,
                &MeetingUpdatePatch {
                    graph_node_id: Some(graph_node_id.into()),
                    ..MeetingUpdatePatch::default()
                },
            )
            .map_err(|message| port_error("meeting Graph link update", message))?;
        let _ = self.publish_unlocked("meeting-filed", Some(meeting_id.into()), None)?;
        Ok(())
    }

    pub fn update_config(
        &self,
        patch: MeetingConfigPatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        validate_config_patch(&patch)?;
        self.inner
            .platform
            .update_config(&patch)
            .map_err(|message| port_error("meeting config update", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn set_api_key(&self, api_key: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        if api_key.trim().is_empty() {
            return Err(MeetingRuntimeError::Validation(
                "transcription API key cannot be empty".into(),
            ));
        }
        self.inner
            .platform
            .set_api_key(api_key.trim())
            .map_err(|message| port_error("meeting API key update", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn clear_api_key(&self) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner
            .platform
            .clear_api_key()
            .map_err(|message| port_error("meeting API key removal", message))?;
        self.publish_unlocked("config-changed", None, None)
    }

    pub fn install_model(&self, model_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(model_id, "model id")?;
        self.inner
            .platform
            .install_model(model_id)
            .map_err(|message| port_error("meeting model install", message))?;
        self.publish_unlocked("model-changed", None, None)
    }

    pub fn delete_model(&self, model_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(model_id, "model id")?;
        self.inner
            .platform
            .delete_model(model_id)
            .map_err(|message| port_error("meeting model deletion", message))?;
        self.publish_unlocked("model-changed", None, None)
    }

    pub fn delete(
        &self,
        meeting_id: &str,
        mode: MeetingDeleteMode,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let is_active = {
            self.active()?
                .as_ref()
                .is_some_and(|active| active.meeting_id == meeting_id)
        };
        let draining = self
            .inner
            .drains
            .lock()
            .map_err(|_| port_error("transcript drains", "mutex poisoned".into()))?
            .get(meeting_id)
            .is_some_and(|drain| !drain.runs.is_empty());
        if is_active || (draining && mode == MeetingDeleteMode::Audio) {
            return Err(MeetingRuntimeError::Validation(
                "stop and finalize the active meeting before deleting it".into(),
            ));
        }
        if self.inner.store.deletion(meeting_id)?.is_none() {
            self.inner.store.get_meeting(meeting_id)?;
        }
        let mut deletion = self.inner.store.begin_deletion_with_capture_hold(
            meeting_id,
            match mode {
                MeetingDeleteMode::Audio => StoreDeletionMode::Audio,
                MeetingDeleteMode::All => StoreDeletionMode::All,
            },
            &self.inner.clock.now(),
            draining,
        )?;
        if mode == MeetingDeleteMode::All && !draining {
            deletion = self
                .inner
                .store
                .release_deleted_capture(meeting_id, &self.inner.clock.now())?;
        }
        if deletion.stage == MeetingDeletionStage::WaitingForJobs {
            // The tombstone is the user-visible deletion boundary. It already
            // hides the meeting, rejects new work, and cancels pending jobs.
            // A running Activity keeps only its process lease until it exits;
            // physical cleanup resumes from finish_job or launch recovery.
            return self.publish_unlocked(
                "meeting-deletion-pending",
                Some(meeting_id.into()),
                None,
            );
        }
        if let Err(message) = self.inner.platform.delete_meeting(meeting_id, mode) {
            if mode == MeetingDeleteMode::Audio {
                return Err(port_error("meeting deletion", message));
            }
            // The deletion is already durable. Cleanup failure must not undo
            // the user's request or restore the meeting in the renderer.
            self.inner.store.record_deletion_error(
                meeting_id,
                &bounded_error(&message),
                &self.inner.clock.now(),
            )?;
        }
        self.publish_unlocked("meeting-deleted", Some(meeting_id.into()), None)
    }

    pub fn export(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner.store.get_meeting(meeting_id)?;
        self.inner
            .platform
            .export_meeting(meeting_id, format)
            .map_err(|message| port_error("meeting export", message))
    }

    pub(super) fn publish_unlocked(
        &self,
        kind: &str,
        meeting_id: Option<String>,
        run_id: Option<String>,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let revision = self.publish_event_unlocked(kind, meeting_id, run_id)?;
        self.snapshot_unlocked(revision)
    }

    pub(super) fn publish_start_unlocked(
        &self,
        kind: &str,
        record: &MeetingRecord,
        projection: &MeetingPlatformProjection,
        run_id: String,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let active = self.active()?.clone();
        let content = self
            .inner
            .platform
            .content(&record.id)
            .map_err(|message| port_error("meeting content projection", message))?;
        let meeting = self.meeting_view(
            record,
            &content,
            active.as_ref(),
            &projection.config.kg_prompt,
        )?;
        let revision = self.publish_event_unlocked(kind, Some(record.id.clone()), Some(run_id))?;
        let runtime_diagnostic = self.diagnostic()?.clone();

        Ok(MeetingSnapshot {
            revision,
            meetings: vec![meeting],
            start_projection: true,
            meetings_truncated: false,
            next_meetings_before: None,
            active_meeting_id: Some(record.id.clone()),
            candidates: Vec::new(),
            config: projection.config.clone(),
            permissions: projection.permissions.clone(),
            models: projection.models.clone(),
            diagnostic: runtime_diagnostic.or_else(|| projection.diagnostic.clone()),
        })
    }

    fn publish_event_unlocked(
        &self,
        kind: &str,
        meeting_id: Option<String>,
        run_id: Option<String>,
    ) -> Result<u64, MeetingRuntimeError> {
        let revision = self.inner.revision.fetch_add(1, Ordering::AcqRel) + 1;
        let event = MeetingEvent {
            revision,
            run_id,
            meeting_id,
            kind: kind.into(),
            // Events are compact invalidations. The authoritative bounded
            // snapshot is read once by the renderer after coalescing bursts.
            snapshot: None,
        };
        if let Err(error) = self.inner.events.publish(&event) {
            self.set_diagnostic(format!(
                "Meeting state is durable but renderer notification failed: {}",
                bounded_error(&error)
            ))?;
        }
        Ok(revision)
    }

    pub(super) fn interrupt_after_stop_failure(
        &self,
        meeting_id: &str,
        run_id: &str,
        expected_revision: u64,
        code: &str,
        message: &str,
    ) -> Result<(), MeetingRuntimeError> {
        let current = self.inner.store.get_meeting(meeting_id)?;
        let revision = if current.revision == expected_revision {
            expected_revision
        } else {
            current.revision
        };
        self.inner.store.transition_meeting(
            meeting_id,
            revision,
            MeetingStatus::Interrupted,
            &self.inner.clock.now(),
            current.failure.as_ref(),
        )?;
        if self
            .active()?
            .as_ref()
            .is_some_and(|capture| capture.meeting_id == meeting_id && capture.run_id == run_id)
        {
            *self.active()? = None;
        }
        self.set_diagnostic(format!("{code}: {}", bounded_error(message)))?;
        let _ = self.publish_unlocked(
            "meeting-interrupted",
            Some(meeting_id.into()),
            Some(run_id.into()),
        )?;
        Ok(())
    }

    pub(super) fn platform_projection(
        &self,
    ) -> Result<MeetingPlatformProjection, MeetingRuntimeError> {
        self.inner
            .platform
            .projection()
            .map_err(|message| port_error("meeting platform projection", message))
    }

    pub(super) fn hook_config(&self) -> Result<MeetingHookConfig, MeetingRuntimeError> {
        self.inner
            .platform
            .hook_config()
            .map_err(|message| port_error("meeting hook configuration", message))
    }

    pub(super) fn operation(&self) -> Result<MutexGuard<'_, ()>, MeetingRuntimeError> {
        self.inner
            .operation
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    pub(super) fn active(
        &self,
    ) -> Result<MutexGuard<'_, Option<ActiveCapture>>, MeetingRuntimeError> {
        self.inner
            .active
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    pub(super) fn diagnostic(&self) -> Result<MutexGuard<'_, Option<String>>, MeetingRuntimeError> {
        self.inner
            .diagnostic
            .lock()
            .map_err(|_| MeetingRuntimeError::Poisoned)
    }

    pub(super) fn set_diagnostic(&self, diagnostic: String) -> Result<(), MeetingRuntimeError> {
        *self.diagnostic()? = Some(diagnostic);
        Ok(())
    }
}
