use super::*;

impl MeetingStore {
    pub fn has_retention_hold(&self, meeting_id: &str) -> Result<bool, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let held = connection.query_row(
            "SELECT
               EXISTS(
                 SELECT 1 FROM follow_up_jobs
                 WHERE meeting_id=?1 AND state IN ('pending','running')
               )
               OR EXISTS(
                 SELECT 1 FROM audio_chunks
                 WHERE meeting_id=?1 AND status='staged'
               )
               OR EXISTS(
                 SELECT 1 FROM transcript_repair_runs
                 WHERE meeting_id=?1 AND state='collecting'
               )",
            [meeting_id],
            |row| row.get::<_, bool>(0),
        )?;
        Ok(held)
    }

    /// Begin an irreversible, crash-replayable deletion.
    ///
    /// The tombstone and pending-job cancellation share one `IMMEDIATE`
    /// transaction. A permanent deletion is therefore hidden from readers
    /// before another worker can claim work for it. Running jobs retain their
    /// lease: their Activity may still own a process and output file, so the
    /// deletion waits until that worker reaches a terminal lease boundary.
    pub fn begin_deletion(
        &self,
        meeting_id: &str,
        mode: MeetingDeletionMode,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = load_deletion_optional_tx(&transaction, meeting_id)? {
            if existing.mode != mode {
                return Err(MeetingStoreError::Validation(format!(
                    "meeting '{meeting_id}' already has a {} deletion in progress",
                    existing.mode.storage_key()
                )));
            }
            let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
            transaction.commit()?;
            return Ok(deletion);
        }
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM meetings WHERE id=?1",
                [meeting_id],
                |row| row.get(0),
            )
            .optional()?;
        let status = status.ok_or_else(|| not_found("meeting", meeting_id))?;
        if matches!(status.as_str(), "recording" | "stopping" | "finalizing") {
            return Err(MeetingStoreError::Validation(
                "an active meeting cannot be deleted".into(),
            ));
        }

        if mode == MeetingDeletionMode::Audio {
            let staged_chunks: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM audio_chunks
                   WHERE meeting_id=?1 AND status='staged'
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            let transcription_jobs: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM follow_up_jobs
                   WHERE meeting_id=?1
                     AND kind='custom:transcription'
                     AND state IN ('pending','running')
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            let collecting_repair: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM transcript_repair_runs
                   WHERE meeting_id=?1 AND state='collecting'
                 )",
                [meeting_id],
                |row| row.get(0),
            )?;
            if staged_chunks || transcription_jobs || collecting_repair {
                return Err(MeetingStoreError::Validation(
                    "source audio is held by transcription recovery; finish or resolve recovery before deleting it"
                        .into(),
                ));
            }
        }

        let running_jobs = if mode == MeetingDeletionMode::All {
            running_job_count_tx(&transaction, meeting_id)?
        } else {
            0
        };
        transaction.execute(
            "INSERT INTO meeting_deletions (
               meeting_id,mode,stage,requested_at,updated_at,last_error
             ) VALUES (?1,?2,?3,?4,?4,NULL)",
            params![
                meeting_id,
                mode.storage_key(),
                if running_jobs == 0 {
                    MeetingDeletionStage::FilesPending.storage_key()
                } else {
                    MeetingDeletionStage::WaitingForJobs.storage_key()
                },
                observed_at
            ],
        )?;
        if mode == MeetingDeletionMode::All {
            transaction.execute(
                "UPDATE follow_up_jobs SET
                   state='cancelled',lease_owner=NULL,lease_token=NULL,
                   lease_expires_at=NULL,last_error='cancelled by permanent meeting deletion',
                   updated_at=?2
                 WHERE meeting_id=?1 AND state='pending'",
                params![meeting_id, observed_at],
            )?;
        }
        let mut existing = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("inserted meeting deletion must exist");
        existing.running_jobs = running_jobs;
        let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn deletion(&self, meeting_id: &str) -> Result<Option<MeetingDeletion>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        load_deletion_optional(&connection, meeting_id)
    }

    pub fn pending_deletions(&self) -> Result<Vec<MeetingDeletion>, MeetingStoreError> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT meeting_id FROM meeting_deletions ORDER BY requested_at,meeting_id")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|meeting_id| {
                load_deletion_optional(&connection, &meeting_id)?
                    .ok_or_else(|| not_found("meeting deletion", &meeting_id))
            })
            .collect()
    }

    /// Recheck process-owned job leases without weakening their ownership.
    pub fn refresh_deletion(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        let deletion = refresh_deletion_tx(&transaction, existing, &observed_at)?;
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn record_deletion_error(
        &self,
        meeting_id: &str,
        detail: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        if detail.trim().is_empty() || detail.len() > 16_384 {
            return Err(MeetingStoreError::Validation(
                "deletion error must contain 1 to 16384 bytes".into(),
            ));
        }
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = transaction.execute(
            "UPDATE meeting_deletions
             SET last_error=?2,updated_at=?3 WHERE meeting_id=?1",
            params![meeting_id, detail.trim(), observed_at],
        )?;
        if updated != 1 {
            return Err(not_found("meeting deletion", meeting_id));
        }
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("updated meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
    }

    /// Advance after the private file owner has durably removed its owned
    /// artifacts. This boundary is persisted before SQLite authority changes.
    pub fn mark_deletion_files_removed(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        self.advance_deletion(
            meeting_id,
            MeetingDeletionStage::FilesPending,
            MeetingDeletionStage::DatabasePending,
            observed_at,
        )
    }

    /// Remove the SQLite-owned meeting/audio authority only after file removal
    /// is durable. The independent deletion journal intentionally survives the
    /// cascade so marker cleanup can be retried after a crash.
    pub fn remove_deletion_database_authority(
        &self,
        meeting_id: &str,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != MeetingDeletionStage::DatabasePending {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion database boundary requires database-pending, found {}",
                deletion.stage.storage_key()
            )));
        }
        match deletion.mode {
            MeetingDeletionMode::Audio => {
                transaction
                    .execute("DELETE FROM audio_chunks WHERE meeting_id=?1", [meeting_id])?;
            }
            MeetingDeletionMode::All => {
                let running_jobs = running_job_count_tx(&transaction, meeting_id)?;
                if running_jobs != 0 {
                    return Err(MeetingStoreError::DeletionBlocked {
                        meeting_id: meeting_id.into(),
                        running_jobs,
                    });
                }
                transaction.execute("DELETE FROM meetings WHERE id=?1", [meeting_id])?;
            }
        }
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage='marker-cleanup-pending',updated_at=?2,last_error=NULL
             WHERE meeting_id=?1",
            params![meeting_id, observed_at],
        )?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("advanced meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
    }

    pub fn complete_deletion(&self, meeting_id: &str) -> Result<(), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != MeetingDeletionStage::MarkerCleanupPending {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion cannot complete from {}",
                deletion.stage.storage_key()
            )));
        }
        transaction.execute(
            "DELETE FROM meeting_deletions WHERE meeting_id=?1",
            [meeting_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn advance_deletion(
        &self,
        meeting_id: &str,
        expected: MeetingDeletionStage,
        next: MeetingDeletionStage,
        observed_at: &str,
    ) -> Result<MeetingDeletion, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .ok_or_else(|| not_found("meeting deletion", meeting_id))?;
        if deletion.stage != expected {
            return Err(MeetingStoreError::Validation(format!(
                "meeting deletion expected {}, found {}",
                expected.storage_key(),
                deletion.stage.storage_key()
            )));
        }
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage=?2,updated_at=?3,last_error=NULL WHERE meeting_id=?1",
            params![meeting_id, next.storage_key(), observed_at],
        )?;
        let deletion = load_deletion_optional_tx(&transaction, meeting_id)?
            .expect("advanced meeting deletion must exist");
        transaction.commit()?;
        Ok(deletion)
    }
}
