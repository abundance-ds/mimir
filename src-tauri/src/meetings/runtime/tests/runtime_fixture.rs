struct FakePlatformState {
    projection: MeetingPlatformProjection,
    contents: BTreeMap<String, MeetingContentProjection>,
    exports: Vec<(String, MeetingExportFormat)>,
    deleted: Vec<(String, MeetingDeleteMode)>,
    fail_export: Option<String>,
    fail_model_install: Option<String>,
    dismissed_candidates: Vec<String>,
}

struct FakePlatform {
    state: Mutex<FakePlatformState>,
}

impl Default for FakePlatform {
    fn default() -> Self {
        Self {
            state: Mutex::new(FakePlatformState {
                projection: MeetingPlatformProjection {
                    config: MeetingConfig::default(),
                    permissions: MeetingPermissions {
                        microphone: "granted".into(),
                        system_audio: "granted".into(),
                    },
                    candidates: Vec::new(),
                    models: Vec::new(),
                    diagnostic: None,
                },
                contents: BTreeMap::new(),
                exports: Vec::new(),
                deleted: Vec::new(),
                fail_export: None,
                fail_model_install: None,
                dismissed_candidates: Vec::new(),
            }),
        }
    }
}

impl MeetingPlatformPort for FakePlatform {
    fn projection(&self) -> Result<MeetingPlatformProjection, String> {
        Ok(self.state.lock().unwrap().projection.clone())
    }

    fn dismiss_candidate(&self, candidate_id: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .dismissed_candidates
            .push(candidate_id.into());
        Ok(())
    }

    fn content(&self, meeting_id: &str) -> Result<MeetingContentProjection, String> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .contents
            .get(meeting_id)
            .cloned()
            .unwrap_or_default())
    }

    fn update_config(&self, patch: &MeetingConfigPatch) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let config = &mut state.projection.config;
        if let Some(value) = patch.detection_enabled {
            config.detection_enabled = value;
        }
        if let Some(value) = patch.auto_record {
            config.auto_record = value;
        }
        if let Some(value) = &patch.transcription_mode {
            config.transcription_mode = value.clone();
        }
        if let Some(value) = &patch.custom_url {
            config.custom_url = value.clone();
        }
        if let Some(value) = &patch.custom_model {
            config.custom_model = value.clone();
        }
        if let Some(value) = &patch.local_model {
            config.local_model = value.clone();
        }
        if let Some(value) = patch.summary_enabled {
            config.summary_enabled = value;
        }
        if let Some(value) = &patch.summary_template {
            config.summary_template = value.clone();
        }
        if let Some(value) = &patch.summary_prompt {
            config.summary_prompt = value.clone();
        }
        if let Some(value) = &patch.summary_preset {
            config.summary_preset = value.clone();
        }
        if let Some(value) = &patch.kg_prompt {
            config.kg_prompt = value.clone();
        }
        if let Some(value) = &patch.kg_preset {
            config.kg_preset = value.clone();
        }
        if let Some(value) = patch.retention_days {
            config.retention_days = value;
        }
        Ok(())
    }

    fn set_api_key(&self, _api_key: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .config
            .api_key_configured = true;
        Ok(())
    }

    fn clear_api_key(&self) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .config
            .api_key_configured = false;
        Ok(())
    }

    fn install_model(&self, model_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.fail_model_install.clone() {
            return Err(error);
        }
        state.projection.models.push(MeetingModel {
            id: model_id.into(),
            title: model_id.into(),
            status: "installed".into(),
            bytes: 1,
            downloaded_bytes: 1,
            checksum: Some("verified".into()),
            error: None,
        });
        Ok(())
    }

    fn delete_model(&self, model_id: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .projection
            .models
            .retain(|model| model.id != model_id);
        Ok(())
    }

    fn update_content(&self, meeting_id: &str, patch: &MeetingUpdatePatch) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let content = state.contents.entry(meeting_id.into()).or_default();
        if let Some(value) = &patch.title {
            content.title = Some(value.clone());
        } else if let Some(value) = &patch.generated_title {
            content.title = Some(value.clone());
        }
        if let Some(value) = &patch.summary {
            content.summary = Some(value.clone());
        }
        if let Some(value) = &patch.notes {
            content.notes = value.clone();
        }
        if let Some(value) = &patch.tags {
            content.tags = value.clone();
        }
        if let Some(value) = &patch.graph_node_id {
            content.graph_node_id = Some(value.clone());
        }
        if let Some(value) = &patch.graph_draft {
            content.graph_draft = value.clone();
        }
        Ok(())
    }

    fn set_kg_decision(&self, meeting_id: &str, decision: &str) -> Result<(), String> {
        self.state
            .lock()
            .unwrap()
            .contents
            .entry(meeting_id.into())
            .or_default()
            .kg_decision = Some(decision.into());
        Ok(())
    }

    fn delete_meeting(&self, meeting_id: &str, mode: MeetingDeleteMode) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        state.deleted.push((meeting_id.into(), mode));
        if mode == MeetingDeleteMode::All {
            state.contents.entry(meeting_id.into()).or_default().deleted = true;
        }
        Ok(())
    }

    fn export_meeting(
        &self,
        meeting_id: &str,
        format: MeetingExportFormat,
    ) -> Result<MeetingExport, String> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.fail_export.clone() {
            return Err(error);
        }
        state.exports.push((meeting_id.into(), format));
        Ok(MeetingExport {
            format: match format {
                MeetingExportFormat::Markdown => "markdown",
                MeetingExportFormat::Json => "json",
                MeetingExportFormat::Audio => "audio",
                MeetingExportFormat::Files => "files",
            }
            .into(),
            path: format!("/tmp/{meeting_id}.export"),
        })
    }
}

