use super::*;

pub(super) struct ModelManager {
    paths: MeetingPlatformPaths,
    catalog: BTreeMap<String, MeetingModelCatalogEntry>,
    disk: Arc<dyn MeetingDiskSpaceProbe>,
    downloader: Arc<dyn ModelArtifactDownloader>,
    changes: Arc<dyn MeetingPlatformChangeSink>,
    operation: Mutex<()>,
    active: Mutex<HashSet<String>>,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

impl ModelManager {
    pub(super) fn new(
        paths: MeetingPlatformPaths,
        catalog: Vec<MeetingModelCatalogEntry>,
        disk: Arc<dyn MeetingDiskSpaceProbe>,
        downloader: Arc<dyn ModelArtifactDownloader>,
        changes: Arc<dyn MeetingPlatformChangeSink>,
        diagnostics: Arc<Mutex<Vec<String>>>,
    ) -> Result<Arc<Self>, String> {
        ensure_private_directory(&paths.models_root)
            .map_err(|error| format!("Could not secure managed model directory: {error}"))?;
        let mut indexed = BTreeMap::new();
        for entry in catalog {
            entry
                .manifest
                .validate()
                .map_err(|error| format!("Invalid managed model manifest: {error}"))?;
            let id = entry.manifest.model_id.as_str().to_string();
            if indexed.insert(id.clone(), entry).is_some() {
                return Err(format!("Duplicate managed model manifest '{id}'"));
            }
        }
        let manager = Arc::new(Self {
            paths,
            catalog: indexed,
            disk,
            downloader,
            changes,
            operation: Mutex::new(()),
            active: Mutex::new(HashSet::new()),
            diagnostics,
        });
        manager.recover_interrupted_installs()?;
        Ok(manager)
    }

    fn recover_interrupted_installs(&self) -> Result<(), String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let mut changed = false;
        for (model_id, entry) in &self.catalog {
            if let Ok(directory) = self.model_version_dir(&entry.manifest) {
                collect_model_partials(&directory);
            }
            let Some(model) = state.models.get_mut(model_id) else {
                continue;
            };
            if !matches!(
                model,
                ModelDownloadState::Downloading { .. } | ModelDownloadState::Verifying { .. }
            ) {
                continue;
            }
            let recovered = RuntimePlatform::current()
                .filter(|runtime| runtime == &entry.manifest.platform)
                .and_then(|runtime| {
                    let path = self.model_artifact_path(&entry.manifest).ok()?;
                    reject_symlink(&path).ok()?;
                    let mut artifact = File::open(path).ok()?;
                    let bytes = artifact.metadata().ok()?.len();
                    let digest = Sha256Digest::calculate(&mut artifact).ok()?;
                    let mut ready = ModelDownloadState::Verifying {
                        artifact_bytes: bytes,
                    };
                    ready
                        .finish_verification(&entry.manifest, runtime, bytes, digest)
                        .ok()?;
                    Some(ready)
                });
            *model = recovered.unwrap_or(ModelDownloadState::Invalid {
                reason: ModelInvalidReason::Incomplete,
            });
            changed = true;
        }
        if changed {
            self.save_state(&state)?;
        }
        Ok(())
    }

