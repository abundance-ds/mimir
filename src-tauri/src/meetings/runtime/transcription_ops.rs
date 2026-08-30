use super::*;

impl MeetingRuntime {
    /// Persist one non-terminal real-time transcript batch emitted by the STT
    /// adapter. The run token rejects late callbacks from a prior capture, and
    /// `MeetingStore` enforces batch idempotency plus optimistic base revisions.
    pub fn ingest_transcript_batch(
        &self,
        run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active = {
            self.active()?
                .clone()
                .ok_or_else(|| MeetingRuntimeError::NotActiveMeeting {
                    meeting_id: batch.meeting_id.clone(),
                })?
        };
        if active.run_id != run_id || active.meeting_id != batch.meeting_id {
            return Err(MeetingRuntimeError::Validation(
                "transcript batch belongs to a stale or different capture run".into(),
            ));
        }
        if batch.marks_final {
            return Err(MeetingRuntimeError::Validation(
                "only stop finalization may mark the transcript final".into(),
            ));
        }
        let applied = self.inner.store.apply_transcript_batch(&batch)?;
        if applied.duplicate {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        self.publish_unlocked(
            "transcript-batch-applied",
            Some(active.meeting_id),
            Some(active.run_id),
        )
    }

    /// Complete a crash window where the terminal transcript marker reached
    /// SQLite before lifecycle completion or job acknowledgement.
    ///
    /// No transcription provider is started. An all-final silent transcript
    /// is valid; title/summary work is queued only when at least one final
    /// speech segment exists.
    pub fn complete_terminal_recovery(
        &self,
        meeting_id: &str,
    ) -> Result<bool, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        self.complete_terminal_recovery_unlocked(&meeting)
    }

    pub(crate) fn durable_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<MeetingRecord, MeetingRuntimeError> {
        self.inner.store.get_meeting(meeting_id).map_err(Into::into)
    }

