use super::*;

impl MeetingStore {
    pub fn stage_audio_chunk(
        &self,
        chunk: &AudioChunkDraft,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_audio_chunk(chunk).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let fingerprint = fingerprint(chunk)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &chunk.meeting_id)?;
        if !matches!(
            meeting.status,
            MeetingStatus::Recording
                | MeetingStatus::Stopping
                | MeetingStatus::Finalizing
                | MeetingStatus::Interrupted
        ) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{}' is {} and cannot accept audio chunks",
                chunk.meeting_id, meeting.status
            )));
        }
        require_channel_tx(&transaction, &chunk.meeting_id, &chunk.channel_id)?;

        if let Some((existing, existing_fingerprint)) =
            load_audio_chunk_optional_tx(&transaction, &chunk.id)?
        {
            if existing_fingerprint == fingerprint {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: chunk.id.clone(),
            });
        }
        let sequence_owner: Option<String> = transaction
            .query_row(
                "SELECT id FROM audio_chunks
                 WHERE meeting_id=?1 AND channel_id=?2 AND sequence=?3",
                params![chunk.meeting_id, chunk.channel_id, to_i64(chunk.sequence)?],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(owner) = sequence_owner {
            return Err(MeetingStoreError::IdempotencyConflict {
                key: format!(
                    "{}:{}:{} (owned by {owner})",
                    chunk.meeting_id, chunk.channel_id, chunk.sequence
                ),
            });
        }
        transaction.execute(
            "INSERT INTO audio_chunks (
               id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
               byte_len,sha256,relative_path,status,staged_at,fingerprint,integrity_error
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,LOWER(?9),?10,'staged',?11,?12,NULL)",
            params![
                chunk.id,
                chunk.meeting_id,
                chunk.channel_id,
                to_i64(chunk.sequence)?,
                chunk.start_ms,
                chunk.end_ms,
                to_i64(chunk.sample_count)?,
                to_i64(chunk.byte_len)?,
                chunk.sha256,
                chunk.relative_path,
                observed_at,
                fingerprint
            ],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, &chunk.id)?
            .expect("inserted audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    pub fn mark_audio_chunk_corrupt(
        &self,
        chunk_id: &str,
        detail: &str,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_id(chunk_id, "audio chunk id").map_err(MeetingStoreError::Validation)?;
        if detail.trim().is_empty() || detail.len() > 4_096 {
            return Err(MeetingStoreError::Validation(
                "audio integrity error must contain 1 to 4096 bytes".into(),
            ));
        }
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((existing, _)) = load_audio_chunk_optional_tx(&transaction, chunk_id)? else {
            return Err(not_found("audio chunk", chunk_id));
        };
        if existing.status == AudioChunkStatus::Committed {
            return Err(MeetingStoreError::Validation(format!(
                "committed audio chunk '{chunk_id}' cannot be marked corrupt"
            )));
        }
        if existing.status == AudioChunkStatus::Corrupt {
            transaction.commit()?;
            return Ok(existing);
        }
        transaction.execute(
            "UPDATE audio_chunks
             SET status='corrupt',integrity_error=?2,committed_at=?3 WHERE id=?1",
            params![chunk_id, detail.trim(), observed_at],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, chunk_id)?
            .expect("updated audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    pub fn commit_audio_chunk(
        &self,
        chunk_id: &str,
        observed_at: &str,
    ) -> Result<AudioChunk, MeetingStoreError> {
        validate_id(chunk_id, "audio chunk id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((existing, _)) = load_audio_chunk_optional_tx(&transaction, chunk_id)? else {
            return Err(not_found("audio chunk", chunk_id));
        };
        if existing.status == AudioChunkStatus::Committed {
            transaction.commit()?;
            return Ok(existing);
        }
        if existing.status != AudioChunkStatus::Staged {
            return Err(MeetingStoreError::Validation(format!(
                "audio chunk '{chunk_id}' is {} and cannot be committed",
                existing.status
            )));
        }
        transaction.execute(
            "UPDATE audio_chunks
             SET status='committed', committed_at=?2 WHERE id=?1",
            params![chunk_id, observed_at],
        )?;
        let (stored, _) = load_audio_chunk_optional_tx(&transaction, chunk_id)?
            .expect("updated audio chunk must exist");
        transaction.commit()?;
        Ok(stored)
    }

    /// Read one bounded, sequence-keyset page of committed channel audio.
    ///
    /// This is the only audio-file projection suitable for transcription.
    /// Filesystem discovery is deliberately not an authority: staged,
    /// corrupt, and unregistered paths never appear here.
    pub fn committed_audio_chunks(
        &self,
        meeting_id: &str,
        channel_id: &str,
        first_sequence: u64,
        limit: u32,
    ) -> Result<Vec<AudioChunk>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(channel_id, "audio channel id").map_err(MeetingStoreError::Validation)?;
        if limit == 0 || limit > MAX_COMMITTED_AUDIO_CHUNK_PAGE {
            return Err(MeetingStoreError::Validation(format!(
                "committed audio reads must request between 1 and {MAX_COMMITTED_AUDIO_CHUNK_PAGE} chunks"
            )));
        }

        let connection = self.lock()?;
        let meeting_exists = connection
            .query_row("SELECT 1 FROM meetings WHERE id=?1", [meeting_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !meeting_exists {
            return Err(not_found("meeting", meeting_id));
        }
        let channel_exists = connection
            .query_row(
                "SELECT 1 FROM audio_channels WHERE meeting_id=?1 AND id=?2",
                params![meeting_id, channel_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !channel_exists {
            return Err(not_found("audio channel", channel_id));
        }

        let mut statement = connection.prepare(
            "SELECT id,meeting_id,channel_id,sequence,start_ms,end_ms,sample_count,
                    byte_len,sha256,relative_path,status,staged_at,committed_at,
                    fingerprint,integrity_error
             FROM audio_chunks
             WHERE meeting_id=?1 AND channel_id=?2
               AND status='committed' AND sequence>=?3
             ORDER BY sequence
             LIMIT ?4",
        )?;
        let chunks = statement
            .query_map(
                params![
                    meeting_id,
                    channel_id,
                    to_i64(first_sequence)?,
                    i64::from(limit)
                ],
                audio_chunk_from_row,
            )?
            .map(|result| result.map(|(chunk, _)| chunk))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(chunks)
    }

    pub fn has_committed_audio(&self, meeting_id: &str) -> Result<bool, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM audio_chunks
                   WHERE meeting_id=?1 AND status='committed'
                 )",
                [meeting_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    /// Return the first sequence a new append-only capture run may own.
    ///
    /// The cursor is shared by every channel so a resumed microphone and
    /// system stream can never overwrite or pair with an earlier run. A
    /// completed meeting must not retain staged audio; recovery owns that
    /// state before continuation is allowed.
    pub fn next_audio_sequence(&self, meeting_id: &str) -> Result<u64, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let staged: bool = connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM audio_chunks
               WHERE meeting_id=?1 AND status='staged'
             )",
            [meeting_id],
            |row| row.get(0),
        )?;
        if staged {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' still has staged audio and must be recovered before continuation"
            )));
        }
        let maximum = connection.query_row(
            "SELECT MAX(sequence) FROM audio_chunks
             WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        maximum.map_or(Ok(0), |value| {
            from_i64(value, "audio chunk sequence")?
                .checked_add(1)
                .ok_or_else(|| {
                    MeetingStoreError::Validation("audio chunk sequence overflow".into())
                })
        })
    }

    /// Reopen one stopped meeting for an append-only continuation run.
    ///
    /// Lifecycle, transcript-finality invalidation, run metadata, and pending
    /// follow-up cancellation share one SQLite transaction. Earlier audio,
    /// transcript revisions, reviewed content, and the original start time
    /// remain immutable.
    pub fn reopen_stopped_meeting(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        run_id: &str,
        metadata: &serde_json::Value,
        observed_at: &str,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(run_id, "capture run id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut metadata = metadata.clone();
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
        if !matches!(
            current.status,
            MeetingStatus::Completed
                | MeetingStatus::Finalizing
                | MeetingStatus::Interrupted
                | MeetingStatus::Failed
        ) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' is {} and cannot be continued",
                current.status
            )));
        }
        let final_revision: Option<bool> = transaction
            .query_row(
                "SELECT marks_final FROM transcript_revisions
                 WHERE meeting_id=?1 AND revision=?2",
                params![meeting_id, to_i64(current.transcript_revision)?],
                |row| row.get(0),
            )
            .optional()?;
        if current.status == MeetingStatus::Completed && final_revision != Some(true) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' does not have a final transcript and cannot be continued"
            )));
        }

        let revision = current
            .transcript_revision
            .checked_add(1)
            .ok_or_else(|| MeetingStoreError::Validation("transcript revision overflow".into()))?;
        metadata["continuedTranscriptRevision"] = Value::from(revision);
        let metadata = json(metadata)?;
        let batch = TranscriptBatch {
            meeting_id: meeting_id.into(),
            batch_id: format!("continue-{run_id}"),
            base_revision: current.transcript_revision,
            source: "native-continuation".into(),
            observed_at: observed_at.clone(),
            marks_final: false,
            changes: Vec::new(),
        };
        let batch_hash = transcript_batch_fingerprint(&batch, &observed_at)?;
        transaction.execute(
            "INSERT INTO transcript_revisions (
               meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             ) VALUES (?1,?2,?3,?4,?5,?6,0)",
            params![
                meeting_id,
                to_i64(revision)?,
                to_i64(current.transcript_revision)?,
                batch.batch_id,
                batch.source,
                observed_at
            ],
        )?;
        transaction.execute(
            "INSERT INTO transcript_batches (meeting_id,batch_id,batch_hash,revision)
             VALUES (?1,?2,?3,?4)",
            params![meeting_id, batch.batch_id, batch_hash, to_i64(revision)?],
        )?;
        transaction.execute(
            "UPDATE meetings SET
               status='recording',updated_at=?2,revision=revision+1,
               transcript_revision=?3,stopped_at=NULL,finalized_at=NULL,
               interrupted_at=NULL,interruption_reason=NULL,
               failure_code=NULL,failure_message=NULL,failure_retryable=NULL,
               metadata_json=?4
             WHERE id=?1",
            params![meeting_id, observed_at, to_i64(revision)?, metadata],
        )?;
        transaction.execute(
            "UPDATE follow_up_jobs SET
               state='cancelled',last_error=?3,
               lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?2
             WHERE meeting_id=?1 AND state='pending'",
            params![meeting_id, observed_at, format!("continued:{run_id}")],
        )?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok(meeting)
    }

    /// Restore the prior stopped state when a continuation worker could
    /// not be opened. This is the synchronous-start rollback paired with
    /// `reopen_stopped_meeting`; no earlier content is deleted or rewritten.
    pub fn rollback_meeting_continuation(
        &self,
        meeting_id: &str,
        expected_revision: u64,
        run_id: &str,
        observed_at: &str,
    ) -> Result<MeetingRecord, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(run_id, "capture run id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_meeting_tx(&transaction, meeting_id)?;
        let restore_jobs = || {
            transaction.execute(
            "UPDATE follow_up_jobs SET state='pending',last_error=NULL,not_before=?2,updated_at=?2
             WHERE meeting_id=?1 AND state='cancelled' AND last_error=?3",
            params![meeting_id, observed_at, format!("continued:{run_id}")],
        )
        };
        if current.status == MeetingStatus::Recording
            && current.metadata.get("runId").and_then(Value::as_str) == Some(run_id)
            && matches!(
                current
                    .metadata
                    .get("continuationPreviousStatus")
                    .and_then(Value::as_str),
                Some("finalizing" | "interrupted" | "failed")
            )
        {
            let previous_metadata = current
                .metadata
                .get("continuationPreviousMetadata")
                .filter(|value| value.is_object())
                .ok_or_else(|| {
                    MeetingStoreError::Validation("missing continuation metadata".into())
                })?;
            transaction.execute(
                "UPDATE meetings SET status=?5,revision=revision+1,updated_at=?2,
                 stopped_at=?3,finalized_at=?6,metadata_json=?4,
                 interrupted_at=?7,interruption_reason=?8,
                 failure_code=?9,failure_message=?10,failure_retryable=?11 WHERE id=?1",
                params![
                    meeting_id,
                    observed_at,
                    current
                        .metadata
                        .get("continuationPreviousStoppedAt")
                        .and_then(Value::as_str),
                    json(previous_metadata.clone())?,
                    current
                        .metadata
                        .get("continuationPreviousStatus")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .get("continuationPreviousFinalizedAt")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .get("continuationPreviousInterruptedAt")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .get("continuationPreviousInterruptionReason")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .pointer("/continuationPreviousFailure/code")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .pointer("/continuationPreviousFailure/message")
                        .and_then(Value::as_str),
                    current
                        .metadata
                        .pointer("/continuationPreviousFailure/retryable")
                        .and_then(Value::as_bool)
                ],
            )?;
            restore_jobs()?;
            let meeting = load_meeting_tx(&transaction, meeting_id)?;
            transaction.commit()?;
            return Ok(meeting);
        }
        if current.revision != expected_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.status != MeetingStatus::Recording
            || current.metadata.get("runId").and_then(Value::as_str) != Some(run_id)
        {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' is not owned by continuation run '{run_id}'"
            )));
        }
        let continuation_batch = format!("continue-{run_id}");
        let (base_revision, stored_batch, source, marks_final) = transaction.query_row(
            "SELECT base_revision,batch_id,source,marks_final
             FROM transcript_revisions
             WHERE meeting_id=?1 AND revision=?2",
            params![meeting_id, to_i64(current.transcript_revision)?],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )?;
        if stored_batch != continuation_batch || source != "native-continuation" || marks_final {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' received transcript work after continuation started"
            )));
        }
        let base_revision = from_i64(base_revision, "transcript revision")?;
        transaction.execute(
            "DELETE FROM transcript_batches WHERE meeting_id=?1 AND batch_id=?2",
            params![meeting_id, continuation_batch],
        )?;
        transaction.execute(
            "DELETE FROM transcript_revisions WHERE meeting_id=?1 AND revision=?2",
            params![meeting_id, to_i64(current.transcript_revision)?],
        )?;
        let previous_stopped_at = current
            .metadata
            .get("continuationPreviousStoppedAt")
            .and_then(Value::as_str);
        let previous_finalized_at = current
            .metadata
            .get("continuationPreviousFinalizedAt")
            .and_then(Value::as_str);
        let previous_metadata = current
            .metadata
            .get("continuationPreviousMetadata")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                MeetingStoreError::Validation(format!(
                    "meeting '{meeting_id}' is missing its pre-continuation metadata"
                ))
            })?;
        let previous_metadata = json(previous_metadata.clone())?;
        transaction.execute(
            "UPDATE meetings SET
               status=?7,updated_at=?2,revision=revision+1,
               transcript_revision=?3,stopped_at=?4,finalized_at=?5,
               metadata_json=?6
             WHERE id=?1",
            params![
                meeting_id,
                observed_at,
                to_i64(base_revision)?,
                previous_stopped_at,
                previous_finalized_at,
                previous_metadata,
                current
                    .metadata
                    .get("continuationPreviousStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
            ],
        )?;
        restore_jobs()?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        transaction.commit()?;
        Ok(meeting)
    }
}