    pub(super) fn projection(&self) -> Result<Vec<MeetingModel>, String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let mut changed = false;
        let models = self
            .catalog
            .iter()
            .map(|(id, entry)| {
                let installation = state.models.entry(id.clone()).or_default();
                let before = installation.clone();
                installation.invalidate_if_manifest_changed(&entry.manifest);
                if matches!(installation, ModelDownloadState::Ready { .. }) {
                    let artifact_valid = self
                        .model_artifact_path(&entry.manifest)
                        .ok()
                        .and_then(|path| fs::metadata(path).ok())
                        .is_some_and(|metadata| {
                            metadata.is_file() && metadata.len() == entry.manifest.artifact_bytes
                        });
                    if !artifact_valid {
                        *installation = ModelDownloadState::Invalid {
                            reason: ModelInvalidReason::Unreadable,
                        };
                    }
                }
                changed |= *installation != before;
                model_projection(id, entry, installation.clone())
            })
            .collect();
        if changed {
            self.save_state(&state)?;
        }
        Ok(models)
    }

    pub(super) fn install(self: &Arc<Self>, model_id: &str) -> Result<(), String> {
        validate_component(model_id, "model id")?;
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        ensure_private_directory(&self.paths.models_root)
            .map_err(|error| format!("Could not secure managed model directory: {error}"))?;
        {
            let mut active = lock(&self.active)?;
            if !active.insert(model_id.to_string()) {
                return Ok(());
            }
        }
        let already_ready = (|| {
            let _operation = lock(&self.operation)?;
            let mut state = self.load_state()?;
            self.verified_ready(&entry.manifest, state.models.get_mut(model_id))
        })();
        let already_ready = match already_ready {
            Ok(value) => value,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(error);
            }
        };
        if already_ready {
            lock(&self.active)?.remove(model_id);
            return Ok(());
        }
        let free = match self.disk.available_bytes(&self.paths.models_root) {
            Ok(free) => free,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(error);
            }
        };
        let initial = match ModelDownloadState::begin(&entry.manifest, runtime, free) {
            Ok(state) => state,
            Err(error) => {
                lock(&self.active)?.remove(model_id);
                return Err(format!(
                    "Cannot install managed model '{model_id}': {error}"
                ));
            }
        };
        let prepare_result = (|| {
            let _operation = lock(&self.operation)?;
            let mut state = self.load_state()?;
            state.models.insert(model_id.into(), initial);
            self.save_state(&state)
        })();
        if let Err(error) = prepare_result {
            lock(&self.active)?.remove(model_id);
            return Err(error);
        }

        let manager = self.clone();
        let model_id = model_id.to_string();
        let worker_model_id = model_id.clone();
        let spawn = thread::Builder::new()
            .name(format!("scribe-model-{model_id}"))
            .spawn(move || {
                if let Err(error) = manager.perform_install(&worker_model_id) {
                    manager.record_install_failure(&worker_model_id, &error);
                }
                if let Ok(mut active) = manager.active.lock() {
                    active.remove(&worker_model_id);
                }
                manager.changes.changed("model");
            });
        if let Err(error) = spawn {
            lock(&self.active)?.remove(&model_id);
            let message = format!("Could not start managed model download: {error}");
            self.record_install_failure(&model_id, &message);
            return Err(message);
        }
        self.changes.changed("model");
        Ok(())
    }

    fn perform_install(&self, model_id: &str) -> Result<(), String> {
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' disappeared from the catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        let model_dir = self.model_version_dir(&entry.manifest)?;
        let final_path = model_dir.join("model.bin");
        let pending_path = model_dir.join(format!(".model-{}.part", Uuid::new_v4()));
        let mut pending_guard = PendingPath::file(pending_path.clone());
        let mut pending = create_private_new_file(&pending_path)?;
        let mut download_state = ModelDownloadState::begin(
            &entry.manifest,
            runtime,
            self.disk.available_bytes(&self.paths.models_root)?,
        )
        .map_err(|error| error.to_string())?;
        let mut checkpoint = 0_u64;
        let download = self
            .downloader
            .download(&entry.manifest, &mut pending, &mut |additional| {
                download_state
                    .record_downloaded(additional)
                    .map_err(|error| error.to_string())?;
                let received = match download_state {
                    ModelDownloadState::Downloading { received_bytes, .. } => received_bytes,
                    _ => 0,
                };
                if received.saturating_sub(checkpoint) >= MODEL_PROGRESS_CHECKPOINT_BYTES {
                    self.persist_model_state(model_id, download_state.clone())?;
                    checkpoint = received;
                    self.changes.changed("model");
                }
                Ok(())
            });
        if let Err(error) = download {
            drop(pending);
            return Err(error);
        }
        pending
            .flush()
            .and_then(|_| pending.sync_all())
            .map_err(|error| format!("Could not durably flush the managed model: {error}"))?;
        drop(pending);

        download_state
            .begin_verification()
            .map_err(|error| error.to_string())?;
        self.persist_model_state(model_id, download_state.clone())?;
        let mut artifact = File::open(&pending_path)
            .map_err(|error| format!("Could not reopen managed model for verification: {error}"))?;
        let metadata = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model: {error}"))?;
        let digest = Sha256Digest::calculate(&mut artifact)
            .map_err(|error| format!("Could not verify managed model checksum: {error}"))?;
        download_state
            .finish_verification(&entry.manifest, runtime, metadata.len(), digest)
            .map_err(|error| format!("Managed model verification failed: {error}"))?;

        repair_private_file_if_exists(&final_path)
            .map_err(|error| format!("Could not secure managed model destination: {error}"))?;
        fs::rename(&pending_path, &final_path)
            .map_err(|error| format!("Could not atomically install the managed model: {error}"))?;
        pending_guard.disarm();
        repair_private_file(&final_path)
            .map_err(|error| format!("Could not secure installed model: {error}"))?;
        sync_directory(&model_dir)?;
        self.persist_model_state(model_id, download_state)?;
        Ok(())
    }

    fn verified_ready(
        &self,
        manifest: &ModelManifest,
        state: Option<&mut ModelDownloadState>,
    ) -> Result<bool, String> {
        let Some(state) = state else {
            return Ok(false);
        };
        let Some(runtime) = RuntimePlatform::current() else {
            return Ok(false);
        };
        if !state.selectable_for(manifest, runtime) {
            return Ok(false);
        }
        let path = self.model_artifact_path(manifest)?;
        let mut artifact = match File::open(&path) {
            Ok(file) => file,
            Err(_) => {
                *state = ModelDownloadState::Invalid {
                    reason: ModelInvalidReason::Unreadable,
                };
                return Ok(false);
            }
        };
        let bytes = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model: {error}"))?
            .len();
        match state.verify_for_use(manifest, runtime, bytes, &mut artifact) {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    pub(super) fn delete(&self, model_id: &str) -> Result<(), String> {
        validate_component(model_id, "model id")?;
        if lock(&self.active)?.contains(model_id) {
            return Err(format!(
                "Managed model '{model_id}' is still downloading; wait for it to finish before deleting it"
            ));
        }
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let _operation = lock(&self.operation)?;
        let model_root = safe_direct_child(&self.paths.models_root, model_id)?;
        if model_root.exists() {
            reject_symlink(&model_root)?;
            fs::remove_dir_all(&model_root)
                .map_err(|error| format!("Could not delete managed model '{model_id}': {error}"))?;
            sync_directory(&self.paths.models_root)?;
        }
        let mut state = self.load_state()?;
        state.models.remove(entry.manifest.model_id.as_str());
        self.save_state(&state)?;
        self.changes.changed("model");
        Ok(())
    }

    pub(super) fn artifact_for_use(&self, model_id: &str) -> Result<PathBuf, String> {
        validate_component(model_id, "model id")?;
        let entry = self
            .catalog
            .get(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not in Mimir's model catalog"))?;
        let runtime = RuntimePlatform::current().ok_or_else(|| {
            "Managed local transcription models are supported only on macOS arm64".to_string()
        })?;
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        let installation = state
            .models
            .get_mut(model_id)
            .ok_or_else(|| format!("Managed model '{model_id}' is not installed"))?;
        let path = self.model_artifact_path(&entry.manifest)?;
        reject_symlink(&path)?;
        let mut artifact = File::open(&path)
            .map_err(|error| format!("Could not open managed model '{model_id}': {error}"))?;
        let bytes = artifact
            .metadata()
            .map_err(|error| format!("Could not inspect managed model '{model_id}': {error}"))?
            .len();
        if let Err(error) =
            installation.verify_for_use(&entry.manifest, runtime, bytes, &mut artifact)
        {
            self.save_state(&state)?;
            return Err(format!(
                "Managed model '{model_id}' failed its pre-launch integrity check: {error}"
            ));
        }
        Ok(path)
    }

    fn model_version_dir(&self, manifest: &ModelManifest) -> Result<PathBuf, String> {
        let relative = PathBuf::from(manifest.model_id.as_str()).join(manifest.version.as_str());
        ensure_private_subdirectory(&self.paths.models_root, relative)
            .map_err(|error| format!("Could not secure managed model version directory: {error}"))
    }

    fn model_artifact_path(&self, manifest: &ModelManifest) -> Result<PathBuf, String> {
        let relative = PathBuf::from(manifest.model_id.as_str())
            .join(manifest.version.as_str())
            .join("model.bin");
        prepare_private_file_path(&self.paths.models_root, relative)
            .map_err(|error| format!("Could not resolve managed model artifact: {error}"))
    }

    fn persist_model_state(
        &self,
        model_id: &str,
        model_state: ModelDownloadState,
    ) -> Result<(), String> {
        let _operation = lock(&self.operation)?;
        let mut state = self.load_state()?;
        state.models.insert(model_id.into(), model_state);
        self.save_state(&state)
    }

    fn load_state(&self) -> Result<PersistedModelState, String> {
        repair_private_file_if_exists(&self.paths.model_state_file)
            .map_err(|error| format!("Could not secure managed model state: {error}"))?;
        let outcome =
            load_json_optional_quarantining::<PersistedModelState>(&self.paths.model_state_file)
                .map_err(|error| error.to_string())?;
        match outcome {
            QuarantinedLoad::Missing => Ok(PersistedModelState::default()),
            QuarantinedLoad::Loaded(state)
                if state.schema_version == MODEL_STATE_SCHEMA_VERSION =>
            {
                Ok(state)
            }
            QuarantinedLoad::Loaded(_) => Err("Unsupported managed model state schema".into()),
            QuarantinedLoad::Quarantined { path, reason } => {
                push_diagnostic(
                    &self.diagnostics,
                    format!(
                        "Invalid managed model state was moved to {}: {reason}",
                        path.display()
                    ),
                );
                Ok(PersistedModelState::default())
            }
        }
    }

    fn save_state(&self, state: &PersistedModelState) -> Result<(), String> {
        write_private_json_atomic(&self.paths.model_state_file, state)
            .map_err(|error| error.to_string())
    }

    pub(super) fn record_install_failure(&self, model_id: &str, error: &str) {
        let state = classify_model_failure(error);
        let summary = model_failure_summary(&state);
        if self.persist_model_state(model_id, state).is_err() {
            push_diagnostic(
                &self.diagnostics,
                format!(
                    "Managed model '{model_id}' failed: {summary}; its failure state could not be saved"
                ),
            );
        } else {
            push_diagnostic(
                &self.diagnostics,
                format!("Managed model '{model_id}' failed: {summary}"),
            );
        }
    }
}

fn classify_model_failure(error: &str) -> ModelDownloadState {
    let lowercase = error.to_ascii_lowercase();
    let reason = if lowercase.contains("checksum") {
        ModelInvalidReason::ChecksumMismatch
    } else if lowercase.contains("size") || lowercase.contains("byte") {
        ModelInvalidReason::SizeMismatch
    } else if lowercase.contains("platform") {
        ModelInvalidReason::PlatformMismatch
    } else {
        ModelInvalidReason::Incomplete
    };
    ModelDownloadState::Invalid { reason }
}

fn model_failure_summary(state: &ModelDownloadState) -> &'static str {
    match state {
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::SizeMismatch,
        } => "artifact size verification failed",
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::ChecksumMismatch,
        } => "artifact checksum verification failed",
        ModelDownloadState::Invalid {
            reason: ModelInvalidReason::PlatformMismatch,
        } => "platform verification failed",
        ModelDownloadState::Invalid { .. } => "download did not complete",
        _ => "installation did not complete",
    }
}

fn model_projection(
    id: &str,
    entry: &MeetingModelCatalogEntry,
    state: ModelDownloadState,
) -> MeetingModel {
    let (status, downloaded_bytes, checksum, error) = match state {
        ModelDownloadState::Missing => ("available", 0, None, None),
        ModelDownloadState::Downloading { received_bytes, .. } => {
            ("downloading", received_bytes, None, None)
        }
        ModelDownloadState::Verifying { artifact_bytes } => {
            ("verifying", artifact_bytes, None, None)
        }
        ModelDownloadState::Ready {
            artifact_bytes,
            sha256,
            ..
        } => ("installed", artifact_bytes, Some(sha256.to_string()), None),
        ModelDownloadState::Invalid { reason } => (
            "error",
            0,
            None,
            Some(format!("Managed model is invalid: {reason:?}")),
        ),
    };
    MeetingModel {
        id: id.into(),
        title: entry.title.clone(),
        status: status.into(),
        bytes: entry.manifest.artifact_bytes,
        downloaded_bytes,
        checksum,
        error,
    }
}
