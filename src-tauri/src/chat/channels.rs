use super::*;

impl ChatRuntime {
    pub fn create_channel(&self, name: &str, topic: Option<&str>) -> Result<String, String> {
        let channel = normalize_channel(name)?;
        let mut lines = vec![
            format!("JOIN {channel}"),
            format!("PRIVMSG ChanServ :REGISTER {channel}"),
        ];
        if let Some(topic) = topic.map(str::trim).filter(|topic| !topic.is_empty()) {
            lines.push(format!("TOPIC {channel} :{}", clean_irc_parameter(topic)));
        }
        self.queue_lines(lines)?;
        let now = timestamp();
        self.inner
            .database
            .ensure_target(&channel, ChatTargetKind::Channel, true, Some(&now))?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(channel)
    }

    pub fn set_topic(&self, target: &str, topic: &str) -> Result<(), String> {
        let channel = normalize_channel(target)?;
        let topic = clean_irc_parameter(topic);
        self.queue_lines(vec![format!("TOPIC {channel} :{topic}")])
    }

    pub fn join(&self, target: &str) -> Result<String, String> {
        let channel = normalize_channel(target)?;
        self.queue_lines(vec![format!("JOIN {channel}")])?;
        let now = timestamp();
        self.inner
            .database
            .ensure_target(&channel, ChatTargetKind::Channel, true, Some(&now))?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(channel)
    }

    pub fn leave(&self, target: &str) -> Result<(), String> {
        let channel = normalize_channel(target)?;
        self.queue_lines(vec![format!("PART {channel} :Left from Mimir")])?;
        self.inner.database.set_joined(&channel, false)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn open_direct(&self, account: &str) -> Result<String, String> {
        let target = normalize_nick(account)?;
        self.inner
            .database
            .ensure_target(&target, ChatTargetKind::Direct, false, None)?;
        self.inner.database.set_hidden(&target, false)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(target)
    }

    pub fn close_direct(&self, account: &str) -> Result<(), String> {
        let target = normalize_nick(account)?;
        self.inner.database.set_hidden(&target, true)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn mark_read(&self, target: &str, message_id: Option<&str>) -> Result<(), String> {
        let target = normalize_target(target)?;
        self.inner.database.mark_read(&target, message_id)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn set_muted(&self, target: &str, muted: bool) -> Result<(), String> {
        let target = normalize_target(target)?;
        self.inner.database.set_muted(&target, muted)?;
        self.emit(ChatEvent::TargetsChanged);
        Ok(())
    }

    pub fn set_active(&self, target: Option<&str>) -> Result<(), String> {
        let target = target.map(normalize_target).transpose()?;
        *write_lock(&self.inner.active_target) = target;
        Ok(())
    }

    pub fn link_activity(
        &self,
        activity_id: &str,
        target: &str,
        agent_label: Option<&str>,
    ) -> Result<(), String> {
        let activity_id = activity_id.trim();
        if activity_id.is_empty() {
            return Err("Activity ID is required.".into());
        }
        let target = normalize_target(target)?;
        self.inner
            .database
            .link_activity(activity_id, &target, agent_label)?;
        Ok(())
    }

    pub(super) fn connect(&self, config: ChatConfig, password: String) {
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(sender) = lock(&self.inner.outbound).take() {
            let _ = sender.send(ChatOutbound::Shutdown);
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        *lock(&self.inner.outbound) = Some(sender);
        self.update_status(ChatStatus::new(&config, ChatConnectionState::Connecting));
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            supervise_connection(inner, generation, config, password, receiver).await;
        });
    }

    pub(super) fn queue_lines(&self, lines: Vec<String>) -> Result<(), String> {
        if self.status().state != ChatConnectionState::Connected {
            return Err("Chat is reconnecting. Try again when the connection is back.".into());
        }
        let sender = lock(&self.inner.outbound)
            .as_ref()
            .cloned()
            .ok_or_else(|| "Chat is not connected.".to_string())?;
        sender
            .send(ChatOutbound::Lines(lines))
            .map_err(|_| "Chat connection is unavailable.".to_string())
    }

    pub(super) fn resolve_tool_target(
        &self,
        context: &ToolCallContext,
        requested: Option<&str>,
    ) -> Result<String, String> {
        // The Activity link is a default aim, not a fence: an explicit target
        // always wins, then the linked room, then the room open in the UI.
        if let Some(requested) = requested {
            return normalize_target(requested);
        }
        let activity_id = context.metadata.get("activityId").and_then(Value::as_str);
        let linked = activity_id
            .map(|activity_id| self.inner.database.activity_link(activity_id))
            .transpose()?
            .flatten();
        if let Some((linked_target, _)) = linked {
            return Ok(linked_target);
        }
        read_lock(&self.inner.active_target)
            .clone()
            .ok_or_else(|| "Pass target or launch the agent from a chat room.".to_string())
    }

    pub(super) fn resolve_agent_label(&self, context: &ToolCallContext) -> String {
        let activity_id = context.metadata.get("activityId").and_then(Value::as_str);
        if let Some(activity_id) = activity_id {
            if let Ok(Some((_, Some(label)))) = self.inner.database.activity_link(activity_id) {
                return label;
            }
        }
        context
            .metadata
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or("agent")
            .to_string()
    }

    pub(super) fn update_status(&self, status: ChatStatus) {
        if let Some(diagnostic) = status.diagnostic.as_deref() {
            log::warn!("Chat {:?}: {diagnostic}", status.state);
        } else {
            log::debug!("Chat state: {:?}", status.state);
        }
        *write_lock(&self.inner.status) = status.clone();
        self.emit(ChatEvent::Status { status });
    }

    pub(super) fn emit(&self, event: ChatEvent) {
        if let Some(app) = lock(&self.inner.app).clone() {
            let _ = app.emit(CHAT_EVENT, event);
        }
    }
}
