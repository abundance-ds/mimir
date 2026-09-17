use super::*;

impl MeetingStore {
    pub fn apply_transcript_batch(
        &self,
        batch: &TranscriptBatch,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        self.apply_transcript_batch_inner(batch, false)
    }

    /// Provider runs append independent segment IDs. Read the shared revision
    /// and append in one transaction so simultaneous tails cannot conflict.
    pub(crate) fn append_provider_transcript_batch(
        &self,
        batch: &TranscriptBatch,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        self.apply_transcript_batch_inner(batch, true)
    }

    fn apply_transcript_batch_inner(
        &self,
        batch: &TranscriptBatch,
        append: bool,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &batch.meeting_id)?;
        let mut batch = batch.clone();
        if append {
            batch.base_revision = meeting.transcript_revision;
            batch.marks_final = false;
        }
        let batch = &batch;
        validate_transcript_batch(batch).map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(&batch.observed_at)?;
        let batch_hash = transcript_batch_fingerprint(batch, &observed_at)?;
        if !meeting.status.accepts_transcript_changes() {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{}' is {} and cannot accept transcript changes",
                batch.meeting_id, meeting.status
            )));
        }

        if let Some((stored_hash, revision)) = transaction
            .query_row(
                "SELECT batch_hash,revision FROM transcript_batches
                 WHERE meeting_id=?1 AND batch_id=?2",
                params![batch.meeting_id, batch.batch_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        {
            if stored_hash == batch_hash {
                transaction.commit()?;
                return Ok(TranscriptApplyResult {
                    revision: from_i64(revision, "transcript revision")?,
                    duplicate: true,
                });
            }
            return Err(MeetingStoreError::IdempotencyConflict {
                key: batch.batch_id.clone(),
            });
        }
        if meeting.transcript_revision != batch.base_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: batch.meeting_id.clone(),
                expected: batch.base_revision,
                actual: meeting.transcript_revision,
            });
        }
        let revision = meeting
            .transcript_revision
            .checked_add(1)
            .ok_or_else(|| MeetingStoreError::Validation("transcript revision overflow".into()))?;
        transaction.execute(
            "INSERT INTO transcript_revisions (
               meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                batch.meeting_id,
                to_i64(revision)?,
                to_i64(batch.base_revision)?,
                batch.batch_id,
                batch.source.trim(),
                observed_at,
                batch.marks_final
            ],
        )?;
        for change in &batch.changes {
            apply_transcript_change(&transaction, &batch.meeting_id, revision, change)?;
        }
        transaction.execute(
            "INSERT INTO transcript_batches (
               meeting_id,batch_id,batch_hash,revision
             ) VALUES (?1,?2,?3,?4)",
            params![
                batch.meeting_id,
                batch.batch_id,
                batch_hash,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "UPDATE meetings SET transcript_revision=?2,revision=revision+1,updated_at=?3
             WHERE id=?1",
            params![batch.meeting_id, to_i64(revision)?, observed_at],
        )?;
        transaction.commit()?;
        Ok(TranscriptApplyResult {
            revision,
            duplicate: false,
        })
    }

    /// Start (or restart) one repair generation without exposing its partial
    /// output as the authoritative transcript.
    ///
    /// A provider retry always begins reading committed audio from sequence
    /// zero. Clearing only this generation's staging rows in the same
    /// transaction means a process crash can never mix an old partial pass
    /// with a later complete pass. A committed generation is immutable and is
    /// returned without reopening provider work.
    pub fn begin_transcript_repair(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        observed_at: &str,
    ) -> Result<TranscriptRepairBegin, MeetingStoreError> {
        self.begin_transcript_repair_for_statuses(
            meeting_id,
            capture_generation,
            provider_run_id,
            observed_at,
            &[MeetingStatus::Interrupted, MeetingStatus::Finalizing],
            "transcript repair",
        )
    }

    /// Start a user-requested replacement pass over retained source audio.
    ///
    /// Unlike automatic crash repair, this is allowed only after recording
    /// has reached a terminal lifecycle. Its staged rows remain private, so a
    /// provider or model failure cannot damage the transcript the user could
    /// already read.
    pub fn begin_transcript_retranscription(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        observed_at: &str,
    ) -> Result<TranscriptRepairBegin, MeetingStoreError> {
        self.begin_transcript_repair_for_statuses(
            meeting_id,
            capture_generation,
            provider_run_id,
            observed_at,
            &[MeetingStatus::Completed, MeetingStatus::Failed],
            "retranscription",
        )
    }

    fn begin_transcript_repair_for_statuses(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        observed_at: &str,
        allowed_statuses: &[MeetingStatus],
        operation: &str,
    ) -> Result<TranscriptRepairBegin, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        let observed_at = timestamp(observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, meeting_id)?;
        if !allowed_statuses.contains(&meeting.status) {
            return Err(MeetingStoreError::Validation(format!(
                "meeting '{meeting_id}' is {} and cannot begin {operation}",
                meeting.status
            )));
        }
        let existing = transaction
            .query_row(
                "SELECT provider_run_id,state,terminal_revision
                 FROM transcript_repair_runs
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_run_id, state, terminal_revision)) = existing {
            if stored_run_id != provider_run_id {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: format!("{meeting_id}:{capture_generation}"),
                });
            }
            if state == "committed" {
                let revision = terminal_revision.ok_or_else(|| {
                    MeetingStoreError::Validation(format!(
                        "committed transcript repair '{meeting_id}:{capture_generation}' has no terminal revision"
                    ))
                })?;
                transaction.commit()?;
                return Ok(TranscriptRepairBegin::AlreadyCommitted {
                    revision: from_i64(revision, "repair terminal revision")?,
                });
            }
            transaction.execute(
                "DELETE FROM transcript_repair_segments
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation],
            )?;
            transaction.execute(
                "UPDATE transcript_repair_runs
                 SET state='collecting',updated_at=?3,terminal_revision=NULL
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation, observed_at],
            )?;
        } else {
            transaction.execute(
                "INSERT INTO transcript_repair_runs (
                   meeting_id,capture_generation,provider_run_id,state,
                   started_at,updated_at,terminal_revision
                 ) VALUES (?1,?2,?3,'collecting',?4,?4,NULL)",
                params![meeting_id, capture_generation, provider_run_id, observed_at],
            )?;
        }
        transaction.commit()?;
        Ok(TranscriptRepairBegin::Collecting)
    }

    /// Return the terminal revision for an exactly matching committed repair
    /// generation. This is the local-only redelivery check used after a crash
    /// between transcript commit and durable job acknowledgement.
    pub fn committed_transcript_repair_revision(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
    ) -> Result<Option<u64>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        let row = connection
            .query_row(
                "SELECT provider_run_id,state,terminal_revision
                 FROM transcript_repair_runs
                 WHERE meeting_id=?1 AND capture_generation=?2",
                params![meeting_id, capture_generation],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((stored_run_id, state, revision)) = row else {
            return Ok(None);
        };
        if stored_run_id != provider_run_id {
            return Err(MeetingStoreError::IdempotencyConflict {
                key: format!("{meeting_id}:{capture_generation}"),
            });
        }
        if state != "committed" {
            return Ok(None);
        }
        let revision = revision.ok_or_else(|| {
            MeetingStoreError::Validation(format!(
                "committed transcript repair '{meeting_id}:{capture_generation}' has no terminal revision"
            ))
        })?;
        Ok(Some(from_i64(revision, "repair terminal revision")?))
    }

    /// Persist a bounded provider batch into private repair staging.
    ///
    /// These rows are not indexed by transcript search, rendered, or returned
    /// to agents. The authoritative transcript changes only when the complete
    /// all-final generation is reconciled below.
    pub fn stage_transcript_repair_batch(
        &self,
        capture_generation: &str,
        provider_run_id: &str,
        batch: &TranscriptBatch,
    ) -> Result<(), MeetingStoreError> {
        validate_transcript_batch(batch).map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        if batch.marks_final {
            return Err(MeetingStoreError::Validation(
                "repair staging cannot accept a terminal batch".into(),
            ));
        }
        let observed_at = timestamp(&batch.observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_collecting_repair_tx(
            &transaction,
            &batch.meeting_id,
            capture_generation,
            provider_run_id,
        )?;
        for change in &batch.changes {
            match change {
                TranscriptChange::UpsertSegment { segment } => {
                    if let Some(channel_id) = &segment.channel_id {
                        require_channel_tx(&transaction, &batch.meeting_id, channel_id)?;
                    }
                    let mut metadata = segment.metadata.clone();
                    let object = metadata.as_object_mut().ok_or_else(|| {
                        MeetingStoreError::Validation(
                            "repair transcript segment metadata must be an object".into(),
                        )
                    })?;
                    object.insert(
                        "providerRunId".into(),
                        serde_json::Value::String(provider_run_id.into()),
                    );
                    object.insert("owner".into(), serde_json::Value::String("stt".into()));
                    transaction.execute(
                        "INSERT INTO transcript_repair_segments (
                           meeting_id,capture_generation,segment_id,start_ms,end_ms,text,
                           channel_id,speaker,confidence,is_final,metadata_json,updated_at
                         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                         ON CONFLICT(meeting_id,capture_generation,segment_id) DO UPDATE SET
                           start_ms=excluded.start_ms,end_ms=excluded.end_ms,
                           text=excluded.text,channel_id=excluded.channel_id,
                           speaker=excluded.speaker,confidence=excluded.confidence,
                           is_final=excluded.is_final,
                           metadata_json=excluded.metadata_json,
                           updated_at=excluded.updated_at",
                        params![
                            batch.meeting_id,
                            capture_generation,
                            segment.id,
                            segment.start_ms,
                            segment.end_ms,
                            segment.text,
                            segment.channel_id,
                            segment.speaker,
                            segment.confidence,
                            segment.is_final,
                            json(metadata)?,
                            observed_at
                        ],
                    )?;
                }
                TranscriptChange::DeleteSegment { segment_id } => {
                    transaction.execute(
                        "DELETE FROM transcript_repair_segments
                         WHERE meeting_id=?1 AND capture_generation=?2 AND segment_id=?3",
                        params![batch.meeting_id, capture_generation, segment_id],
                    )?;
                }
                TranscriptChange::OpenGap { .. } | TranscriptChange::ResolveGap { .. } => {
                    return Err(MeetingStoreError::Validation(
                        "provider repair batches cannot mutate capture-owned transcript gaps"
                            .into(),
                    ));
                }
            }
        }
        transaction.execute(
            "UPDATE transcript_repair_runs SET updated_at=?3
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![batch.meeting_id, capture_generation, observed_at],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Atomically replace the STT projection with one complete repair pass.
    ///
    /// The reconciliation is expressed as set-based SQLite operations. It
    /// creates exactly one bounded internal transcript revision regardless of
    /// whether the meeting has ten, five thousand, or one hundred thousand
    /// segments; Rust never loads that corpus into memory. Capture gap rows and
    /// every earlier segment-version row remain intact for provenance.
    pub fn commit_transcript_repair(
        &self,
        capture_generation: &str,
        provider_run_id: &str,
        terminal: &TranscriptBatch,
    ) -> Result<TranscriptApplyResult, MeetingStoreError> {
        validate_transcript_batch(terminal).map_err(MeetingStoreError::Validation)?;
        validate_id(capture_generation, "capture generation")
            .map_err(MeetingStoreError::Validation)?;
        validate_id(provider_run_id, "provider run id").map_err(MeetingStoreError::Validation)?;
        if !terminal.marks_final || !terminal.changes.is_empty() {
            return Err(MeetingStoreError::Validation(
                "repair completion requires an empty terminal marker".into(),
            ));
        }
        let observed_at = timestamp(&terminal.observed_at)?;
        let batch_hash = transcript_batch_fingerprint(terminal, &observed_at)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let meeting = load_meeting_tx(&transaction, &terminal.meeting_id)?;
        let repair = require_repair_tx(
            &transaction,
            &terminal.meeting_id,
            capture_generation,
            provider_run_id,
        )?;
        if repair.0 == "committed" {
            let revision = repair.1.ok_or_else(|| {
                MeetingStoreError::Validation(
                    "committed transcript repair has no terminal revision".into(),
                )
            })?;
            let (stored_batch_id, stored_hash) = transaction.query_row(
                "SELECT r.batch_id,b.batch_hash
                 FROM transcript_revisions r
                 JOIN transcript_batches b
                   ON b.meeting_id=r.meeting_id AND b.revision=r.revision
                 WHERE r.meeting_id=?1 AND r.revision=?2",
                params![terminal.meeting_id, revision],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?;
            if stored_batch_id != terminal.batch_id || stored_hash != batch_hash {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: format!("{}/{}", terminal.meeting_id, terminal.batch_id),
                });
            }
            transaction.commit()?;
            return Ok(TranscriptApplyResult {
                revision: from_i64(revision, "repair terminal revision")?,
                duplicate: true,
            });
        }
        if meeting.transcript_revision != terminal.base_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: terminal.meeting_id.clone(),
                expected: terminal.base_revision,
                actual: meeting.transcript_revision,
            });
        }
        let non_final: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM transcript_repair_segments
             WHERE meeting_id=?1 AND capture_generation=?2 AND is_final=0",
            params![terminal.meeting_id, capture_generation],
            |row| row.get(0),
        )?;
        if non_final != 0 {
            return Err(MeetingStoreError::Validation(format!(
                "transcript repair contains {non_final} unresolved partial segment(s)"
            )));
        }
        let revision = meeting
            .transcript_revision
            .checked_add(1)
            .ok_or_else(|| MeetingStoreError::Validation("transcript revision overflow".into()))?;
        transaction.execute(
            "INSERT INTO transcript_revisions (
               meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             ) VALUES (?1,?2,?3,?4,?5,?6,1)",
            params![
                terminal.meeting_id,
                to_i64(revision)?,
                to_i64(terminal.base_revision)?,
                terminal.batch_id,
                terminal.source.trim(),
                observed_at
            ],
        )?;

        // History for rows absent from the completed pass records their
        // deletion. Rows present in both projections receive one upsert
        // version below, preserving their original created revision.
        transaction.execute(
            "INSERT INTO transcript_segment_versions (
               meeting_id,segment_id,revision,operation,created_revision
             )
             SELECT current.meeting_id,current.segment_id,?3,'delete',
                    current.created_revision
             FROM transcript_segments current
             WHERE current.meeting_id=?1
               AND NOT EXISTS (
                 SELECT 1 FROM transcript_repair_segments staged
                 WHERE staged.meeting_id=current.meeting_id
                   AND staged.capture_generation=?2
                   AND staged.segment_id=current.segment_id
               )",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "INSERT INTO transcript_segment_versions (
               meeting_id,segment_id,revision,operation,start_ms,end_ms,text,
               channel_id,speaker,confidence,is_final,metadata_json,created_revision
             )
             SELECT staged.meeting_id,staged.segment_id,?3,'upsert',
                    staged.start_ms,staged.end_ms,staged.text,staged.channel_id,
                    staged.speaker,staged.confidence,staged.is_final,
                    staged.metadata_json,
                    COALESCE(current.created_revision,?3)
             FROM transcript_repair_segments staged
             LEFT JOIN transcript_segments current
               ON current.meeting_id=staged.meeting_id
              AND current.segment_id=staged.segment_id
             WHERE staged.meeting_id=?1 AND staged.capture_generation=?2",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "DELETE FROM transcript_segments WHERE meeting_id=?1",
            [terminal.meeting_id.as_str()],
        )?;
        transaction.execute(
            "INSERT INTO transcript_segments (
               meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
               confidence,is_final,metadata_json,created_revision,updated_revision
             )
             SELECT staged.meeting_id,staged.segment_id,staged.start_ms,
                    staged.end_ms,staged.text,staged.channel_id,staged.speaker,
                    staged.confidence,staged.is_final,staged.metadata_json,
                    COALESCE(versions.created_revision,?3),?3
             FROM transcript_repair_segments staged
             LEFT JOIN (
               SELECT meeting_id,segment_id,MIN(created_revision) AS created_revision
               FROM transcript_segment_versions
               WHERE meeting_id=?1
               GROUP BY meeting_id,segment_id
             ) versions
               ON versions.meeting_id=staged.meeting_id
              AND versions.segment_id=staged.segment_id
             WHERE staged.meeting_id=?1 AND staged.capture_generation=?2",
            params![terminal.meeting_id, capture_generation, to_i64(revision)?],
        )?;
        transaction.execute(
            "INSERT INTO transcript_batches (
               meeting_id,batch_id,batch_hash,revision
             ) VALUES (?1,?2,?3,?4)",
            params![
                terminal.meeting_id,
                terminal.batch_id,
                batch_hash,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "UPDATE meetings SET transcript_revision=?2,revision=revision+1,updated_at=?3
             WHERE id=?1",
            params![terminal.meeting_id, to_i64(revision)?, observed_at],
        )?;
        transaction.execute(
            "UPDATE transcript_repair_runs
             SET state='committed',updated_at=?3,terminal_revision=?4
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![
                terminal.meeting_id,
                capture_generation,
                observed_at,
                to_i64(revision)?
            ],
        )?;
        transaction.execute(
            "DELETE FROM transcript_repair_segments
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![terminal.meeting_id, capture_generation],
        )?;
        release_obsolete_repair_holds_tx(&transaction, &terminal.meeting_id)?;
        transaction.commit()?;
        Ok(TranscriptApplyResult {
            revision,
            duplicate: false,
        })
    }
}
