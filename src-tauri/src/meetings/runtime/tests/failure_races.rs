#[test]
fn failed_capture_worker_and_stop_race_enqueue_exactly_one_repair() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(FakeCapture::default());
    let transcription = Arc::new(AlwaysFailTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture,
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "capture-stop-race"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = transcription.starts.lock().unwrap()[0].run_id.clone();
    let barrier = Arc::new(Barrier::new(3));
    let stop_runtime = runtime.clone();
    let stop_meeting = meeting_id.clone();
    let stop_barrier = Arc::clone(&barrier);
    let stop = thread::spawn(move || {
        stop_barrier.wait();
        stop_runtime.stop(&stop_meeting)
    });
    let failure_runtime = runtime.clone();
    let failure_meeting = meeting_id.clone();
    let failure_run = run_id.clone();
    let failure_barrier = Arc::clone(&barrier);
    let failure = thread::spawn(move || {
        failure_barrier.wait();
        failure_runtime.handle_capture_failure(
            &failure_meeting,
            &failure_run,
            "native worker failed",
        )
    });
    barrier.wait();
    stop.join().unwrap().unwrap();
    failure.join().unwrap().unwrap();

    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Interrupted
    );
    assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
    let jobs = store.list_jobs(&meeting_id).unwrap();
    let repairs = jobs
        .iter()
        .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .collect::<Vec<_>>();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].state, JobState::Pending);
    assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
    assert_eq!(
        repairs[0].definition.idempotency_key,
        format!("{meeting_id}:transcription:{run_id}")
    );
}

#[test]
fn stop_winning_failed_worker_race_enqueues_repair_before_delayed_callback() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(EndedWorkerCapture::default());
    let transcription = Arc::new(SessionOwningFailTranscription::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone(),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "ended-worker-stop-race"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = capture.starts.lock().unwrap()[0].run_id.clone();

    let stop_error = runtime.stop(&meeting_id).unwrap_err();
    assert!(stop_error.to_string().contains("already ended"));
    // The native failure notifier was queued before Stop but arrives only
    // after Stop released the operation lock.
    runtime
        .handle_capture_failure(
            &meeting_id,
            &run_id,
            "capture worker already ended after a durable chunk failure",
        )
        .unwrap();

    let snapshot = runtime.snapshot().unwrap();
    assert!(snapshot.active_meeting_id.is_none());
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Interrupted
    );
    assert_eq!(capture.stops.lock().unwrap().len(), 1);
    let repairs = store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .filter(|job| job.definition.kind == FollowUpJobKind::Custom("transcription".into()))
        .collect::<Vec<_>>();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].state, JobState::Pending);
    assert_eq!(repairs[0].definition.payload["captureGeneration"], run_id);
    transcription
        .start(&TranscriptionStart {
            meeting_id: meeting_id.clone(),
            run_id: format!("repair-{run_id}"),
            route: repairs[0].definition.payload["transcriptionRoute"]
                .as_str()
                .unwrap()
                .into(),
            model: repairs[0].definition.payload["transcriptionModel"]
                .as_str()
                .unwrap()
                .into(),
            first_sequence: 0,
            repair_generation: Some(run_id.clone()),
            repair_intent: None,
        })
        .expect("Stop must remove the live transcription session before repair");
    assert_eq!(transcription.finalizes.lock().unwrap().len(), 1);
    assert_eq!(transcription.starts.lock().unwrap().len(), 2);
}

