#[test]
fn prepared_meeting_keeps_one_identity_and_notes_when_recording_starts() {
    let fixture = make_fixture();
    let prepared = fixture
        .runtime
        .prepare(PrepareMeetingRequest {
            title: Some("Client planning".into()),
            workspace_path: Some("/workspace".into()),
        })
        .unwrap();
    let meeting = prepared.meetings.first().unwrap();
    assert_eq!(meeting.lifecycle, "arming");
    let meeting_id = meeting.id.clone();

    fixture
        .runtime
        .update_meeting(
            &meeting_id,
            MeetingUpdatePatch {
                notes: Some("Ask about delivery.\nOpening words.".into()),
                ..MeetingUpdatePatch::default()
            },
        )
        .unwrap();
    let consent = fixture
        .runtime
        .start_consent_context_for(None, Some(&meeting_id))
        .unwrap();
    let started = fixture
        .runtime
        .start(StartMeetingRequest {
            request_id: Some("prepared-start".into()),
            title: None,
            workspace_path: Some("/workspace".into()),
            candidate_id: None,
            continue_meeting_id: Some(meeting_id.clone()),
            consent_token: None,
            authorized_consent: Some(consent),
        })
        .unwrap();

    assert_eq!(
        started.active_meeting_id.as_deref(),
        Some(meeting_id.as_str())
    );
    assert_eq!(started.meetings[0].lifecycle, "capturing");
    assert_eq!(
        started.meetings[0].notes,
        "Ask about delivery.\nOpening words."
    );
    assert_eq!(
        fixture.capture.starts.lock().unwrap()[0].meeting_id,
        meeting_id
    );
}

#[test]
fn explicit_consent_single_active_and_idempotent_controls() {
    let fixture = make_fixture();
    let forged: StartMeetingRequest = serde_json::from_value(json!({
        "requestId": "forged",
        "consentToken": "renderer-controlled",
        "authorizedConsent": {
            "transcriptionMode": "local",
            "model": "whisper-small"
        }
    }))
    .unwrap();
    assert!(forged.authorized_consent.is_none());
    assert!(matches!(
        fixture.runtime.start(forged).unwrap_err(),
        MeetingRuntimeError::ConsentRequired
    ));

    let error = fixture
        .runtime
        .start(StartMeetingRequest {
            authorized_consent: None,
            ..start_request(&fixture.runtime, "without-consent")
        })
        .unwrap_err();
    assert!(matches!(error, MeetingRuntimeError::ConsentRequired));
    assert!(fixture.capture.starts.lock().unwrap().is_empty());

    let context_fixture = make_fixture();
    let authorized = start_request(&context_fixture.runtime, "changed-context");
    context_fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .config
        .local_model = "whisper-medium".into();
    assert!(matches!(
        context_fixture.runtime.start(authorized).unwrap_err(),
        MeetingRuntimeError::ConsentContextChanged
    ));
    assert!(context_fixture.capture.starts.lock().unwrap().is_empty());

    fixture
        .platform
        .state
        .lock()
        .unwrap()
        .projection
        .config
        .microphone_device_id = Some("CoreAudio:stable-selected-mic".into());
    let first = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-1"))
        .unwrap();
    let meeting_id = first.active_meeting_id.clone().unwrap();
    let durable = fixture.store.get_meeting(&meeting_id).unwrap();
    assert_eq!(durable.metadata["transcriptionRoute"], "local");
    assert_eq!(durable.metadata["transcriptionModel"], "whisper-small");
    assert_eq!(
        durable.metadata["microphoneDeviceId"],
        "CoreAudio:stable-selected-mic"
    );
    assert_eq!(
        fixture.capture.starts.lock().unwrap()[0]
            .microphone_device_id
            .as_deref(),
        Some("CoreAudio:stable-selected-mic")
    );
    assert_eq!(
        fixture.transcription.starts.lock().unwrap()[0].route,
        "local"
    );
    let duplicate = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-1"))
        .unwrap();
    assert_eq!(
        duplicate.active_meeting_id.as_deref(),
        Some(meeting_id.as_str())
    );
    assert_eq!(fixture.capture.starts.lock().unwrap().len(), 1);

    let error = fixture
        .runtime
        .start(start_request(&fixture.runtime, "request-2"))
        .unwrap_err();
    assert!(matches!(error, MeetingRuntimeError::ActiveMeeting { .. }));

    let muted = fixture
        .runtime
        .set_microphone_muted(&meeting_id, true)
        .unwrap();
    let duplicate_mute = fixture
        .runtime
        .set_microphone_muted(&meeting_id, true)
        .unwrap();
    assert!(muted.meetings[0].mic_muted);
    assert_eq!(duplicate_mute.revision, muted.revision);
    assert_eq!(fixture.capture.mute_changes.lock().unwrap().len(), 1);

    // The current renderer does not supply requestId, so an identical
    // service request still has to be idempotent.
    let service_fixture = make_fixture();
    let service_request = StartMeetingRequest {
        request_id: None,
        ..start_request(&service_fixture.runtime, "ignored")
    };
    let first = service_fixture
        .runtime
        .start(service_request.clone())
        .unwrap();
    let duplicate = service_fixture.runtime.start(service_request).unwrap();
    assert_eq!(duplicate.active_meeting_id, first.active_meeting_id);
    assert_eq!(service_fixture.capture.starts.lock().unwrap().len(), 1);
}

