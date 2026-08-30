use super::*;

impl NativeMeetingPlatform {
    pub(super) fn content_path(&self, meeting_id: &str) -> Result<PathBuf, String> {
        validate_component(meeting_id, "meeting id")?;
        prepare_private_file_path(&self.inner.paths.content_root, format!("{meeting_id}.json"))
            .map_err(|error| format!("Could not resolve private meeting content path: {error}"))
    }

    pub(super) fn load_content(&self, meeting_id: &str) -> Result<PersistedMeetingContent, String> {
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
    pub(super) fn content_load_count(&self) -> usize {
        self.inner
            .content_loads
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn default_content(
        &self,
        meeting_id: &str,
    ) -> Result<PersistedMeetingContent, String> {
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

    pub(super) fn save_content(
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

    pub(super) fn reconcile_content_search(&self) -> Result<(), String> {
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

    pub(super) fn delete_meeting_files(
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

    pub(super) fn drive_deletion_locked(
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

    pub(super) fn persist_deleted_content_marker(&self, meeting_id: &str) -> Result<(), String> {
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

    pub(super) fn maybe_fail_deletion(&self, point: &'static str) -> Result<(), String> {
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
    pub(super) fn inject_deletion_fault(&self, point: &'static str) {
        *self.inner.deletion_fault.lock().unwrap() = Some(point);
    }
}