#[test]
fn renderer_dto_uses_exact_final_and_projection_fields() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "serde-shape"))
        .unwrap();
    let snapshot = fixture
        .runtime
        .stop(started.active_meeting_id.as_deref().unwrap())
        .unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    let meeting = &value["meetings"][0];
    for field in [
        "lifecycle",
        "transcription",
        "segments",
        "summaryState",
        "kgState",
        "jobs",
    ] {
        assert!(
            meeting.get(field).is_some(),
            "missing renderer field {field}"
        );
    }
    assert_eq!(meeting["segments"], json!([]));
    let page = fixture
        .runtime
        .transcript_page(started.active_meeting_id.as_deref().unwrap(), None, None)
        .unwrap();
    let page = serde_json::to_value(page).unwrap();
    assert_eq!(page["segments"][0]["final"], true);
    assert!(page["segments"][0].get("final_").is_none());

    let clear_retention: MeetingConfigPatch =
        serde_json::from_value(json!({ "retentionDays": null })).unwrap();
    let omitted_retention: MeetingConfigPatch = serde_json::from_value(json!({})).unwrap();
    assert_eq!(clear_retention.retention_days, Some(None));
    assert_eq!(omitted_retention.retention_days, None);
    let clear_microphone: MeetingConfigPatch =
        serde_json::from_value(json!({ "microphoneDeviceId": null })).unwrap();
    let omitted_microphone: MeetingConfigPatch = serde_json::from_value(json!({})).unwrap();
    assert_eq!(clear_microphone.microphone_device_id, Some(None));
    assert_eq!(omitted_microphone.microphone_device_id, None);
}

#[test]
fn external_operations_propagate_real_port_failures() {
    let fixture = make_fixture();
    fixture.platform.state.lock().unwrap().fail_model_install = Some("checksum mismatch".into());
    let error = fixture.runtime.install_model("whisper-small").unwrap_err();
    assert!(error.to_string().contains("checksum mismatch"));
    assert!(fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .models
        .is_empty());

    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "export-error"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    fixture.platform.state.lock().unwrap().fail_export = Some("destination unavailable".into());
    let error = fixture
        .runtime
        .export(&meeting_id, MeetingExportFormat::Markdown)
        .unwrap_err();
    assert!(error.to_string().contains("destination unavailable"));
    assert!(fixture.platform.state.lock().unwrap().exports.is_empty());
}

#[test]
fn mtg_153_running_activity_only_releases_deletion_wait_and_cannot_recreate_content() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "deletion-authority"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    fixture.runtime.stop(&meeting_id).unwrap();
    let running = fixture
        .runtime
        .claim_next_job("activity-worker", LEASE_END)
        .unwrap()
        .unwrap();

    let deleted = fixture
        .runtime
        .delete(&meeting_id, MeetingDeleteMode::All)
        .unwrap();
    assert!(deleted
        .meetings
        .iter()
        .all(|meeting| meeting.id != meeting_id));
    assert!(fixture
        .runtime
        .update_meeting(
            &meeting_id,
            MeetingUpdatePatch {
                title: Some("late Activity title".into()),
                summary: Some("late Activity summary".into()),
                tags: None,
                ..MeetingUpdatePatch::default()
            },
        )
        .unwrap_err()
        .to_string()
        .contains("being permanently deleted"));
    assert!(!fixture
        .platform
        .state
        .lock()
        .unwrap()
        .contents
        .contains_key(&meeting_id));

    fixture
        .runtime
        .finish_job(
            &running.definition.id,
            running.lease_token.as_deref().unwrap(),
            JobFinish::Succeeded {
                result: json!({
                    "title": "must be discarded",
                    "summary": "must be discarded"
                }),
            },
        )
        .unwrap();
    let job = fixture
        .store
        .list_jobs(&meeting_id)
        .unwrap()
        .into_iter()
        .find(|job| job.definition.id == running.definition.id)
        .unwrap();
    assert_eq!(job.state, JobState::Cancelled);
    assert!(job.result.is_none());
    assert_eq!(
        fixture.store.deletion(&meeting_id).unwrap().unwrap().stage,
        MeetingDeletionStage::FilesPending
    );
    let state = fixture.platform.state.lock().unwrap();
    assert_eq!(
        state.deleted,
        [(meeting_id.clone(), MeetingDeleteMode::All)]
    );
    assert!(state.contents.get(&meeting_id).unwrap().deleted);
}

#[test]
fn capture_start_failure_is_durable_and_never_reported_as_success() {
    let fixture = make_fixture();
    *fixture.capture.fail_start.lock().unwrap() = Some("device busy".into());
    let error = fixture
        .runtime
        .start(start_request(&fixture.runtime, "capture-error"))
        .unwrap_err();
    assert!(error.to_string().contains("device busy"));
    let meetings = fixture.store.list_meetings(10).unwrap();
    assert_eq!(meetings.len(), 1);
    assert_eq!(meetings[0].status, MeetingStatus::Failed);
    assert_eq!(
        meetings[0].failure.as_ref().unwrap().code,
        "capture-start-failed"
    );
    assert!(fixture
        .runtime
        .snapshot()
        .unwrap()
        .active_meeting_id
        .is_none());
}

