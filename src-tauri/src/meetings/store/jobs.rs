use super::*;

impl MeetingStore {
    pub fn enqueue_job(
        &self,
        job: &FollowUpJobDraft,
        observed_at: &str,
    ) -> Result<(FollowUpJob, bool), MeetingStoreError> {
        validate_job_draft(job).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let not_before = timestamp(&job.not_before)?;
        let request_hash = job_fingerprint(job, &not_before)?;
        let payload = json(job.payload.clone())?;
        let kind = job.kind.as_storage_key();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_meeting_tx(&transaction, &job.meeting_id)?;
        if deletion_blocks_job_tx(&transaction, &job.meeting_id, &job.kind)? {
            return Err(deletion_in_progress_tx(&transaction, &job.meeting_id)?);
        }
        if let Some((existing, existing_hash)) =
            load_job_by_idempotency_tx(&transaction, &job.meeting_id, &job.idempotency_key)?
        {
            if existing_hash == request_hash {
                transaction.commit()?;
                return Ok((existing, true));
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: job.idempotency_key.clone(),
            });
        }
        transaction.execute(
            "INSERT INTO follow_up_jobs (
               id,meeting_id,kind,idempotency_key,request_hash,payload_json,state,
               attempts,max_attempts,not_before,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,'pending',0,?7,?8,?9,?9)",
            params![
                job.id,
                job.meeting_id,
                kind,
                job.idempotency_key,
                request_hash,
                payload,
                job.max_attempts,
                not_before,
                observed_at
            ],
        )?;
        let stored = load_job_tx(&transaction, &job.id)?;
        transaction.commit()?;
        Ok((stored, false))
    }

    pub fn claim_next_job(
        &self,
        worker_id: &str,
        observed_at: &str,
        lease_expires_at: &str,
    ) -> Result<Option<FollowUpJob>, MeetingStoreError> {
        validate_id(worker_id, "worker id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let lease_expires_at = timestamp(lease_expires_at)?;
        if lease_expires_at <= observed_at {
            return Err(MeetingStoreError::Validation(
                "job lease must expire after it is claimed".into(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        release_expired_jobs(&transaction, &observed_at)?;
        let job_id: Option<String> = transaction
            .query_row(
                "SELECT j.id FROM follow_up_jobs j
                 WHERE j.state='pending'
                   AND j.not_before<=?1
                   AND j.attempts<j.max_attempts
                   AND NOT EXISTS (
                     SELECT 1 FROM meeting_deletions d
                     WHERE d.meeting_id=j.meeting_id
                       AND (
                         d.mode='all'
                         OR (d.mode='audio' AND j.kind='custom:transcription')
                       )
                   )
                 ORDER BY not_before,created_at,id LIMIT 1",
                [&observed_at],
                |row| row.get(0),
            )
            .optional()?;
        let Some(job_id) = job_id else {
            transaction.commit()?;
            return Ok(None);
        };
        let lease_token = Uuid::new_v4().to_string();
        let updated = transaction.execute(
            "UPDATE follow_up_jobs SET
               state='running',attempts=attempts+1,lease_owner=?2,lease_token=?3,
               lease_expires_at=?4,updated_at=?5
             WHERE id=?1 AND state='pending'",
            params![
                job_id,
                worker_id,
                lease_token,
                lease_expires_at,
                observed_at
            ],
        )?;
        if updated != 1 {
            return Err(MeetingStoreError::LeaseLost { job_id });
        }
        let job = load_job_tx(&transaction, &job_id)?;
        transaction.commit()?;
        Ok(Some(job))
    }

    pub fn finish_job(
        &self,
        job_id: &str,
        lease_token: &str,
        outcome: &JobFinish,
        observed_at: &str,
    ) -> Result<FollowUpJob, MeetingStoreError> {
        validate_id(job_id, "job id").map_err(MeetingStoreError::Validation)?;
        validate_id(lease_token, "job lease token").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_job_tx(&transaction, job_id)?;
        if current.state != JobState::Running || current.lease_token.as_deref() != Some(lease_token)
        {
            return Err(MeetingStoreError::LeaseLost {
                job_id: job_id.into(),
            });
        }
        let permanent_deletion: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM meeting_deletions
               WHERE meeting_id=?1 AND mode='all'
             )",
            [&current.definition.meeting_id],
            |row| row.get(0),
        )?;
        if permanent_deletion {
            transaction.execute(
                "UPDATE follow_up_jobs SET
                   state='cancelled',result_json=NULL,
                   last_error='result discarded by permanent meeting deletion',
                   lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?2
                 WHERE id=?1",
                params![job_id, observed_at],
            )?;
            let deletion = load_deletion_optional_tx(&transaction, &current.definition.meeting_id)?
                .expect("permanent deletion query guaranteed a journal row");
            refresh_deletion_tx(&transaction, deletion, &observed_at)?;
            let job = load_job_tx(&transaction, job_id)?;
            transaction.commit()?;
            return Ok(job);
        }
        let meeting = load_meeting_tx(&transaction, &current.definition.meeting_id)?;
        if current.definition.kind == FollowUpJobKind::Summary
            && current
                .definition
                .payload
                .get("transcriptRevision")
                .and_then(Value::as_u64)
                .is_some_and(|revision| revision != meeting.transcript_revision)
        {
            transaction.execute(
                "UPDATE follow_up_jobs SET state='cancelled',result_json=NULL,
                 last_error='recording changed while summary was running',
                 lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?2 WHERE id=?1",
                params![job_id, observed_at],
            )?;
            let job = load_job_tx(&transaction, job_id)?;
            transaction.commit()?;
            return Ok(job);
        }
        match outcome {
            JobFinish::Succeeded { result } => {
                validate_job_result(result).map_err(MeetingStoreError::Validation)?;
                transaction.execute(
                    "UPDATE follow_up_jobs SET
                       state='succeeded',result_json=?2,last_error=NULL,
                       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?3
                     WHERE id=?1",
                    params![job_id, json(result)?, observed_at],
                )?;
            }
            JobFinish::Failed {
                error,
                retryable,
                retry_at,
            } => {
                if error.trim().is_empty() || error.len() > 16_384 {
                    return Err(MeetingStoreError::Validation(
                        "job error must contain 1 to 16384 bytes".into(),
                    ));
                }
                let retry = *retryable && current.attempts < current.definition.max_attempts;
                let retry_at = if retry {
                    timestamp(retry_at.as_deref().unwrap_or(&observed_at))?
                } else {
                    observed_at.clone()
                };
                transaction.execute(
                    "UPDATE follow_up_jobs SET
                       state=?2,not_before=?3,last_error=?4,result_json=NULL,
                       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?5
                     WHERE id=?1",
                    params![
                        job_id,
                        if retry { "pending" } else { "failed" },
                        retry_at,
                        error,
                        observed_at
                    ],
                )?;
            }
        }
        let job = load_job_tx(&transaction, job_id)?;
        transaction.commit()?;
        Ok(job)
    }

    pub fn cancel_job(
        &self,
        job_id: &str,
        observed_at: &str,
    ) -> Result<FollowUpJob, MeetingStoreError> {
        validate_id(job_id, "job id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_job_tx(&transaction, job_id)?;
        if matches!(
            current.state,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled
        ) {
            transaction.commit()?;
            return Ok(current);
        }
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state='cancelled',lease_owner=NULL,lease_token=NULL,
               lease_expires_at=NULL,updated_at=?2
             WHERE id=?1",
            params![job_id, observed_at],
        )?;
        let job = load_job_tx(&transaction, job_id)?;
        transaction.commit()?;
        Ok(job)
    }

    pub fn list_jobs(&self, meeting_id: &str) -> Result<Vec<FollowUpJob>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let mut statement = connection
            .prepare("SELECT id FROM follow_up_jobs WHERE meeting_id=?1 ORDER BY created_at,id")?;
        let ids = statement
            .query_map([meeting_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|job_id| load_job(&connection, &job_id))
            .collect()
    }

    /// Reconcile process-owned state after an unclean or ordinary application
    /// restart. The transaction is intentionally idempotent:
    ///
    /// - active capture/finalization becomes `interrupted`;
    /// - every running job loses its process lease and is requeued unless its
    ///   attempt budget is exhausted;
    /// - staged chunks are reported but never guessed to be committed or
    ///   corrupt without a capture adapter checking their bytes.
    pub fn recover_after_restart(
        &self,
        observed_at: &str,
    ) -> Result<RecoveryReport, MeetingStoreError> {
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let interrupted_meeting_ids = query_strings(
            &transaction,
            "SELECT id FROM meetings
             WHERE status IN ('recording','stopping','finalizing') ORDER BY id",
        )?;
        let recovery_stops = {
            let mut statement = transaction.prepare(
                "SELECT m.id,m.started_at,m.stopped_at,MAX(a.end_ms)
                 FROM meetings m
                 LEFT JOIN audio_chunks a
                   ON a.meeting_id=m.id AND a.status='committed'
                 WHERE m.status IN ('recording','stopping','finalizing')
                 GROUP BY m.id,m.started_at,m.stopped_at
                 ORDER BY m.id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (meeting_id, started_at, stopped_at, last_committed_end_ms) in recovery_stops {
            if stopped_at.is_some() {
                continue;
            }
            let recovered_stop = if let Some(started_at) = started_at {
                let started = DateTime::parse_from_rfc3339(&started_at).map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid start timestamp: {error}"
                    ))
                })?;
                started
                    .checked_add_signed(chrono::Duration::milliseconds(
                        last_committed_end_ms.unwrap_or(0),
                    ))
                    .ok_or_else(|| {
                        MeetingStoreError::Validation(format!(
                            "meeting '{meeting_id}' committed audio duration overflows its timestamp"
                        ))
                    })?
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            } else {
                // A live meeting should always have a start timestamp. Keep a
                // corrupt legacy row recoverable without inventing an earlier
                // wall-clock time than the only durable observation.
                observed_at.clone()
            };
            transaction.execute(
                "UPDATE meetings SET stopped_at=?2 WHERE id=?1 AND stopped_at IS NULL",
                params![meeting_id, recovered_stop],
            )?;
        }
        transaction.execute(
            "UPDATE meetings SET
               status='interrupted',interrupted_at=?1,
               interruption_reason='application-restarted',
               recovery_count=recovery_count+1,revision=revision+1,updated_at=?1
             WHERE status IN ('recording','stopping','finalizing')",
            [&observed_at],
        )?;

        let requeued_job_ids = query_strings(
            &transaction,
            "SELECT j.id FROM follow_up_jobs j
             WHERE j.state='running' AND j.attempts<j.max_attempts
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=j.meeting_id AND d.mode='all'
               )
             ORDER BY j.id",
        )?;
        let failed_job_ids = query_strings(
            &transaction,
            "SELECT j.id FROM follow_up_jobs j
             WHERE j.state='running' AND j.attempts>=j.max_attempts
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=j.meeting_id AND d.mode='all'
               )
             ORDER BY j.id",
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
               not_before=CASE WHEN attempts>=max_attempts THEN not_before ELSE ?1 END,
               last_error='worker lease lost during application restart',
               lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?1
             WHERE state='running'
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
               )",
            [&observed_at],
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state='cancelled',last_error='cancelled by permanent meeting deletion after restart',
               result_json=NULL,lease_owner=NULL,lease_token=NULL,
               lease_expires_at=NULL,updated_at=?1
             WHERE state='running'
               AND EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=follow_up_jobs.meeting_id AND d.mode='all'
               )",
            [&observed_at],
        )?;
        transaction.execute(
            "UPDATE meeting_deletions SET
               stage='files-pending',updated_at=?1
             WHERE mode='all' AND stage='waiting-for-jobs'
               AND NOT EXISTS (
                 SELECT 1 FROM follow_up_jobs j
                 WHERE j.meeting_id=meeting_deletions.meeting_id AND j.state='running'
               )",
            [&observed_at],
        )?;

        let staged_audio_chunks = load_staged_audio_chunks_tx(&transaction)?;
        transaction.commit()?;
        Ok(RecoveryReport {
            interrupted_meeting_ids,
            requeued_job_ids,
            failed_job_ids,
            staged_audio_chunks,
        })
    }

    /// Reconcile the staged audio authority returned by
    /// [`recover_after_restart`] after the native capture adapter has verified
    /// its private files.
    ///
    /// `true` means every originally staged chunk is now committed. Corrupt or
    /// still-staged chunks fail closed so lifecycle recovery cannot bless a
    /// terminal transcript that omitted durable tail audio.
    pub fn finish_audio_recovery(
        &self,
        report: &RecoveryReport,
    ) -> Result<bool, MeetingStoreError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut all_committed = true;
        for chunk in &report.staged_audio_chunks {
            let current = load_audio_chunk_optional_tx(&transaction, &chunk.definition.id)?
                .map(|(chunk, _)| chunk)
                .ok_or_else(|| not_found("audio chunk", &chunk.definition.id))?;
            all_committed &= current.status == AudioChunkStatus::Committed;
        }

        for meeting_id in &report.interrupted_meeting_ids {
            validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
            let (started_at, stopped_at, last_committed_end_ms) = transaction.query_row(
                "SELECT m.started_at,m.stopped_at,MAX(a.end_ms)
                 FROM meetings m
                 LEFT JOIN audio_chunks a
                   ON a.meeting_id=m.id AND a.status='committed'
                 WHERE m.id=?1
                 GROUP BY m.id,m.started_at,m.stopped_at",
                [meeting_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?;
            let Some(started_at) = started_at else {
                continue;
            };
            let candidate = DateTime::parse_from_rfc3339(&started_at)
                .map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid start timestamp: {error}"
                    ))
                })?
                .checked_add_signed(chrono::Duration::milliseconds(
                    last_committed_end_ms.unwrap_or(0),
                ))
                .ok_or_else(|| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' committed audio duration overflows its timestamp"
                    ))
                })?
                .with_timezone(&Utc);
            let should_advance = stopped_at
                .as_deref()
                .map(DateTime::parse_from_rfc3339)
                .transpose()
                .map_err(|error| {
                    MeetingStoreError::Validation(format!(
                        "meeting '{meeting_id}' has an invalid stop timestamp: {error}"
                    ))
                })?
                .is_none_or(|stopped| candidate > stopped);
            if should_advance {
                transaction.execute(
                    "UPDATE meetings SET stopped_at=?2 WHERE id=?1",
                    params![
                        meeting_id,
                        candidate.to_rfc3339_opts(SecondsFormat::Millis, true)
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(all_committed)
    }
}
