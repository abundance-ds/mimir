//! Bounded meeting-library, transcript, search, and renderer projections.

use super::*;

impl MeetingRuntime {
    pub fn snapshot(&self) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire))
    }

    pub fn revision(&self) -> u64 {
        self.inner.revision.load(Ordering::Acquire)
    }

    pub fn library_page(
        &self,
        before: Option<MeetingLibraryCursor>,
        limit: Option<u32>,
    ) -> Result<MeetingLibraryPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.library_page_unlocked(before, limit.unwrap_or(DEFAULT_MEETING_LIMIT))
    }

    pub fn meeting(&self, meeting_id: &str) -> Result<MeetingView, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let active = self.active()?.clone();
        let hook_config = self.hook_config()?;
        self.meeting_view(&record, &content, active.as_ref(), &hook_config.kg_prompt)
    }

    pub fn transcript_page(
        &self,
        meeting_id: &str,
        before: Option<MeetingTranscriptCursor>,
        limit: Option<u32>,
    ) -> Result<MeetingTranscriptPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let before = before
            .map(|cursor| {
                Ok::<StoreTranscriptPageCursor, MeetingRuntimeError>(StoreTranscriptPageCursor {
                    start_ms: i64::try_from(cursor.start_ms).map_err(|_| {
                        MeetingRuntimeError::Validation(
                            "transcript cursor start exceeds the durable range".into(),
                        )
                    })?,
                    end_ms: i64::try_from(cursor.end_ms).map_err(|_| {
                        MeetingRuntimeError::Validation(
                            "transcript cursor end exceeds the durable range".into(),
                        )
                    })?,
                    segment_id: cursor.segment_id,
                })
            })
            .transpose()?;
        let page = self.inner.store.transcript_page(
            meeting_id,
            before.as_ref(),
            limit.unwrap_or(MAX_TRANSCRIPT_PAGE_SEGMENTS),
        )?;
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(MeetingTranscriptPage {
            meeting_id: page.meeting_id,
            revision: page.revision,
            total_segments: page.total_segments,
            has_more: page.has_more,
            next_before: page.next_before.map(|cursor| MeetingTranscriptCursor {
                start_ms: cursor.start_ms as u64,
                end_ms: cursor.end_ms as u64,
                segment_id: cursor.segment_id,
            }),
            segments: page
                .segments
                .iter()
                .map(|segment| segment_view(segment, &channel_names))
                .collect(),
            // The latest page doubles as the selected-meeting detail read. Do
            // not retransmit a potentially large reviewed summary on every
            // walk into older transcript pages.
            summary: before.is_none().then_some(content.summary).flatten(),
        })
    }

    pub fn transcript_slice(
        &self,
        meeting_id: &str,
        offset: u64,
        limit: u32,
    ) -> Result<MeetingTranscriptPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let page = self
            .inner
            .store
            .transcript_slice(meeting_id, offset, limit)?;
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(MeetingTranscriptPage {
            meeting_id: page.meeting_id,
            revision: page.revision,
            total_segments: page.total_segments,
            has_more: page.has_more,
            next_before: None,
            segments: page
                .segments
                .iter()
                .map(|segment| segment_view(segment, &channel_names))
                .collect(),
            summary: (offset == 0).then_some(content.summary).flatten(),
        })
    }

    pub fn transcript_slice_since(
        &self,
        meeting_id: &str,
        since_ms: u64,
        limit: u32,
    ) -> Result<MeetingTranscriptPage, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let record = self.inner.store.get_meeting(meeting_id)?;
        let content = self
            .inner
            .platform
            .content(meeting_id)
            .map_err(|message| port_error("meeting content projection", message))?;
        if content.deleted {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is deleted"
            )));
        }
        let since = i64::try_from(since_ms).map_err(|_| {
            MeetingRuntimeError::Validation("since_ms exceeds the durable range".into())
        })?;
        let page = self
            .inner
            .store
            .transcript_slice_since(meeting_id, since, limit)?;
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(MeetingTranscriptPage {
            meeting_id: page.meeting_id,
            revision: page.revision,
            total_segments: page.total_segments,
            has_more: page.has_more,
            next_before: None,
            segments: page
                .segments
                .iter()
                .map(|segment| segment_view(segment, &channel_names))
                .collect(),
            summary: None,
        })
    }

    pub fn search_transcript(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingTranscriptSearchHit>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        self.inner
            .store
            .search_transcript(query, limit)
            .map(|hits| {
                hits.into_iter()
                    .map(|hit| MeetingTranscriptSearchHit {
                        meeting_id: hit.meeting_id,
                        segment_id: hit.segment_id,
                        start_ms: hit.start_ms as u64,
                        text: hit.text,
                    })
                    .collect()
            })
            .map_err(Into::into)
    }

    /// Search the full durable library without depending on the 200-row UI
    /// snapshot. The two indexed streams each contribute enough distinct
    /// meetings to produce the newest bounded union without missing an older
    /// title/summary/tag-only or transcript-only result.
    pub fn search_library(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingLibrarySearchHit>, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(query, "meeting search query")?;
        let limit = limit.min(100);
        if limit == 0 {
            return Ok(Vec::new());
        }
        #[derive(Default)]
        struct MatchAccumulator {
            title: bool,
            summary: bool,
            tags: bool,
            transcript: Vec<MeetingTranscriptSearchHit>,
        }
        let mut candidates = HashMap::<String, MatchAccumulator>::new();
        for hit in self.inner.store.search_content(query, limit)? {
            let candidate = candidates.entry(hit.meeting_id).or_default();
            candidate.title |= hit.title_match;
            candidate.summary |= hit.summary_match;
            candidate.tags |= hit.tags_match;
        }
        for hit in self
            .inner
            .store
            .search_transcript(query, limit.saturating_mul(3))?
        {
            let meeting_id = hit.meeting_id.clone();
            candidates
                .entry(meeting_id)
                .or_default()
                .transcript
                .push(MeetingTranscriptSearchHit {
                    meeting_id: hit.meeting_id,
                    segment_id: hit.segment_id,
                    start_ms: hit.start_ms as u64,
                    text: hit.text,
                });
        }

        let active = self.active()?.clone();
        let hook_config = self.hook_config()?;
        let mut hits = Vec::with_capacity(candidates.len());
        for (meeting_id, matched) in candidates {
            let record = self.inner.store.get_meeting(&meeting_id)?;
            let content = self
                .inner
                .platform
                .content(&meeting_id)
                .map_err(|message| port_error("meeting content projection", message))?;
            if content.deleted
                || !matches!(
                    record.status,
                    MeetingStatus::Completed | MeetingStatus::Interrupted | MeetingStatus::Failed
                )
            {
                continue;
            }
            let view =
                self.meeting_view(&record, &content, active.as_ref(), &hook_config.kg_prompt)?;
            hits.push((
                record.created_at,
                record.id,
                MeetingLibrarySearchHit {
                    meeting: view,
                    matched: MeetingLibrarySearchMatch {
                        title: matched.title,
                        summary: matched.summary,
                        tags: matched.tags,
                        transcript: matched.transcript,
                    },
                },
            ));
        }
        hits.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        hits.truncate(limit as usize);
        Ok(hits.into_iter().map(|(_, _, hit)| hit).collect())
    }

    pub(super) fn snapshot_unlocked(
        &self,
        revision: u64,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let projection = self.platform_projection()?;
        let active = self.active()?.clone();
        let active_meeting_id = active.as_ref().map(|value| value.meeting_id.clone());
        let candidates = if active.is_some() {
            Vec::new()
        } else {
            projection.candidates
        };
        let runtime_diagnostic = self.diagnostic()?.clone();
        let page = self.library_page_unlocked(None, DEFAULT_MEETING_LIMIT)?;
        let mut meetings = page.meetings;
        meetings.sort_by(|left, right| {
            right
                .started_at
                .as_deref()
                .unwrap_or(right.updated_at.as_deref().unwrap_or(""))
                .cmp(
                    left.started_at
                        .as_deref()
                        .unwrap_or(left.updated_at.as_deref().unwrap_or("")),
                )
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(MeetingSnapshot {
            revision,
            meetings,
            meetings_truncated: page.has_more,
            next_meetings_before: page.next_before,
            active_meeting_id,
            candidates,
            config: projection.config,
            permissions: projection.permissions,
            models: projection.models,
            diagnostic: runtime_diagnostic.or(projection.diagnostic),
        })
    }

    pub(super) fn library_page_unlocked(
        &self,
        before: Option<MeetingLibraryCursor>,
        limit: u32,
    ) -> Result<MeetingLibraryPage, MeetingRuntimeError> {
        let active = self.active()?.clone();
        let before = before.map(|cursor| StoreMeetingListCursor {
            created_at: cursor.created_at,
            meeting_id: cursor.meeting_id,
        });
        let page = self
            .inner
            .store
            .list_meetings_page(before.as_ref(), limit.clamp(1, DEFAULT_MEETING_LIMIT))?;
        let hook_config = self.hook_config()?;
        let mut meetings = Vec::with_capacity(page.meetings.len());
        for record in page.meetings {
            let content = self
                .inner
                .platform
                .content(&record.id)
                .map_err(|message| port_error("meeting content projection", message))?;
            if !content.deleted {
                meetings.push(self.meeting_view(
                    &record,
                    &content,
                    active.as_ref(),
                    &hook_config.kg_prompt,
                )?);
            }
        }
        Ok(MeetingLibraryPage {
            meetings,
            has_more: page.has_more,
            next_before: page.next_before.map(|cursor| MeetingLibraryCursor {
                created_at: cursor.created_at,
                meeting_id: cursor.meeting_id,
            }),
        })
    }

    pub(super) fn meeting_view(
        &self,
        record: &MeetingRecord,
        content: &MeetingContentProjection,
        active: Option<&ActiveCapture>,
        kg_prompt: &str,
    ) -> Result<MeetingView, MeetingRuntimeError> {
        let transcript = self
            .inner
            .store
            .transcript_overview(&record.id, MAX_LIBRARY_GAPS)?;
        let transcript_final = transcript.is_final;
        let jobs = self.inner.store.list_jobs(&record.id)?;
        let active = active.filter(|value| value.meeting_id == record.id);
        let full_summary = content
            .summary
            .clone()
            .or_else(|| successful_summary(&jobs, "summary"));
        let (summary, summary_truncated) = summary_preview(full_summary.as_deref());
        let generated_title = successful_summary(&jobs, "title");
        let title = content
            .title
            .clone()
            .or_else(|| {
                (record.title == "Untitled meeting")
                    .then_some(generated_title)
                    .flatten()
            })
            .unwrap_or_else(|| record.title.clone());
        let summary_state = summary_state(&jobs);
        let kg_state = kg_state(
            &jobs,
            &summary_state,
            content.kg_decision.as_deref(),
            kg_prompt,
        );
        let channels = record
            .channels
            .iter()
            .map(|channel| channel.definition.kind.to_string())
            .collect::<Vec<_>>();
        let channel_names = record
            .channels
            .iter()
            .map(|channel| {
                (
                    channel.definition.id.as_str(),
                    channel.definition.kind.to_string(),
                )
            })
            .collect::<HashMap<_, _>>();
        let is_transcription_job = |job: &&FollowUpJob| {
            job.definition.kind == FollowUpJobKind::Custom("transcription".into())
        };
        let transcription_job = jobs
            .iter()
            .rev()
            .filter(is_transcription_job)
            .find(|job| matches!(job.state, JobState::Pending | JobState::Running))
            .or_else(|| {
                jobs.iter().rev().filter(is_transcription_job).find(|job| {
                    job.definition.payload["transcriptionIntent"] == "user-retranscription"
                })
            })
            .or_else(|| jobs.iter().rev().find(is_transcription_job));
        let transcription = if let Some(active) = active {
            if active.transcription == "delayed" {
                active.transcription.clone()
            } else {
                self.inner.transcription.status(&record.id).as_str().into()
            }
        } else if let Some(job) = transcription_job {
            match job.state {
                JobState::Pending => "batch".into(),
                JobState::Running => match self.inner.transcription.status(&record.id) {
                    TranscriptionWorkerStatus::Delayed => "connecting".into(),
                    status => status.as_str().into(),
                },
                JobState::Failed => "failed".into(),
                JobState::Succeeded | JobState::Cancelled if transcript_final => "final".into(),
                JobState::Succeeded | JobState::Cancelled => "delayed".into(),
            }
        } else if transcript_final {
            "final".into()
        } else if record.transcript_revision > 0 {
            "delayed".into()
        } else {
            "idle".into()
        };
        let duration_ms = active
            .map(|value| value.duration_ms)
            .unwrap_or_else(|| duration_ms(record));

        Ok(MeetingView {
            id: record.id.clone(),
            title,
            lifecycle: lifecycle(record.status).into(),
            transcription,
            started_at: record.started_at.clone(),
            recording_started_at: active.map(|value| value.recording_started_at.clone()),
            stopped_at: record.stopped_at.clone(),
            duration_ms,
            workspace_path: content
                .workspace_path
                .clone()
                .or_else(|| metadata_string(&record.metadata, "workspacePath")),
            source_app: content
                .source_app
                .clone()
                .or_else(|| metadata_string(&record.metadata, "sourceApp")),
            tags: content.tags.clone(),
            mic_muted: active.is_some_and(|value| value.mic_muted),
            channels,
            gaps: transcript
                .gaps
                .iter()
                .filter(|gap| gap.resolved_revision.is_none())
                .map(|gap| gap_view(gap, &channel_names))
                .collect(),
            gap_count: transcript.unresolved_gap_count,
            transcript_revision: transcript.revision,
            transcript_final,
            segment_count: transcript.segment_count,
            // A proven terminal transcript with no unresolved partials is
            // all-final even when it contains zero speech segments. Hook
            // eligibility separately requires non-empty speech.
            transcript_all_final: transcript_final && transcript.non_final_segment_count == 0,
            // Transcript bodies are selected-meeting detail, never library
            // snapshot data. Keeping this compatibility field empty prevents
            // accidental whole-history regressions at the IPC boundary.
            segments: Vec::new(),
            summary,
            summary_truncated,
            summary_state,
            kg_state,
            jobs: jobs.iter().map(job_view).collect(),
            error: record
                .failure
                .as_ref()
                .map(|failure| failure.message.clone())
                .or_else(|| record.interruption_reason.clone()),
            updated_at: Some(record.updated_at.clone()),
        })
    }

    pub(super) fn transcript_is_final(
        &self,
        meeting: &MeetingRecord,
    ) -> Result<bool, MeetingRuntimeError> {
        Ok(self
            .inner
            .store
            .transcript_overview(&meeting.id, 1)?
            .is_final)
    }
}