#[test]
fn capture_worker_starts_only_after_durable_runtime_ownership_exists() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(AuthorityCheckingCapture {
        store: Arc::clone(&store),
        observed_status: Mutex::new(None),
    });
    let runtime = MeetingRuntime::new(
        store,
        capture.clone(),
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();

    runtime
        .start(start_request(&runtime, "durable-before-worker"))
        .unwrap();
    assert_eq!(
        *capture.observed_status.lock().unwrap(),
        Some(MeetingStatus::Recording)
    );
}

#[test]
fn mtg_046_mid_session_capture_failure_is_immediately_durable_and_visible() {
    let fixture = make_fixture();
    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "mid-session-failure"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = fixture.capture.starts.lock().unwrap()[0].run_id.clone();

    fixture.runtime.capture_failed(
        &meeting_id,
        &run_id,
        "disk reserve was exhausted while committing microphone audio",
    );

    let snapshot = fixture.runtime.snapshot().unwrap();
    assert!(snapshot.active_meeting_id.is_none());
    let meeting = snapshot
        .meetings
        .iter()
        .find(|meeting| meeting.id == meeting_id)
        .unwrap();
    assert_eq!(meeting.lifecycle, "failed");
    assert!(meeting.transcript_final);
    assert!(meeting.error.as_deref().unwrap().contains("disk reserve"));
    assert_eq!(
        fixture
            .store
            .get_meeting(&meeting_id)
            .unwrap()
            .failure
            .as_ref()
            .map(|failure| failure.code.as_str()),
        Some("capture-runtime-failed")
    );
    assert_eq!(fixture.capture.stops.lock().unwrap().len(), 1);
    assert!(fixture
        .events
        .published
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.kind == "capture-runtime-failed"));

    // A late callback from a superseded worker cannot damage the already
    // reconciled record.
    fixture
        .runtime
        .capture_failed(&meeting_id, "stale-run", "late device error");
    assert_eq!(
        fixture.store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Failed
    );
}

#[test]
fn capture_failure_is_visible_before_slow_transcription_drain() {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let events = Arc::new(FakeEvents::default());
    let transcription = Arc::new(FailureOrderingTranscription {
        store: Arc::clone(&store),
        events: Arc::clone(&events),
        observed_interrupted_before_finalize: Mutex::new(false),
    });
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        Arc::new(FakeCapture::default()),
        transcription.clone(),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        events,
    )
    .unwrap();
    let started = runtime
        .start(start_request(&runtime, "visible-before-drain"))
        .unwrap();
    let meeting_id = started.active_meeting_id.unwrap();
    let run_id = runtime.active().unwrap().as_ref().unwrap().run_id.clone();

    runtime.capture_failed(
        &meeting_id,
        &run_id,
        "disk reserve was exhausted while persisting audio",
    );

    assert!(*transcription
        .observed_interrupted_before_finalize
        .lock()
        .unwrap());
    assert_eq!(
        store.get_meeting(&meeting_id).unwrap().status,
        MeetingStatus::Failed
    );
}

#[test]
fn native_capture_failure_sink_does_not_keep_runtime_alive() {
    let runtime = MeetingRuntime::new(
        Arc::new(MeetingStore::open_in_memory().unwrap()),
        Arc::new(FakeCapture::default()),
        Arc::new(FakeTranscription::default()),
        Arc::new(FakePlatform::default()),
        Arc::new(FakeClock),
        Arc::new(FakeEvents::default()),
    )
    .unwrap();
    let weak_inner = Arc::downgrade(&runtime.inner);
    let sink = runtime.capture_failure_sink();

    drop(runtime);

    assert!(weak_inner.upgrade().is_none());
    sink.capture_failed("ended-meeting", "ended-run", "late worker completion");
}
