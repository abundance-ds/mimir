use super::*;

impl MeetingStore {
    pub fn create_meeting(
        &self,
        draft: &MeetingDraft,
        observed_at: &str,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_meeting_draft(draft).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let origin = json(draft.origin.clone())?;
        let metadata = json(draft.metadata.clone())?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO meetings (
               id,title,origin_json,status,created_at,updated_at,metadata_json
             ) VALUES (?1,?2,?3,'detected',?4,?4,?5)",
            params![draft.id, draft.title.trim(), origin, observed_at, metadata],
        )?;
        for channel in &draft.channels {
            insert_channel(&transaction, &draft.id, channel, &observed_at)?;
        }
        let meeting = load_meeting_tx(&transaction, &draft.id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    pub fn get_meeting(&self, meeting_id: &str) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        load_meeting(&connection, meeting_id)
    }

    pub fn arm_detected_meeting(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        metadata: &Value,
        observed_at: &str,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let metadata = json(metadata.clone())?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_meeting_tx(&transaction, meeting_id)?;
        if current.revision != expected_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.status != MeetingStatus::Detected {
            return Err(MeetingStoreError::InvalidTransition {
                meeting_id: meeting_id.into(),
                from: current.status,
                to: MeetingStatus::Recording,
            });
        }
        transaction.execute(
            "UPDATE meetings SET
               status='recording', metadata_json=?2, updated_at=?3,
               started_at=COALESCE(started_at,?3), revision=revision+1
             WHERE id=?1",
            params![meeting_id, metadata, observed_at],
        )?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    pub fn list_meetings(&self, limit: u32) -> Result<Vec<MeetingRecord>, MeetingStoreError> {
        Ok(self.list_meetings_page(None, limit)?.meetings)
    }

    /// Return every interrupted meeting that still needs a startup
    /// transcription decision. This query is intentionally independent of
    /// the bounded renderer library projection.
    pub fn interrupted_meeting_ids(&self) -> Result<Vec<String>, MeetingStoreError> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id FROM meetings
             WHERE status='interrupted'
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=meetings.id AND d.mode='all'
               )
             ORDER BY id",
        )?;
        let ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn list_meetings_page(
        &self,
        before: Option<&MeetingListCursor>,
        limit: u32,
    ) -> Result<MeetingListPage, MeetingStoreError> {
        if let Some(cursor) = before {
            timestamp(&cursor.created_at)?;
            validate_id(&cursor.meeting_id, "meeting list cursor id")
                .map_err(MeetingStoreError::Validation)?;
        }
        let limit = limit.clamp(1, 1_000);
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT m.id FROM meetings m
             WHERE NOT EXISTS (
                     SELECT 1 FROM meeting_deletions d
                     WHERE d.meeting_id=m.id AND d.mode='all'
                   )
               AND (
                    ?1 IS NULL
                 OR m.created_at < ?1
                 OR (m.created_at=?1 AND m.id < ?2)
               )
             ORDER BY m.created_at DESC,m.id DESC
             LIMIT ?3",
        )?;
        let ids = statement
            .query_map(
                params![
                    before.map(|cursor| cursor.created_at.as_str()),
                    before.map(|cursor| cursor.meeting_id.as_str()),
                    i64::from(limit) + 1
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = ids.len() > limit as usize;
        let meetings = ids
            .into_iter()
            .take(limit as usize)
            .map(|meeting_id| load_meeting(&connection, &meeting_id))
            .collect::<Result<Vec<_>, _>>()?;
        let next_before =
            has_more
                .then(|| meetings.last())
                .flatten()
                .map(|meeting| MeetingListCursor {
                    created_at: meeting.created_at.clone(),
                    meeting_id: meeting.id.clone(),
                });
        Ok(MeetingListPage {
            meetings,
            has_more,
            next_before,
        })
    }

    pub fn transition_meeting(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        next: MeetingStatus,
        observed_at: &str,
        failure: Option<&MeetingFailure>,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        if next == MeetingStatus::Failed && failure.is_none() {
            return Err(MeetingStoreError::Validation(
                "failed meetings require failure detail".into(),
            ));
        }
        if !matches!(next, MeetingStatus::Failed | MeetingStatus::Interrupted) && failure.is_some()
        {
            return Err(MeetingStoreError::Validation(
                "failure detail is valid only for failed or interrupted recovery intent".into(),
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_meeting_tx(&transaction, meeting_id)?;
        if current.revision != expected_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.status == next {
            transaction.commit()?;
            return Ok(current);
        }
        if !current.status.can_transition_to(next) {
            return Err(MeetingStoreError::InvalidTransition {
                meeting_id: meeting_id.into(),
                from: current.status,
                to: next,
            });
        }

        let failure_code = failure.map(|value| value.code.as_str());
        let failure_message = failure.map(|value| value.message.as_str());
        let failure_retryable = failure.map(|value| value.retryable);
        transaction.execute(
            "UPDATE meetings SET
               status=?2,
               updated_at=?3,
               revision=revision+1,
               started_at=CASE WHEN ?2='recording' THEN COALESCE(started_at,?3) ELSE started_at END,
               stopped_at=CASE
                 WHEN ?2 IN ('stopping','finalizing','interrupted','failed')
                 THEN COALESCE(stopped_at,?3)
                 ELSE stopped_at
               END,
               finalized_at=CASE WHEN ?2='completed' THEN ?3 ELSE finalized_at END,
               interrupted_at=CASE WHEN ?2='interrupted' THEN ?3 ELSE interrupted_at END,
               failure_code=?4,
               failure_message=?5,
               failure_retryable=?6
             WHERE id=?1",
            params![
                meeting_id,
                next.to_string(),
                observed_at,
                failure_code,
                failure_message,
                failure_retryable
            ],
        )?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    /// Commit terminal lifecycle and its optional default follow-up outbox
    /// entry under one SQLite write lock.
    ///
    /// This closes the crash boundary where a meeting could previously become
    /// `completed` before its required title/summary job was durable.
    pub fn complete_meeting_with_job(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        observed_at: &str,
        job: Option<&FollowUpJobDraft>,
    ) -> Result<(MeetingRecord, Option<FollowUpJob>), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let prepared_job = job
            .map(|job| {
                validate_job_draft(job).map_err(MeetingStoreError::Validation)?;
                if job.meeting_id != meeting_id {
                    return Err(MeetingStoreError::Validation(
                        "completion follow-up must belong to the completed meeting".into(),
                    ));
                }
                let not_before = timestamp(&job.not_before)?;
                let request_hash = job_fingerprint(job, &not_before)?;
                let payload = json(job.payload.clone())?;
                Ok((
                    job,
                    not_before,
                    request_hash,
                    payload,
                    job.kind.as_storage_key(),
                ))
            })
            .transpose()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_meeting_tx(&transaction, meeting_id)?;
        if current.revision != expected_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.status != MeetingStatus::Completed
            && !current.status.can_transition_to(MeetingStatus::Completed)
        {
            return Err(MeetingStoreError::InvalidTransition {
                meeting_id: meeting_id.into(),
                from: current.status,
                to: MeetingStatus::Completed,
            });
        }

        if current.status != MeetingStatus::Completed {
            let mut completed_metadata = current.metadata.clone();
            if let Some(metadata) = completed_metadata.as_object_mut() {
                metadata.remove("continuationPreviousMetadata");
                metadata.remove("continuationPreviousStoppedAt");
                metadata.remove("continuationPreviousFinalizedAt");
            }
            let completed_metadata = json(completed_metadata)?;
            transaction.execute(
                "UPDATE meetings SET
                   status='completed',
                   updated_at=?2,
                   revision=revision+1,
                   stopped_at=COALESCE(stopped_at,?2),
                   finalized_at=?2,
                   failure_code=NULL,
                   failure_message=NULL,
                   failure_retryable=NULL,
                   metadata_json=?3
                 WHERE id=?1",
                params![meeting_id, observed_at, completed_metadata],
            )?;
        }

        let stored_job = if let Some((job, not_before, request_hash, payload, kind)) = prepared_job
        {
            if deletion_blocks_job_tx(&transaction, meeting_id, &job.kind)? {
                return Err(deletion_in_progress_tx(&transaction, meeting_id)?);
            }
            if let Some((existing, existing_hash)) =
                load_job_by_idempotency_tx(&transaction, meeting_id, &job.idempotency_key)?
            {
                if existing_hash != request_hash {
                    return Err(MeetingStoreError::IdempotencyConflict {
                        key: job.idempotency_key.clone(),
                    });
                }
                Some(existing)
            } else {
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
                Some(load_job_tx(&transaction, &job.id)?)
            }
        } else {
            None
        };
        let completed = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok((completed, stored_job))
    }
}