#[test]
fn detected_start_rejects_stale_candidates_and_suppresses_the_accepted_prompt() {
    let fixture = make_fixture();
    fixture.platform.state.lock().unwrap().projection.candidates = vec![MeetingCandidate {
        id: "candidate-zoom".into(),
        app_id: "us.zoom.xos".into(),
        app_name: "Zoom".into(),
        detected_at: None,
        confidence: 0.95,
    }];

    let stale = fixture
        .runtime
        .start(StartMeetingRequest {
            candidate_id: Some("missing".into()),
            ..start_request(&fixture.runtime, "stale-candidate")
        })
        .unwrap_err();
    assert!(stale.to_string().contains("no longer available"));

    let started = fixture
        .runtime
        .start(start_request_for_candidate(
            &fixture.runtime,
            "accepted-candidate",
            Some("candidate-zoom"),
        ))
        .unwrap();
    assert!(started.candidates.is_empty());
    assert_eq!(
        fixture
            .platform
            .state
            .lock()
            .unwrap()
            .dismissed_candidates
            .clone(),
        vec!["candidate-zoom"]
    );
}

#[test]
fn listener_is_installed_before_snapshot_and_event_revisions_are_monotonic() {
    let fixture = make_fixture();
    let base = fixture.runtime.snapshot().unwrap();
    assert_eq!(base.revision, 0);

    let started = fixture
        .runtime
        .start(start_request(&fixture.runtime, "ordered"))
        .unwrap();
    let events = fixture.events.published.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].revision > base.revision);
    assert_eq!(events[0].revision, started.revision);
    assert!(events[0].snapshot.is_none());
    assert!(
        serde_json::to_vec(&events[0]).unwrap().len() < 512,
        "meeting invalidation event exceeded its 512-byte payload budget"
    );
    drop(events);

    let reconciled = fixture.runtime.snapshot().unwrap();
    assert_eq!(reconciled.revision, started.revision);
    assert_eq!(reconciled.active_meeting_id, started.active_meeting_id);
}

#[test]
fn library_and_summary_projections_have_explicit_payload_budgets() {
    let fixture = make_fixture();
    for index in 0..=DEFAULT_MEETING_LIMIT {
        fixture
            .store
            .create_meeting(
                &MeetingDraft {
                    id: format!("scale-{index:03}"),
                    title: format!("Meeting {index}"),
                    origin: MeetingOrigin::default(),
                    channels: Vec::new(),
                    metadata: json!({}),
                },
                NOW,
            )
            .unwrap();
    }
    fixture
        .platform
        .state
        .lock()
        .unwrap()
        .contents
        .entry("scale-200".into())
        .or_default()
        .summary = Some("s".repeat(100_000));

    let snapshot = fixture.runtime.snapshot().unwrap();
    assert_eq!(snapshot.meetings.len(), DEFAULT_MEETING_LIMIT as usize);
    assert!(snapshot.meetings_truncated);
    let meeting = snapshot
        .meetings
        .iter()
        .find(|meeting| meeting.id == "scale-200")
        .unwrap();
    assert_eq!(
        meeting.summary.as_deref().unwrap().chars().count(),
        MAX_SUMMARY_PREVIEW_CHARS
    );
    assert!(meeting.summary_truncated);
    assert!(
        serde_json::to_vec(&snapshot).unwrap().len() < 256 * 1024,
        "200-row meeting library exceeded its 256 KiB payload budget"
    );

    let detail = fixture
        .runtime
        .transcript_page("scale-200", None, None)
        .unwrap();
    assert_eq!(detail.summary.unwrap().len(), 100_000);
}

