use super::*;

impl MeetingRuntime {
    pub fn new(
        store: Arc<MeetingStore>,
        capture: Arc<dyn MeetingCapturePort>,
        transcription: Arc<dyn MeetingTranscriptionPort>,
        platform: Arc<dyn MeetingPlatformPort>,
        clock: Arc<dyn MeetingClock>,
        events: Arc<dyn MeetingEventSink>,
    ) -> Result<Self, MeetingRuntimeError> {
        let observed_at = clock.now();
        let recovery = store.recover_after_restart(&observed_at)?;
        let recovered = !recovery.interrupted_meeting_ids.is_empty()
            || !recovery.requeued_job_ids.is_empty()
            || !recovery.failed_job_ids.is_empty()
            || !recovery.staged_audio_chunks.is_empty();
        let runtime = Self {
            inner: Arc::new(MeetingRuntimeInner {
                store,
                capture,
                transcription,
                platform,
                clock,
                events,
                operation: Mutex::new(()),
                active: Mutex::new(None),
                revision: AtomicU64::new(u64::from(recovered)),
                diagnostic: Mutex::new(None),
            }),
        };
        let recovered_tail_meetings = recovery
            .staged_audio_chunks
            .iter()
            .map(|chunk| chunk.definition.meeting_id.clone())
            .collect::<HashSet<_>>();
        // Staged audio is authority that may have crossed the file durability
        // boundary immediately before the process died. Verify/promote it
        // before deciding whether an existing terminal transcript is complete.
        let audio_recovery_ready = match runtime.inner.capture.recover(&recovery) {
            Ok(()) => runtime.inner.store.finish_audio_recovery(&recovery)?,
            Err(error) => {
                runtime
                    .set_diagnostic(format!("Meeting audio recovery needs attention: {error}"))?;
                false
            }
        };
        if audio_recovery_ready {
            // Recovery is driven from every durable interrupted record, not
            // only meetings that crossed the live -> interrupted transition
            // during this launch. Repeated restarts therefore reuse one stable
            // capture-generation job instead of minting revision-derived
            // owners.
            for meeting_id in runtime.inner.store.interrupted_meeting_ids()? {
                let meeting = runtime.inner.store.get_meeting(&meeting_id)?;
                if !recovered_tail_meetings.contains(&meeting.id)
                    && runtime.complete_terminal_recovery_unlocked(&meeting)?
                {
                    continue;
                }
                if let Err(error) = runtime.enqueue_transcription_retry(
                    &meeting.id,
                    meeting.transcript_revision,
                    "application restarted before transcript finalization",
                ) {
                    // Recovery must never substitute today's provider selection
                    // for the route the human originally approved. Legacy or
                    // damaged records without that immutable disclosure remain
                    // safely interrupted and can still retain/export their audio.
                    runtime.set_diagnostic(format!(
                        "Meeting '{}' needs transcription recovery, but its original consented route is unavailable: {}",
                        meeting.id,
                        bounded_error(&error.to_string())
                    ))?;
                }
            }
        } else if !recovery.staged_audio_chunks.is_empty() {
            runtime.set_diagnostic(
                "Meeting audio recovery remains unresolved; transcript finalization is paused"
                    .into(),
            )?;
        }
        Ok(runtime)
    }

    pub(crate) fn capture_failure_sink(&self) -> Arc<dyn MeetingCaptureFailureSink> {
        Arc::new(WeakMeetingRuntime {
            inner: Arc::downgrade(&self.inner),
        })
    }

