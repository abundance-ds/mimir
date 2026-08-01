//! Durable post-meeting jobs, explicit reruns, and retained-audio retranscription.

use super::*;

impl MeetingRuntime {
    pub fn decide_kg(
        &self,
        meeting_id: &str,
        decision: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        if meeting.status != MeetingStatus::Completed || !self.transcript_is_final(&meeting)? {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up requires a completed final transcript".into(),
            ));
        }
        if summary_state(&self.inner.store.list_jobs(meeting_id)?) != "succeeded" {
            return Err(MeetingRuntimeError::Validation(
                "knowledge-graph follow-up requires a successful title and summary job".into(),
            ));
        }
        match decision {
            "create-draft" => {
                self.inner
                    .platform
                    .set_kg_decision(meeting_id, decision)
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
                let config = self.platform_projection()?.config;
                self.enqueue_kg_job(meeting_id, meeting.transcript_revision, &config.kg_preset)?;
            }
            "not-now" | "never" => {
                self.inner
                    .platform
                    .set_kg_decision(meeting_id, decision)
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
            }
            _ => {
                return Err(MeetingRuntimeError::Validation(
                    "knowledge-graph decision must be create-draft, not-now, or never".into(),
                ));
            }
        }
        self.publish_unlocked("kg-decision-changed", Some(meeting_id.into()), None)
    }

    pub fn claim_next_job(
        &self,
        worker_id: &str,
        lease_expires_at: &str,
    ) -> Result<Option<FollowUpJob>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let job = self.inner.store.claim_next_job(
            worker_id,
            &self.inner.clock.now(),
            lease_expires_at,
        )?;
        if let Some(job) = &job {
            let _ = self.publish_unlocked(
                "meeting-job-running",
                Some(job.definition.meeting_id.clone()),
                None,
            )?;
        }
        Ok(job)
    }

    pub fn finish_job(
        &self,
        job_id: &str,
        lease_token: &str,
        outcome: JobFinish,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let job =
            self.inner
                .store
                .finish_job(job_id, lease_token, &outcome, &self.inner.clock.now())?;
        if job.state == JobState::Cancelled {
            if let Some(deletion) = self
                .inner
                .store
                .deletion(&job.definition.meeting_id)?
                .filter(|deletion| {
                    deletion.mode == StoreDeletionMode::All
                        && deletion.stage == MeetingDeletionStage::FilesPending
                })
            {
                if let Err(message) = self
                    .inner
                    .platform
                    .delete_meeting(&deletion.meeting_id, MeetingDeleteMode::All)
                {
                    self.set_diagnostic(format!(
                        "Permanent deletion for meeting '{}' will resume at next launch: {message}",
                        deletion.meeting_id
                    ))?;
                }
            }
        }
        if job.state == JobState::Succeeded && job.definition.kind == FollowUpJobKind::Summary {
            let config = self.platform_projection()?.config;
            if config.kg_prompt == "always-draft" {
                let meeting = self.inner.store.get_meeting(&job.definition.meeting_id)?;
                self.enqueue_kg_job(
                    &job.definition.meeting_id,
                    meeting.transcript_revision,
                    &config.kg_preset,
                )?;
                self.inner
                    .platform
                    .set_kg_decision(&job.definition.meeting_id, "create-draft")
                    .map_err(|message| port_error("knowledge-graph decision", message))?;
            }
        }
        self.publish_unlocked("meeting-job-changed", Some(job.definition.meeting_id), None)
    }

    pub fn retry_job(
        &self,
        meeting_id: &str,
        job_kind: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let kind = parse_renderer_job_kind(job_kind)?;
        let jobs = self.inner.store.list_jobs(meeting_id)?;
        if jobs.iter().any(|job| {
            job.definition.kind == kind
                && matches!(job.state, JobState::Pending | JobState::Running)
        }) {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        if kind != FollowUpJobKind::Summary
            && jobs
                .iter()
                .any(|job| job.definition.kind == kind && job.state == JobState::Succeeded)
        {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }

        let retry_prefix = format!("{meeting_id}:{job_kind}:retry:");
        let retry_number = jobs
            .iter()
            .filter_map(|job| {
                job.definition
                    .idempotency_key
                    .strip_prefix(&retry_prefix)
                    .and_then(|suffix| suffix.parse::<u64>().ok())
            })
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let now = self.inner.clock.now();
        let mut draft = if kind == FollowUpJobKind::Summary {
            let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
            if meeting.status != MeetingStatus::Completed
                || !overview.is_final
                || overview.non_final_segment_count != 0
                || overview.segment_count == 0
            {
                return Err(MeetingRuntimeError::Validation(
                    "creating the summary again requires a completed, non-empty terminal transcript"
                        .into(),
                ));
            }
            let config = self.hook_config()?;
            self.summary_job_draft(
                meeting_id,
                meeting.transcript_revision,
                &config.summary_template,
                &config.summary_prompt,
                &config.summary_preset,
                &now,
            )
        } else {
            let latest = jobs.iter().rev().find(|job| job.definition.kind == kind);
            let payload = latest
                .map(|job| job.definition.payload.clone())
                .unwrap_or_else(|| {
                    json!({
                        "meetingId": meeting_id,
                        "transcriptRevision": meeting.transcript_revision,
                        "reviewRequired": true,
                    })
                });
            FollowUpJobDraft {
                id: format!("job-retry-{}", Uuid::new_v4()),
                meeting_id: meeting_id.into(),
                kind,
                idempotency_key: String::new(),
                payload,
                max_attempts: DEFAULT_JOB_ATTEMPTS,
                not_before: now.clone(),
            }
        };
        draft.id = format!("job-retry-{}", Uuid::new_v4());
        draft.idempotency_key = format!("{retry_prefix}{retry_number}");
        self.inner.store.enqueue_job(&draft, &now)?;
        self.publish_unlocked("meeting-job-retried", Some(meeting_id.into()), None)
    }

    /// Enqueue a new summary generation with an exact per-run recipe.
    ///
    /// This deliberately does not mutate global Scribe settings: expanding a
    /// prompt inside one meeting is a one-off refinement, not a hidden change
    /// to every future meeting.
    pub fn run_summary(
        &self,
        meeting_id: &str,
        request: MeetingSummaryRunRequest,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_summary_template(&request.template)?;
        require_summary_prompt(&request.prompt)?;
        require_summary_preset(&request.preset)?;
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        if meeting.status != MeetingStatus::Completed
            || !overview.is_final
            || overview.non_final_segment_count != 0
            || overview.segment_count == 0
        {
            return Err(MeetingRuntimeError::Validation(
                "creating a summary requires a completed, non-empty terminal transcript".into(),
            ));
        }
        let jobs = self.inner.store.list_jobs(meeting_id)?;
        if jobs.iter().any(|job| {
            job.definition.kind == FollowUpJobKind::Summary
                && matches!(job.state, JobState::Pending | JobState::Running)
        }) {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let retry_prefix = format!("{meeting_id}:title-summary:retry:");
        let retry_number = jobs
            .iter()
            .filter_map(|job| {
                job.definition
                    .idempotency_key
                    .strip_prefix(&retry_prefix)
                    .and_then(|suffix| suffix.parse::<u64>().ok())
            })
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let now = self.inner.clock.now();
        let mut draft = self.summary_job_draft(
            meeting_id,
            meeting.transcript_revision,
            &request.template,
            &request.prompt,
            &request.preset,
            &now,
        );
        draft.id = format!("job-summary-run-{}", Uuid::new_v4());
        draft.idempotency_key = format!("{retry_prefix}{retry_number}");
        self.inner.store.enqueue_job(&draft, &now)?;
        self.publish_unlocked("meeting-summary-requested", Some(meeting_id.into()), None)
    }

    /// Queue a deliberate reprocessing pass over retained source audio using
    /// the provider/model selected in current settings. The selected route is
    /// frozen into this job at enqueue time; automatic repair continues to use
    /// the immutable route recorded at capture start.
    pub fn retranscribe(&self, meeting_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
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
        if !self.inner.store.has_committed_audio(meeting_id)? {
            return Err(MeetingRuntimeError::Validation(
                "retranscription requires retained source audio".into(),
            ));
        }
        let jobs = self.inner.store.list_jobs(meeting_id)?;
        if jobs.iter().any(|job| {
            job.definition.kind == FollowUpJobKind::Custom("transcription".into())
                && matches!(job.state, JobState::Pending | JobState::Running)
        }) {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let projection = self.platform_projection()?;
        validate_config(&projection.config)?;
        let (route, model) = transcription_route(&projection.config);
        let generation = format!("user-{}", Uuid::new_v4());
        let now = self.inner.clock.now();
        let draft = FollowUpJobDraft {
            id: format!("job-retranscription-{generation}"),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key: format!("{meeting_id}:retranscription:{generation}"),
            payload: json!({
                "meetingId": meeting_id,
                "captureGeneration": generation,
                "transcriptRevision": meeting.transcript_revision,
                "transcriptionRoute": route,
                "transcriptionModel": model,
                "transcriptionIntent": "user-retranscription"
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: now.clone(),
        };
        self.inner.store.enqueue_job(&draft, &now)?;
        self.publish_unlocked(
            "meeting-retranscription-requested",
            Some(meeting_id.into()),
            None,
        )
    }

    pub(super) fn summary_job_draft(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        template: &str,
        instructions: &str,
        preset: &str,
        not_before: &str,
    ) -> FollowUpJobDraft {
        let idempotency_key = format!("{meeting_id}:title-summary:{transcript_revision}");
        FollowUpJobDraft {
            id: format!("job-summary-{}", Uuid::new_v4()),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::Summary,
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "transcriptRevision": transcript_revision,
                "template": template,
                "instructions": instructions,
                "preset": preset,
                "output": {
                    "title": "reviewable",
                    "summary": "reviewable"
                },
                "transcriptIsUntrusted": true
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: not_before.into(),
        }
    }

    fn enqueue_kg_job(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        preset: &str,
    ) -> Result<FollowUpJob, MeetingRuntimeError> {
        let now = self.inner.clock.now();
        let idempotency_key = format!("{meeting_id}:kg-proposal:{transcript_revision}");
        if let Some(existing) = self
            .inner
            .store
            .list_jobs(meeting_id)?
            .into_iter()
            .find(|job| job.definition.idempotency_key == idempotency_key)
        {
            return Ok(existing);
        }
        let job = FollowUpJobDraft {
            id: format!("job-kg-{}", Uuid::new_v4()),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::KnowledgeGraph,
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "transcriptRevision": transcript_revision,
                "preset": preset,
                "reviewRequired": true,
                "autoApply": false,
                "transcriptIsUntrusted": true
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: now.clone(),
        };
        Ok(self.inner.store.enqueue_job(&job, &now)?.0)
    }

    pub(super) fn enqueue_transcription_retry(
        &self,
        meeting_id: &str,
        transcript_revision: u64,
        failure: &str,
    ) -> Result<FollowUpJob, MeetingRuntimeError> {
        let meeting = self.inner.store.get_meeting(meeting_id)?;
        let route = meeting
            .metadata
            .get("transcriptionRoute")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable consented transcription route".into(),
                )
            })?;
        let model = meeting
            .metadata
            .get("transcriptionModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable consented transcription model".into(),
                )
            })?;
        let capture_generation = meeting
            .metadata
            .get("runId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "meeting recovery has no immutable capture generation".into(),
                )
            })?;
        let now = self.inner.clock.now();
        let idempotency_key = format!("{meeting_id}:transcription:{capture_generation}");
        if let Some(existing) = self
            .inner
            .store
            .list_jobs(meeting_id)?
            .into_iter()
            .find(|job| job.definition.idempotency_key == idempotency_key)
        {
            return Ok(existing);
        }
        let job = FollowUpJobDraft {
            id: format!("job-transcription-{capture_generation}"),
            meeting_id: meeting_id.into(),
            kind: FollowUpJobKind::Custom("transcription".into()),
            idempotency_key,
            payload: json!({
                "meetingId": meeting_id,
                "captureGeneration": capture_generation,
                "transcriptRevision": transcript_revision,
                "transcriptionRoute": route,
                "transcriptionModel": model,
                "failure": bounded_error(failure)
            }),
            max_attempts: DEFAULT_JOB_ATTEMPTS,
            not_before: now.clone(),
        };
        Ok(self.inner.store.enqueue_job(&job, &now)?.0)
    }
}