#[derive(Default)]
struct FakeEvents {
    published: Mutex<Vec<MeetingEvent>>,
}

impl MeetingEventSink for FakeEvents {
    fn publish(&self, event: &MeetingEvent) -> Result<(), String> {
        self.published.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct FakeClock;

impl MeetingClock for FakeClock {
    fn now(&self) -> String {
        NOW.into()
    }
}

struct Fixture {
    runtime: MeetingRuntime,
    store: Arc<MeetingStore>,
    capture: Arc<FakeCapture>,
    transcription: Arc<FakeTranscription>,
    platform: Arc<FakePlatform>,
    events: Arc<FakeEvents>,
}

fn make_fixture() -> Fixture {
    let store = Arc::new(MeetingStore::open_in_memory().unwrap());
    let capture = Arc::new(FakeCapture::default());
    let transcription = Arc::new(FakeTranscription::default());
    let platform = Arc::new(FakePlatform::default());
    let events = Arc::new(FakeEvents::default());
    let runtime = MeetingRuntime::new(
        Arc::clone(&store),
        capture.clone(),
        transcription.clone(),
        platform.clone(),
        Arc::new(FakeClock),
        events.clone(),
    )
    .unwrap();
    Fixture {
        runtime,
        store,
        capture,
        transcription,
        platform,
        events,
    }
}

fn start_request(runtime: &MeetingRuntime, request_id: &str) -> StartMeetingRequest {
    start_request_for_candidate(runtime, request_id, None)
}

fn start_request_for_candidate(
    runtime: &MeetingRuntime,
    request_id: &str,
    candidate_id: Option<&str>,
) -> StartMeetingRequest {
    StartMeetingRequest {
        request_id: Some(request_id.into()),
        title: Some("Release review".into()),
        workspace_path: Some("/workspace".into()),
        candidate_id: candidate_id.map(str::to_string),
        continue_meeting_id: None,
        consent_token: None,
        authorized_consent: Some(runtime.start_consent_context(candidate_id).unwrap()),
    }
}