    pub(crate) fn durable_transcript_result(
        &self,
        meeting_id: &str,
    ) -> Result<(u64, u64, bool), MeetingRuntimeError> {
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 0)?;
        Ok((
            meeting.transcript_revision,
            overview.segment_count,
            overview.is_final && overview.non_final_segment_count == 0,
        ))
    }

    pub(crate) fn has_committed_audio(
        &self,
        meeting_id: &str,
    ) -> Result<bool, MeetingRuntimeError> {
        self.inner
            .store
            .has_committed_audio(meeting_id)
            .map_err(Into::into)
    }

    pub(crate) fn committed_transcript_repair_revision(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
    ) -> Result<Option<u64>, MeetingRuntimeError> {
        self.inner
            .store
            .committed_transcript_repair_revision(meeting_id, capture_generation, provider_run_id)
            .map_err(Into::into)
    }

    pub(super) fn complete_terminal_recovery_unlocked(
        &self,
        meeting: &MeetingRecord,
    ) -> Result<bool, MeetingRuntimeError> {
        let overview = self.inner.store.transcript_overview(&meeting.id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Ok(false);
        }
        if matches!(
            meeting.status,
            MeetingStatus::Completed | MeetingStatus::Failed
        ) {
            return Ok(true);
        }
        if meeting.status == MeetingStatus::Interrupted {
            if let Some(failure) = meeting.failure.as_ref() {
                self.inner.store.transition_meeting(
                    &meeting.id,
                    meeting.revision,
                    MeetingStatus::Failed,
                    &self.inner.clock.now(),
                    Some(failure),
                )?;
                return Ok(true);
            }
        }
        let config = self.hook_config()?;
        let mut current = meeting.clone();
        if current.status == MeetingStatus::Interrupted {
            current = self.inner.store.transition_meeting(
                &current.id,
                current.revision,
                MeetingStatus::Finalizing,
                &self.inner.clock.now(),
                None,
            )?;
        }
        if current.status == MeetingStatus::Finalizing {
            let completed_at = self.inner.clock.now();
            let summary_job = (config.summary_enabled && overview.segment_count > 0).then(|| {
                self.summary_job_draft(
                    &current.id,
                    overview.revision,
                    &config.summary_template,
                    &config.summary_prompt,
                    &config.summary_preset,
                    &completed_at,
                )
            });
            current = self
                .inner
                .store
                .complete_meeting_with_job(
                    &current.id,
                    current.revision,
                    &completed_at,
                    summary_job.as_ref(),
                )?
                .0;
        }
        if current.status != MeetingStatus::Completed {
            return Ok(false);
        }
        Ok(true)
    }

    /// Complete an interrupted meeting from a durable transcription retry.
    ///
    /// The job worker calls this before marking its transcription job
    /// succeeded. Repeating the call with an already completed meeting returns
    /// the current snapshot, which makes worker redelivery safe.
    pub fn complete_transcription_retry(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if meeting.status == MeetingStatus::Completed && self.transcript_is_final(&meeting)? {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let recovery_failure = meeting.failure.clone();
        let finalizing = match meeting.status {
            MeetingStatus::Interrupted if recovery_failure.is_some() => meeting,
            MeetingStatus::Interrupted => self.inner.store.transition_meeting(
                meeting_id,
                meeting.revision,
                MeetingStatus::Finalizing,
                &self.inner.clock.now(),
                None,
            )?,
            MeetingStatus::Finalizing => meeting,
            _ => {
                return Err(MeetingRuntimeError::Validation(
                    "transcription retry requires an interrupted or finalizing meeting".into(),
                ));
            }
        };
        if batch.meeting_id != meeting_id
            || batch.base_revision != finalizing.transcript_revision
            || !batch.marks_final
        {
            return Err(MeetingRuntimeError::Validation(
                "transcription retry returned a non-final batch for another meeting or revision"
                    .into(),
            ));
        }
        let config = recovery_failure
            .is_none()
            .then(|| self.hook_config())
            .transpose()?;
        let applied = self.inner.store.commit_transcript_repair(
            capture_generation,
            provider_run_id,
            &batch,
        )?;
        let persisted = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Err(MeetingRuntimeError::Validation(
                "transcription repair did not produce an all-final terminal transcript".into(),
            ));
        }
        let completed_at = self.inner.clock.now();
        if let Some(failure) = recovery_failure.as_ref() {
            self.inner.store.transition_meeting(
                meeting_id,
                persisted.revision,
                MeetingStatus::Failed,
                &completed_at,
                Some(failure),
            )?;
        } else {
            let config = config.expect("successful recovery must resolve hook configuration");
            let summary_job = (config.summary_enabled && overview.segment_count > 0).then(|| {
                self.summary_job_draft(
                    meeting_id,
                    applied.revision,
                    &config.summary_template,
                    &config.summary_prompt,
                    &config.summary_preset,
                    &completed_at,
                )
            });
            self.inner.store.complete_meeting_with_job(
                meeting_id,
                persisted.revision,
                &completed_at,
                summary_job.as_ref(),
            )?;
        }
        self.publish_unlocked("meeting-recovered", Some(meeting_id.into()), None)
    }

    /// Atomically publish one explicit retranscription generation while
    /// leaving the meeting's already-terminal lifecycle untouched.
    ///
    /// Provider output has been private staging up to this point. Therefore
    /// every error before this terminal commit preserves the prior readable
    /// transcript and its revision.
    pub fn complete_user_retranscription(
        &self,
        meeting_id: &str,
        capture_generation: &str,
        provider_run_id: &str,
        batch: TranscriptBatch,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if !matches!(
            meeting.status,
            MeetingStatus::Completed | MeetingStatus::Failed
        ) {
            return Err(MeetingRuntimeError::Validation(
                "retranscription requires a completed or failed meeting".into(),
            ));
        }
        if batch.meeting_id != meeting_id
            || batch.base_revision != meeting.transcript_revision
            || !batch.marks_final
            || !batch.changes.is_empty()
        {
            return Err(MeetingRuntimeError::Validation(
                "retranscription returned an invalid terminal batch".into(),
            ));
        }
        self.inner
            .store
            .commit_transcript_repair(capture_generation, provider_run_id, &batch)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        if !overview.is_final || overview.non_final_segment_count != 0 {
            return Err(MeetingRuntimeError::Validation(
                "retranscription did not produce an all-final transcript".into(),
            ));
        }
        self.publish_unlocked("meeting-retranscribed", Some(meeting_id.into()), None)
    }
}
