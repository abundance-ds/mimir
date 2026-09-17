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
                MeetingStatus::Recording | MeetingStatus::Stopping
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
                if self.defer_failed_capture_repair(meeting_id, &message)? {
                    return Err(port_error("meeting capture stop", message));
                }
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
        // Freeze the old audio range while capture is still serialized. Each
        // provider then drains only its own run, even after Continue starts.
        self.inner
            .transcription
            .seal(
                meeting_id,
                &active.run_id,
                self.inner.store.next_audio_sequence(meeting_id)?,
            )
            .map_err(|message| port_error("seal transcription audio", message))?;
        *self.active()? = None;
        self.inner
            .drains
            .lock()
            .map_err(|_| port_error("transcript drains", "mutex poisoned".into()))?
            .entry(meeting_id.into())
            .or_default()
            .runs
            .insert(active.run_id.clone());
        self.publish_unlocked(
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
        // Device teardown is complete. Slow provider work must not own the
        // recording lock, so Start, Continue and another Stop remain usable.
        drop(_operation);
        let finalize_result = self.inner.transcription.finalize(&transcript_request);
        let _operation = self.operation()?;
        if self
            .inner
            .store
            .deletion(meeting_id)?
            .is_some_and(|deletion| deletion.mode == StoreDeletionMode::All)
        {
            let mut drains = self
                .inner
                .drains
                .lock()
                .map_err(|_| port_error("transcript drains", "mutex poisoned".into()))?;
            let last = drains.get_mut(meeting_id).is_none_or(|drain| {
                drain.runs.remove(&active.run_id);
                drain.runs.is_empty()
            });
            if last {
                drains.remove(meeting_id);
            }
            drop(drains);
            if last {
                let deletion = self
                    .inner
                    .store
                    .release_deleted_capture(meeting_id, &self.inner.clock.now())?;
                if deletion.stage != MeetingDeletionStage::WaitingForJobs {
                    if let Err(message) = self
                        .inner
                        .platform
                        .delete_meeting(meeting_id, MeetingDeleteMode::All)
                    {
                        self.inner.store.record_deletion_error(
                            meeting_id,
                            &bounded_error(&message),
                            &self.inner.clock.now(),
                        )?;
                    }
                }
            }
            return self.publish_unlocked(
                "meeting-deletion-pending",
                Some(meeting_id.into()),
                None,
            );
        }
        let current = self.inner.store.get_meeting(meeting_id)?;
        let recording = self
            .active()?
            .as_ref()
            .is_some_and(|capture| capture.meeting_id == meeting_id);
        let mut drains = self
            .inner
            .drains
            .lock()
            .map_err(|_| port_error("transcript drains", "mutex poisoned".into()))?;
        let drain = drains.entry(meeting_id.into()).or_default();
        drain.runs.remove(&active.run_id);
        let last = drain.runs.is_empty() && !recording;
        let continued = current.metadata.get("runId").and_then(Value::as_str)
            != Some(active.run_id.as_str())
            || current
                .metadata
                .get("captureRunCount")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                > 1;
        let result = finalize_result.and_then(|mut batch| {
            if !batch.marks_final {
                return Err("transcription finalizer returned a non-terminal batch".into());
            }
            if batch.meeting_id != meeting_id
                || batch.base_revision > current.transcript_revision
                || (!continued && batch.base_revision != current.transcript_revision)
            {
                return Err(
                    "transcription finalizer returned a batch for another meeting or revision"
                        .into(),
                );
            }
            batch.base_revision = current.transcript_revision;
            batch.marks_final = last && drain.error.is_none();
            // The native finalizer has already persisted its segments. Its
            // terminal marker can be deferred until every run has drained.
            if !batch.marks_final && batch.changes.is_empty() {
                return Ok(current.transcript_revision);
            }
            let applied = if batch.marks_final {
                self.inner.store.apply_transcript_batch(&batch)
            } else {
                self.inner.store.append_provider_transcript_batch(&batch)
            };
            applied
                .map(|applied| applied.revision)
                .map_err(|error| error.to_string())
        });
        if let Err(message) = &result {
            drain.error = Some(message.clone());
        }
        if !last {
            drop(drains);
            return self.publish_unlocked(
                "transcript-run-drained",
                Some(meeting_id.into()),
                Some(active.run_id),
            );
        }
        let error = drain.error.clone();
        drains.remove(meeting_id);
        drop(drains);
        if let Some(message) = error {
            let current = self.inner.store.get_meeting(meeting_id)?;
            self.enqueue_transcription_retry(meeting_id, current.transcript_revision, &message)?;
            self.interrupt_after_stop_failure(
                meeting_id,
                &active.run_id,
                current.revision,
                "transcript-finalize-failed",
                &message,
            )?;
            return self.snapshot_unlocked(self.inner.revision.load(Ordering::Acquire));
        }
        let applied_revision =
            result.map_err(|message| port_error("transcript finalization", message))?;
        let after_transcript = self.inner.store.get_meeting(meeting_id)?;
        let overview = self.inner.store.transcript_overview(meeting_id, 1)?;
        let completed_at = self.inner.clock.now();
        let summary_job = (hook_config.summary_enabled && overview.segment_count > 0).then(|| {
            self.summary_job_draft(
                meeting_id,
                applied_revision,
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
        debug_assert_eq!(completed.status, MeetingStatus::Completed);
        self.publish_unlocked(
            "meeting-finalized",
            Some(meeting_id.into()),
            Some(active.run_id),
        )
    }

    fn defer_failed_capture_repair(
        &self,
        meeting_id: &str,
        message: &str,
    ) -> Result<bool, MeetingRuntimeError> {
        let mut drains = self
            .inner
            .drains
            .lock()
            .map_err(|_| port_error("transcript drains", "mutex poisoned".into()))?;
        let Some(drain) = drains.get_mut(meeting_id) else {
            return Ok(false);
        };
        drain.error = Some(message.into());
        let pending = !drain.runs.is_empty();
        if !pending {
            drains.remove(meeting_id);
        }
        drop(drains);
        if !pending {
            let meeting = self.inner.store.get_meeting(meeting_id)?;
            self.enqueue_transcription_retry(meeting_id, meeting.transcript_revision, message)?;
        }
        Ok(true)
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

        if self.defer_failed_capture_repair(meeting_id, message)? {
            return self.publish_unlocked(
                "meeting-interrupted",
                Some(meeting_id.into()),
                Some(run_id.into()),
            );
        }
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
