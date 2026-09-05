use super::*;

impl MeetingRuntime {
    pub fn signal_stop(&self, meeting_id: &str) -> Result<(), MeetingRuntimeError> {
        let _operation = self.operation()?;
        let Some(active) = self.active()?.clone() else {
            // The full Stop command is idempotent. Its early signal follows
            // the same rule so a fast native completion is not an error.
            return Ok(());
        };
        if active.meeting_id != meeting_id {
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        }
        self.inner
            .capture
            .signal_stop(&CaptureStop {
                meeting_id: meeting_id.into(),
                run_id: active.run_id,
            })
            .map_err(|message| port_error("meeting capture stop signal", message))
    }

    pub fn stop(&self, meeting_id: &str) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        // Drop the guard before the idempotent branch re-enters snapshot
        // projection and acquires the same mutex.
        let active_capture = { self.active()?.clone() };
        let Some(active) = active_capture else {
            // Stop is safe to repeat after the durable meeting already reached
            // a non-live state.
            let meeting = self.inner.store.get_meeting(meeting_id)?;
            if !matches!(
                meeting.status,
                MeetingStatus::Recording | MeetingStatus::Stopping | MeetingStatus::Finalizing
            ) {
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        };
        if active.meeting_id != meeting_id {
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        }
        // Resolve non-secret hook policy before stopping native capture. If
        // settings authority is temporarily unavailable, no irreversible
        // lifecycle boundary has been crossed and Stop can be retried safely.
        let hook_config = self.hook_config()?;

        let recording = self.inner.store.get_meeting(meeting_id)?;
        let stopping = if recording.status == MeetingStatus::Recording {
            self.inner.store.transition_meeting(
                meeting_id,
                recording.revision,
                MeetingStatus::Stopping,
                &self.inner.clock.now(),
                None,
            )?
        } else {
            recording
        };
        let _ = self.publish_unlocked(
            "capture-stopping",
            Some(meeting_id.into()),
            Some(active.run_id.clone()),
        )?;

        let stopped = match self.inner.capture.stop(&CaptureStop {
            meeting_id: meeting_id.into(),
            run_id: active.run_id.clone(),
        }) {
            Ok(result) => result,
            Err(message) => {
                // A native worker can fail just before Stop acquires the
                // operation lock. Its retained handle then reports that
                // terminal error here, before the asynchronous callback is
                // delivered. Persist failure intent first, then drain/remove
                // the live transcriber session before recovery can be claimed
                // in this same process.
                let after_capture_failure = self.inner.store.get_meeting(meeting_id)?;
                let failure = MeetingFailure {
                    code: "capture-stop-failed".into(),
                    message: bounded_error(&message),
                    retryable: true,
                };
                let interrupted = self.inner.store.transition_meeting(
                    meeting_id,
                    after_capture_failure.revision,
                    MeetingStatus::Interrupted,
                    &self.inner.clock.now(),
                    Some(&failure),
                )?;
                *self.active()? = None;
                self.set_diagnostic(format!("capture-stop-failed: {}", bounded_error(&message)))?;
                if let Err(error) = self.publish_unlocked(
                    "meeting-interrupted",
                    Some(meeting_id.into()),
                    Some(active.run_id.clone()),
                ) {
                    log::error!("Could not publish the durable Scribe stop failure: {error}");
                }

                let finalize = self.inner.transcription.finalize(&TranscriptionFinalize {
                    meeting_id: meeting_id.into(),
                    run_id: active.run_id.clone(),
                    base_revision: interrupted.transcript_revision,
                    observed_at: self.inner.clock.now(),
                });
                let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
                let terminal_applied = match finalize {
                    Ok(batch)
                        if batch.meeting_id == meeting_id
                            && batch.base_revision == after_provider_drain.transcript_revision
                            && batch.marks_final =>
                    {
                        self.inner.store.apply_transcript_batch(&batch).is_ok()
                    }
                    _ => false,
                };
                let current = self.inner.store.get_meeting(meeting_id)?;
                if terminal_applied {
                    self.inner.store.transition_meeting(
                        meeting_id,
                        current.revision,
                        MeetingStatus::Failed,
                        &self.inner.clock.now(),
                        Some(&failure),
                    )?;
                } else {
                    self.enqueue_transcription_retry(
                        meeting_id,
                        current.transcript_revision,
                        &message,
                    )?;
                }
                return Err(port_error("meeting capture stop", message));
            }
        };

        if let Some(current) = self.active()?.as_mut() {
            current.duration_ms = stopped.duration_ms;
        }
        // Native capture joins before finalization. During device reconnect or
        // sleep recovery that join can durably append an explicit transcript
        // gap, which advances both the transcript and meeting revisions.
        // Finalization must extend that post-teardown authority rather than
        // the revision captured before Stop signalled the worker.
        debug_assert_eq!(stopping.status, MeetingStatus::Stopping);
        let after_capture_stop = self.inner.store.get_meeting(meeting_id)?;
        let finalizing = self.inner.store.transition_meeting(
            meeting_id,
            after_capture_stop.revision,
            MeetingStatus::Finalizing,
            &self.inner.clock.now(),
            None,
        )?;
        let _ = self.publish_unlocked(
            "transcript-finalizing",
            Some(meeting_id.into()),
            Some(active.run_id.clone()),
        )?;

        let transcript_request = TranscriptionFinalize {
            meeting_id: meeting_id.into(),
            run_id: active.run_id.clone(),
            base_revision: finalizing.transcript_revision,
            observed_at: self.inner.clock.now(),
        };
        let finalize_result = self.inner.transcription.finalize(&transcript_request);
        // A provider can durably commit acknowledged tail segments before
        // either completing or reporting a terminal failure.
        let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
        let batch = match finalize_result {
            Ok(batch) => batch,
            Err(message) => {
                self.enqueue_transcription_retry(
                    meeting_id,
                    after_provider_drain.transcript_revision,
                    &message,
                )?;
                self.interrupt_after_stop_failure(
                    meeting_id,
                    &active.run_id,
                    after_provider_drain.revision,
                    "transcript-finalize-failed",
                    &message,
                )?;
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
        };
        if !batch.marks_final {
            let message = "transcription finalizer returned a non-terminal batch";
            self.enqueue_transcription_retry(
                meeting_id,
                after_provider_drain.transcript_revision,
                message,
            )?;
            self.interrupt_after_stop_failure(
                meeting_id,
                &active.run_id,
                after_provider_drain.revision,
                "transcript-not-final",
                message,
            )?;
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        // The transcription port may durably commit final live-provider
        // segments while draining its acknowledged tail. Refresh after the
        // worker joins and require the terminal marker to extend that exact
        // durable revision, not the pre-join snapshot.
        if batch.meeting_id != meeting_id
            || batch.base_revision != after_provider_drain.transcript_revision
        {
            let message =
                "transcription finalizer returned a batch for another meeting or revision";
            self.enqueue_transcription_retry(
                meeting_id,
                after_provider_drain.transcript_revision,
                message,
            )?;
            self.interrupt_after_stop_failure(
                meeting_id,
                &active.run_id,
                after_provider_drain.revision,
                "transcript-invalid-batch",
                message,
            )?;
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let applied = match self.inner.store.apply_transcript_batch(&batch) {
            Ok(applied) => applied,
            Err(error) => {
                let message = error.to_string();
                self.enqueue_transcription_retry(
                    meeting_id,
                    after_provider_drain.transcript_revision,
                    &message,
                )?;
                self.interrupt_after_stop_failure(
                    meeting_id,
                    &active.run_id,
                    after_provider_drain.revision,
                    "transcript-persist-failed",
                    &message,
                )?;
                return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
            }
        };
        let after_transcript = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        let completed_at = self.inner.clock.now();
        let summary_job = (hook_config.summary_enabled && overview.segment_count > 0).then(|| {
            self.summary_job_draft(
                meeting_id,
                applied.revision,
                &hook_config.summary_template,
                &hook_config.summary_prompt,
                &hook_config.summary_preset,
                &completed_at,
            )
        });
        let (completed, _) = self.inner.store.complete_meeting_with_job(
            meeting_id,
            after_transcript.revision,
            &completed_at,
            summary_job.as_ref(),
        )?;
        *self.active()? = None;

        debug_assert_eq!(completed.status, MeetingStatus::Completed);
        self.publish_unlocked(
            "meeting-finalized",
            Some(meeting_id.into()),
            Some(active.run_id),
        )
    }

    pub fn set_microphone_muted(
        &self,
        meeting_id: &str,
        muted: bool,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active =
            self.active()?
                .clone()
                .ok_or_else(|| MeetingRuntimeError::NotActiveMeeting {
                    meeting_id: meeting_id.into(),
                })?;
        if active.meeting_id != meeting_id {
            return Err(MeetingRuntimeError::NotActiveMeeting {
                meeting_id: meeting_id.into(),
            });
        }
        if active.mic_muted == muted {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        self.inner
            .capture
            .set_microphone_muted(meeting_id, &active.run_id, muted)
            .map_err(|message| port_error("microphone mute", message))?;
        if let Some(current) = self.active()?.as_mut() {
            current.mic_muted = muted;
        }
        self.publish_unlocked(
            "microphone-muted-changed",
            Some(meeting_id.into()),
            Some(active.run_id),
        )
    }

    pub(super) fn handle_capture_failure(
        &self,
        meeting_id: &str,
        run_id: &str,
        message: &str,
    ) -> Result<MeetingSnapshot, MeetingRuntimeError> {
        let _operation = self.operation()?;
        let active = self.active()?.clone();
        let Some(active) = active else {
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        };
        if active.meeting_id != meeting_id || active.run_id != run_id {
            // Late completion from a superseded native worker has no authority
            // over the current session.
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }

        // The worker has already ended. `stop` removes and joins its retained
        // handle; its expected terminal error must not prevent transcript
        // drainage or durable lifecycle repair.
        let _ = self.inner.capture.stop(&CaptureStop {
            meeting_id: meeting_id.into(),
            run_id: run_id.into(),
        });
        let recording = self.inner.store.get_meeting(meeting_id)?;
        let failure = MeetingFailure {
            code: "capture-runtime-failed".into(),
            message: bounded_error(message),
            retryable: true,
        };
        let interrupted = self.inner.store.transition_meeting(
            meeting_id,
            recording.revision,
            MeetingStatus::Interrupted,
            &self.inner.clock.now(),
            Some(&failure),
        )?;
        *self.active()? = None;
        let _ = self.set_diagnostic(format!(
            "Recording stopped after a native capture failure: {}",
            bounded_error(message)
        ));
        // Publish the durable failure before draining a slow provider. This is
        // a renderer invalidation only; projection failure cannot delay
        // transcript repair or undo the already committed lifecycle.
        if let Err(error) = self.publish_unlocked(
            "capture-runtime-failed",
            Some(meeting_id.into()),
            Some(run_id.into()),
        ) {
            log::error!("Could not publish the durable Scribe capture failure: {error}");
        }

        let finalize = self.inner.transcription.finalize(&TranscriptionFinalize {
            meeting_id: meeting_id.into(),
            run_id: run_id.into(),
            base_revision: interrupted.transcript_revision,
            observed_at: self.inner.clock.now(),
        });

        let after_provider_drain = self.inner.store.get_meeting(meeting_id)?;
        let transcript_final = match finalize {
            Ok(batch)
                if batch.meeting_id == meeting_id
                    && batch.base_revision == after_provider_drain.transcript_revision
                    && batch.marks_final =>
            {
                self.inner.store.apply_transcript_batch(&batch).is_ok()
            }
            _ => false,
        };
        let current = self.inner.store.get_meeting(meeting_id)?;
        if transcript_final {
            self.inner.store.transition_meeting(
                meeting_id,
                current.revision,
                MeetingStatus::Failed,
                &self.inner.clock.now(),
                Some(&failure),
            )?;
            self.publish_unlocked(
                "capture-runtime-reconciled",
                Some(meeting_id.into()),
                Some(run_id.into()),
            )
        } else {
            self.enqueue_transcription_retry(
                meeting_id,
                current.transcript_revision,
                "capture ended before transcript finalization",
            )?;
            self.publish_unlocked(
                "transcription-repair-queued",
                Some(meeting_id.into()),
                Some(run_id.into()),
            )
        }
    }
}
