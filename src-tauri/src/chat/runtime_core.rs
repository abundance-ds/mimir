use super::*;

impl ChatRuntime {
    pub fn new() -> Result<Self, String> {
        let config_directory = app_config_dir()?;
        fs::create_dir_all(&config_directory).map_err(|error| error.to_string())?;
        let config_path = config_directory.join("chat.json");
        let config = read_config_at(&config_path)?.unwrap_or_default();
        let database = ChatDatabase::open(config_directory.join("chat.sqlite3"))?;
        Ok(Self {
            inner: Arc::new(ChatInner {
                config_path,
                credential_path: config_directory.join("chat.credential"),
                database,
                status: RwLock::new(ChatStatus::new(
                    &config,
                    ChatConnectionState::NeedsCredentials,
                )),
                app: Mutex::new(None),
                outbound: Mutex::new(None),
                generation: AtomicU64::new(0),
                active_target: RwLock::new(None),
            }),
        })
    }

    pub fn install(&self, app: &tauri::AppHandle, registry: &ToolRegistry) -> Result<(), String> {
        log::info!("Installing native team chat runtime");
        *lock(&self.inner.app) = Some(app.clone());
        reserve_native_tool_names(registry)?;
        if self.config()?.enabled {
            register_native_tools(registry, self)?;
        }
        self.start_configured()
    }

    pub fn status(&self) -> ChatStatus {
        read_lock(&self.inner.status).clone()
    }

    pub fn config(&self) -> Result<ChatConfig, String> {
        Ok(read_config_at(&self.inner.config_path)?.unwrap_or_default())
    }

    pub fn configure(&self, config: ChatConfig, password: &str) -> Result<ChatStatus, String> {
        validate_config(&config)?;
        if password.trim().is_empty() {
            return Err("Chat passphrase is required.".into());
        }
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        store_credential(&self.inner.credential_path, &config, password)?;
        self.connect(config, password.to_string());
        Ok(self.status())
    }