    pub fn dismiss_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        require_nonempty(candidate_id, "meeting candidate id")?;
        self.inner
            .platform
            .dismiss_candidate(candidate_id)
            .map_err(|message| port_error("meeting candidate dismissal", message))?;
        self.publish_unlocked("candidate-dismissed", None, None)
    }

    /// Resolve the exact native state a human must see before recording.
    ///
    /// The command layer uses this both when issuing a consent grant and when
    /// consuming it. `start` resolves it once more while holding the runtime
    /// operation lock, closing the settings/candidate TOCTOU window.
    #[cfg(test)]
    pub(crate) fn start_consent_context(
        &self,
        candidate_id: Option<&str>,
    ) -> Result<MeetingStartConsentContext, MeetingRuntimeError> {
        self.start_consent_context_for(candidate_id, None)
    }

    pub(crate) fn start_consent_context_for(
        &self,
        candidate_id: Option<&str>,
        continue_meeting_id: Option<&str>,
    ) -> Result<MeetingStartConsentContext, MeetingRuntimeError> {
        let _operation = self.operation()?;
        if candidate_id.is_some() && continue_meeting_id.is_some() {
            return Err(MeetingRuntimeError::Validation(
                "a detected meeting and a completed meeting cannot be recorded in one start request"
                    .into(),
            ));
        }
        if let Some(meeting_id) = continue_meeting_id {
            require_nonempty(meeting_id, "meeting id")?;
            let meeting = self.inner.store.get_meeting(meeting_id)?;
            if !matches!(
                meeting.status,
                MeetingStatus::Detected | MeetingStatus::Completed
            ) {
                return Err(MeetingRuntimeError::Validation(format!(
                    "meeting '{meeting_id}' is {} and cannot be recorded",
                    meeting.status
                )));
            }
        }
        let projection = self.platform_projection()?;
        validate_config(&projection.config)?;
        consent_context_for_projection(&projection, candidate_id, continue_meeting_id)
    }

    pub fn prepare(
        &self,
        request: PrepareMeetingRequest,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        if let Some(active) = self.active()?.as_ref() {
            return Err(MeetingRuntimeError::ActiveMeeting {
                meeting_id: active.meeting_id.clone(),
            });
        }
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled meeting")
            .to_string();
        require_nonempty(&title, "meeting title")?;
        if title.chars().count() > 512 {
            return Err(MeetingRuntimeError::Validation(
                "meeting title exceeds 512 characters".into(),
            ));
        }
        let observed_at = self.inner.clock.now();
        let meeting_id = format!("meeting-{}", Uuid::new_v4());
        self.inner.store.create_meeting(
            &MeetingDraft {
                id: meeting_id.clone(),
                title,
                origin: MeetingOrigin::default(),
                // Prepared meetings define both possible channels. Recording
                // later selects only the channels allowed at that moment.
                channels: prepared_channels(),
                metadata: json!({
                    "workspacePath": request.workspace_path,
                    "prepared": true,
                }),
            },
            &observed_at,
        )?;
        self.publish_unlocked("meeting-prepared", Some(meeting_id), None)
    }

    pub fn start(
        &self,
        request: StartMeetingRequest,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let projection = self.platform_projection()?;
        validate_config(&projection.config)?;
        let current_consent = consent_context_for_projection(
            &projection,
            request.candidate_id.as_deref(),
            request.continue_meeting_id.as_deref(),
        )?;
        match request.authorized_consent.as_ref() {
            None => return Err(MeetingRuntimeError::ConsentRequired),
            Some(authorized) if authorized != &current_consent => {
                return Err(MeetingRuntimeError::ConsentContextChanged);
            }
            Some(_) => {}
        }
        if !matches!(
            projection.permissions.microphone.as_str(),
            "granted" | "development-host"
        ) {
            return Err(MeetingRuntimeError::MicrophonePermissionRequired);
        }

        let request_key = stable_start_key(&request);
        // Bind the clone separately so the mutex guard is dropped before an
        // idempotent reply calls back into snapshot projection.
        let active_capture = { self.active()?.clone() };
        if let Some(active) = active_capture {
            if request_key.is_some() && request_key == active.request_key {
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
            return Err(MeetingRuntimeError::ActiveMeeting {
                meeting_id: active.meeting_id,
            });
        }

        let prepared = match request.continue_meeting_id.as_deref() {
            Some(meeting_id) => {
                let meeting = self.inner.store.get_meeting(meeting_id)?;
                if meeting.status == MeetingStatus::Completed {
                    return self.continue_completed_unlocked(request, &projection, request_key);
                }
                if meeting.status != MeetingStatus::Detected {
                    return Err(MeetingRuntimeError::Validation(format!(
                        "meeting '{meeting_id}' is {} and cannot be recorded",
                        meeting.status
                    )));
                }
                Some(meeting)
            }
            None => None,
        };

        if prepared.is_some() && request.candidate_id.is_some() {
            return Err(MeetingRuntimeError::Validation(
                "a prepared meeting and a detected meeting cannot share one recording".into(),
            ));
        }

        let meeting_id = prepared
            .as_ref()
            .map(|meeting| meeting.id.clone())
            .unwrap_or_else(|| format!("meeting-{}", Uuid::new_v4()));
        let run_id = format!("run-{}", Uuid::new_v4());
        let observed_at = self.inner.clock.now();
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| prepared.as_ref().map(|meeting| meeting.title.as_str()))
            .unwrap_or("Untitled meeting")
            .to_string();
        let channels = capture_channels(&projection.permissions);
        let candidate = request.candidate_id.as_ref().and_then(|candidate_id| {
            projection
                .candidates
                .iter()
                .find(|candidate| &candidate.id == candidate_id)
        });
        if request.candidate_id.is_some() && candidate.is_none() {
            return Err(MeetingRuntimeError::Validation(
                "the selected meeting candidate is no longer available".into(),
            ));
        }
        let origin = prepared
            .as_ref()
            .map(|meeting| meeting.origin.clone())
            .unwrap_or_else(|| MeetingOrigin {
                kind: if candidate.is_some() {
                    "detected".into()
                } else {
                    "manual".into()
                },
                external_id: request.candidate_id.clone(),
                confidence: candidate.map(|value| value.confidence),
                evidence: candidate
                    .map(|value| {
                        json!({
                            "appId": value.app_id,
                            "appName": value.app_name,
                        })
                    })
                    .unwrap_or_else(|| json!({})),
            });
        let (transcription_route, transcription_model) = transcription_route(&projection.config);
        let metadata = json!({
            "workspacePath": request.workspace_path.clone(),
            "sourceApp": candidate.map(|value| value.app_name.clone()),
            "consentConfirmed": true,
            "consentObservedAt": observed_at.clone(),
            "transcriptionRoute": transcription_route,
            "transcriptionModel": transcription_model,
            "retentionDays": projection.config.retention_days,
            "microphoneDeviceId": projection.config.microphone_device_id.clone(),
            "runId": run_id.clone(),
        });
        let created = if let Some(prepared) = prepared {
            self.inner.store.arm_detected_meeting(
                &meeting_id,
                prepared.revision,
                &metadata,
                &observed_at,
            )?
        } else {
            self.inner.store.create_meeting(
                &MeetingDraft {
                    id: meeting_id.clone(),
                    title,
                    origin,
                    channels: channels.clone(),
                    metadata,
                },
                &observed_at,
            )?
        };
        let capture_request = CaptureStart {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            workspace_path: request.workspace_path.clone(),
            microphone_device_id: projection.config.microphone_device_id.clone(),
            channels,
            first_sequence: 0,
        };
        // Publish the durable Recording state before opening native streams.
        // If capture cannot start, the ordinary Recording -> Failed
        // transition closes the attempt. This ordering ensures there is no
        // fallible persistence boundary after a worker starts but before the
        // runtime owns it.
        let recording = if created.status == MeetingStatus::Recording {
            created
        } else {
            self.inner.store.transition_meeting(
                &meeting_id,
                created.revision,
                MeetingStatus::Recording,
                &self.inner.clock.now(),
                None,
            )?
        };
        // Install runtime ownership before the native worker is spawned. The
        // capture port returns once that worker is registered, while Core
        // Audio opens on the worker thread. A terminal open failure can
        // therefore never outrun ActiveCapture, and Stop has an authoritative
        // run token even while the devices are still opening.
        *self.active()? = Some(ActiveCapture {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            request_key: request_key.clone(),
            mic_muted: false,
            transcription: "initializing".into(),
            duration_ms: 0,
            recording_started_at: observed_at.clone(),
        });
        if let Err(message) = self.inner.capture.start(&capture_request) {
            let failure = MeetingFailure {
                code: "capture-start-failed".into(),
                message: bounded_error(&message),
                retryable: true,
            };
            self.inner.store.transition_meeting(
                &meeting_id,
                recording.revision,
                MeetingStatus::Failed,
                &self.inner.clock.now(),
                Some(&failure),
            )?;
            {
                let mut active = self.active()?;
                if active.as_ref().is_some_and(|active| {
                    active.meeting_id == meeting_id && active.run_id == run_id
                }) {
                    *active = None;
                }
            }
            let _ = self.publish_unlocked("capture-failed", Some(meeting_id.clone()), Some(run_id));
            return Err(port_error("meeting capture start", message));
        }

        let route = recording
            .metadata
            .get("transcriptionRoute")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "durable recording is missing its consented transcription route".into(),
                )
            })?
            .to_string();
        let model = recording
            .metadata
            .get("transcriptionModel")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "durable recording is missing its consented transcription model".into(),
                )
            })?
            .to_string();
        let transcription_request = TranscriptionStart {
            meeting_id: meeting_id.clone(),
            run_id: run_id.clone(),
            route,
            model,
            first_sequence: 0,
            repair_generation: None,
            repair_intent: None,
        };
        let transcription = match self.inner.transcription.start(&transcription_request) {
            Ok(()) => self.inner.transcription.status(&meeting_id).as_str().into(),
            Err(error) => {
                self.set_diagnostic(format!(
                    "Recording continues; live transcription is delayed: {}",
                    bounded_error(&error)
                ))?;
                "delayed".into()
            }
        };
        if let Some(active) = self
            .active()?
            .as_mut()
            .filter(|active| active.meeting_id == meeting_id && active.run_id == run_id)
        {
            active.transcription = transcription;
        }
        if let Some(candidate_id) = request.candidate_id.as_deref() {
            if let Err(message) = self.inner.platform.dismiss_candidate(candidate_id) {
                self.set_diagnostic(format!(
                    "Recording started, but its meeting suggestion could not be dismissed: {}",
                    bounded_error(&message)
                ))?;
            }
        }

        debug_assert_eq!(recording.status, MeetingStatus::Recording);
        self.publish_unlocked("capture-started", Some(meeting_id), Some(run_id))
    }

    fn continue_completed_unlocked(
        &self,
        request: StartMeetingRequest,
        projection: &MeetingPlatformProjection,
        request_key: Option<String>,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let meeting_id = request
            .continue_meeting_id
            .as_deref()
            .ok_or_else(|| MeetingRuntimeError::Validation("meeting id is required".into()))?;
        require_nonempty(meeting_id, "meeting id")?;
        if request.candidate_id.is_some() {
            return Err(MeetingRuntimeError::Validation(
                "a detected meeting cannot continue an existing meeting".into(),
            ));
        }
        let previous = self.inner.store.get_meeting(meeting_id)?;
        if previous.status != MeetingStatus::Completed {
            return Err(MeetingRuntimeError::Validation(format!(
                "meeting '{meeting_id}' is {} and cannot be continued",
                previous.status
            )));
        }
        let (route, model) = transcription_route(&projection.config);
        let previous_route =
            metadata_string(&previous.metadata, "transcriptionRoute").ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "the completed meeting is missing its transcription route".into(),
                )
            })?;
        let previous_model =
            metadata_string(&previous.metadata, "transcriptionModel").ok_or_else(|| {
                MeetingRuntimeError::Validation(
                    "the completed meeting is missing its transcription model".into(),
                )
            })?;
        if route != previous_route || model != previous_model {
            return Err(MeetingRuntimeError::Validation(format!(
                "this meeting used {previous_model}; select the same transcription setup to continue it, or start a new meeting"
            )));
        }

        let first_sequence = self.inner.store.next_audio_sequence(meeting_id)?;
        let run_id = format!("run-{}", Uuid::new_v4());
        let observed_at = self.inner.clock.now();
        let previous_metadata = previous.metadata.clone();
        let mut metadata = previous.metadata.clone();
        let metadata_object = metadata.as_object_mut().ok_or_else(|| {
            MeetingRuntimeError::Validation("meeting metadata must be an object".into())
        })?;
        metadata_object.insert("continuationPreviousMetadata".into(), previous_metadata);
        metadata_object.insert("runId".into(), Value::String(run_id.clone()));
        metadata_object.insert(
            "captureRunCount".into(),
            Value::from(
                metadata_object
                    .get("captureRunCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .saturating_add(1),
            ),
        );
        metadata_object.insert(
            "continuationFirstSequence".into(),
            Value::from(first_sequence),
        );
        metadata_object.insert(
            "continuationPreviousStoppedAt".into(),
            previous
                .stopped_at
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        metadata_object.insert(
            "continuationPreviousFinalizedAt".into(),
            previous
                .finalized_at
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        metadata_object.insert(
            "microphoneDeviceId".into(),
            projection
                .config
                .microphone_device_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        let recording = self.inner.store.reopen_completed_meeting(
            meeting_id,
            previous.revision,
            &run_id,
            &metadata,
            &observed_at,
        )?;
        let channels = recording
            .channels
            .iter()
            .map(|channel| channel.definition.clone())
            .collect::<Vec<_>>();
        let capture_request = CaptureStart {
            meeting_id: meeting_id.into(),
            run_id: run_id.clone(),
            workspace_path: request
                .workspace_path
                .or_else(|| metadata_string(&recording.metadata, "workspacePath")),
            microphone_device_id: projection.config.microphone_device_id.clone(),
            channels,
            first_sequence,
        };
        *self.active()? = Some(ActiveCapture {
            meeting_id: meeting_id.into(),
            run_id: run_id.clone(),
            request_key,
            mic_muted: false,
            transcription: "initializing".into(),
            duration_ms: first_sequence.saturating_mul(1_000),
            recording_started_at: observed_at,
        });
        if let Err(message) = self.inner.capture.start(&capture_request) {
            self.inner.store.rollback_meeting_continuation(
                meeting_id,
                recording.revision,
                &run_id,
                &self.inner.clock.now(),
            )?;
            *self.active()? = None;
            let _ = self.publish_unlocked("capture-failed", Some(meeting_id.into()), Some(run_id));
            return Err(port_error("meeting capture start", message));
        }

        let transcription_request = TranscriptionStart {
            meeting_id: meeting_id.into(),
            run_id: run_id.clone(),
            route,
            model,
            first_sequence,
            repair_generation: None,
            repair_intent: None,
        };
        let transcription = match self.inner.transcription.start(&transcription_request) {
            Ok(()) => self.inner.transcription.status(meeting_id).as_str().into(),
            Err(error) => {
                self.set_diagnostic(format!(
                    "Recording continues; live transcription is delayed: {}",
                    bounded_error(&error)
                ))?;
                "delayed".into()
            }
        };
        if let Some(active) = self
            .active()?
            .as_mut()
            .filter(|active| active.meeting_id == meeting_id && active.run_id == run_id)
        {
            active.transcription = transcription;
        }
        self.publish_unlocked("capture-continued", Some(meeting_id.into()), Some(run_id))
    }
}