    pub fn update_config(
        &self,
        config: ChatConfig,
        replacement_password: Option<&str>,
    ) -> Result<ChatStatus, String> {
        validate_config(&config)?;
        let current = self.config()?;
        let password = match replacement_password
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(password) => password.to_string(),
            None if credential_key(&current) == credential_key(&config) => {
                load_credential(&self.inner.credential_path, &current)?
                    .ok_or_else(|| "No saved chat passphrase was found.".to_string())?
            }
            None => {
                return Err("Enter the passphrase when changing the chat server or account.".into())
            }
        };
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        if replacement_password.is_some_and(|value| !value.trim().is_empty()) {
            store_credential(&self.inner.credential_path, &config, &password)?;
        }
        self.connect(config, password);
        Ok(self.status())
    }

    pub fn start_configured(&self) -> Result<(), String> {
        let config = read_config_at(&self.inner.config_path)?.unwrap_or_default();
        if !config.enabled {
            self.update_status(ChatStatus::new(&config, ChatConnectionState::Disconnected));
            return Ok(());
        }
        #[cfg(debug_assertions)]
        if let Ok(password) = std::env::var("MIMIR_CHAT_PASSWORD") {
            if !password.is_empty() {
                if std::env::var_os("MIMIR_CHAT_PERSIST_PASSWORD").is_some() {
                    store_credential(&self.inner.credential_path, &config, &password)?;
                }
                log::info!("Starting chat with the development credential override");
                self.connect(config, password);
                return Ok(());
            }
        }
        match load_credential(&self.inner.credential_path, &config) {
            Ok(Some(password)) if !password.is_empty() => {
                self.connect(config, password);
                Ok(())
            }
            Ok(_) => {
                self.update_status(ChatStatus::new(
                    &config,
                    ChatConnectionState::NeedsCredentials,
                ));
                Ok(())
            }
            Err(error) => {
                let mut status = ChatStatus::new(&config, ChatConnectionState::NeedsCredentials);
                status.diagnostic = Some(format!("Could not read the chat credential: {error}"));
                self.update_status(status);
                Ok(())
            }
        }
    }

    pub fn disconnect(&self) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(sender) = lock(&self.inner.outbound).take() {
            let _ = sender.send(ChatOutbound::Shutdown);
        }
        let config = self.config().unwrap_or_default();
        self.update_status(ChatStatus::new(&config, ChatConnectionState::Disconnected));
    }

    pub fn set_enabled(
        &self,
        enabled: bool,
        registry: &ToolRegistry,
    ) -> Result<ChatStatus, String> {
        let mut config = self.config()?;
        if config.enabled == enabled {
            return Ok(self.status());
        }
        config.enabled = enabled;
        write_json_atomic(&self.inner.config_path, &config).map_err(|error| error.to_string())?;
        if enabled {
            register_native_tools(registry, self)?;
            self.start_configured()?;
        } else {
            self.disconnect();
            *write_lock(&self.inner.active_target) = None;
            for name in [
                "chat.rooms",
                "chat.read",
                "chat.search",
                "chat.send",
                "chat.download",
            ] {
                let _ = registry.unregister(name, &ToolOwner::Core);
            }
        }
        Ok(self.status())
    }

    pub fn targets(&self) -> Result<Vec<ChatTarget>, String> {
        self.inner.database.targets()
    }

    pub fn messages(
        &self,
        target: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        self.inner
            .database
            .messages(&normalize_target(target)?, before, limit)
    }

    pub fn messages_around(
        &self,
        target: &str,
        message_id: &str,
        radius: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        self.inner.database.messages_around(
            &normalize_target(target)?,
            &validate_message_id(message_id)?,
            radius,
        )
    }

    pub fn members(&self, target: Option<&str>) -> Result<Vec<ChatMember>, String> {
        let normalized = target.map(normalize_target).transpose()?;
        self.inner.database.members(normalized.as_deref())
    }

    pub fn search(
        &self,
        query: &str,
        target: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, String> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let normalized = target.map(normalize_target).transpose()?;
        self.inner
            .database
            .search(query, normalized.as_deref(), limit)
    }

    pub fn send(
        &self,
        target: &str,
        text: &str,
        reply_to: Option<&str>,
        agent_label: Option<&str>,
        activity_id: Option<&str>,
    ) -> Result<(), String> {
        let target = normalize_target(target)?;
        let text = normalize_body(text)?;
        let reply_to = reply_to.map(validate_message_id).transpose()?;
        let config = self.config()?;
        let status = self.status();
        let lines = if let Some(agent_label) = agent_label {
            agent_lines(
                &config.account,
                &target,
                &text,
                reply_to.as_deref(),
                agent_label,
                activity_id,
                status.relay_ready,
            )
        } else {
            human_lines(&target, &text, reply_to.as_deref())
        };
        self.queue_lines(lines)
    }

    pub fn react(
        &self,
        target: &str,
        message_id: &str,
        reaction: &str,
        add: bool,
    ) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        let reaction = normalize_reaction(reaction)?;
        let action = if add {
            "+draft/react"
        } else {
            "+draft/unreact"
        };
        self.queue_lines(vec![format!(
            "@+reply={};{action}={} TAGMSG {target}",
            irc_tag_value(&message_id),
            irc_tag_value(&reaction),
        )])
    }

    pub fn typing(&self, target: &str, state: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let state = match state.trim().to_ascii_lowercase().as_str() {
            "active" => "active",
            "pause" => "pause",
            "done" => "done",
            _ => return Err("Typing state must be active, pause, or done.".into()),
        };
        self.queue_lines(vec![format!("@+typing={state} TAGMSG {target}")])
    }

    pub fn edit(&self, target: &str, message_id: &str, text: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        if !self.inner.database.own_message(&target, &message_id)? {
            return Err("Only your own, non-deleted messages can be edited.".into());
        }
        let text = normalize_body(text)?;
        if text.contains('\n') || text.len() > IRC_CHUNK_BYTES {
            return Err(
                "Edited messages must fit on one line. Send a new message for longer changes."
                    .into(),
            );
        }
        self.queue_lines(vec![format!(
            "@+abundanceds.com/edit={} PRIVMSG {target} :{text}",
            irc_tag_value(&message_id),
        )])
    }

    pub async fn delete(&self, target: &str, message_id: &str) -> Result<(), String> {
        let target = normalize_target(target)?;
        let message_id = validate_message_id(message_id)?;
        if !self.inner.database.own_message(&target, &message_id)? {
            return Err("Only your own, non-deleted messages can be deleted.".into());
        }
        let attachments = self
            .inner
            .database
            .message_attachments(&target, &message_id)?;
        // Redact first: if the connection is gone this fails before any blob
        // is destroyed, so the message never ends up visible with dead
        // attachment cards.
        self.queue_lines(vec![format!(
            "REDACT {target} {message_id} :deleted by author",
        )])?;
        if !attachments.is_empty() {
            let config = self.config()?;
            let password = load_credential(&self.inner.credential_path, &config)?
                .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
            for attachment in attachments {
                if let Err(error) =
                    delete_remote_attachment(&config, &password, &attachment.url).await
                {
                    log::warn!(
                        "Could not delete attachment {} after redaction: {error}",
                        attachment.name
                    );
                }
                if let Some(path) = attachment.local_path {
                    match fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            log::warn!("Could not remove cached chat attachment: {error}");
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
